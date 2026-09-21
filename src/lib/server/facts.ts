/**
 * Commit facts: everything the Activity and Metrics pages need about one repository, in a form
 * that does not depend on a date range or on having a git clone.
 *
 * A collector (your Mac: it has the clone and the tokens) builds them from `git log` and GitHub;
 * they are published to the shared state (state.ts). Every page then computes its view from these
 * facts, whether it runs next to the clone or on a server that has never seen one. That single
 * path is what keeps a deployed copy showing the same numbers as your machine.
 */
import { authorArgs, git, hasMirror, mirrorAgeMs, syncMirror } from './mirror';
import { configuredEmails, graphql, identities, repoToken } from './github';
import { myEmails } from './authors';
import { isReadOnly, stateJson, stateText, updateState } from './state';

/** How much history is collected. Views can ask for any range inside it. */
export const LOOKBACK_DAYS = 400;
// Pull request data changes slowly and is the slow part to fetch, so a rebuild within this long of
// the last one reuses it (commits, which come from the local clone, are always rebuilt)
const PR_REUSE_MS = 5 * 60_000;

export interface FactCommit {
	sha: string;
	date: string; // author date, ISO with offset: which day the work belongs to
	cdate: string; // committer date, ISO: what git's --since/--until window applies to
	subject: string;
	author: string;
	email: string;
	src: string; // the branch `git log` reached it through: used for ticket keys
	branch?: string; // the branch it was most likely written on
	branches?: string[]; // long-lived branches (prod, stage, uat…) it has since landed on
	merge: boolean;
	files?: [path: string, additions: number, deletions: number][];
}

export interface FactPr {
	number: number;
	title: string;
	state: 'MERGED' | 'CLOSED' | 'OPEN';
	createdAt: string;
	branch: string;
	base: string;
}

type DayCounts = Record<string, number>; // 'YYYY-MM-DD' -> commits

export interface RepoFacts {
	version: 1;
	repo: string;
	collectedAt: string;
	since: string; // YYYY-MM-DD: the earliest day covered
	tz: string;
	defaultBranch: string;
	identities: string[]; // the accounts and extra emails counted as mine
	commits: FactCommit[]; // mine, newest first
	prs: FactPr[]; // mine
	daily: {
		allBranches: DayCounts; // everyone's non-merge commits, by committer day
		// The branches my pull requests merge into (and the default branch): everyone's commits and mine
		branches: Record<string, { all: DayCounts; mine: DayCounts }>;
		orgPrs: DayCounts; // every pull request created that day, by anyone (days with none are omitted)
		orgPrsThrough?: string; // the last UTC day already counted; earlier days are settled
	};
}

export const factsPath = (repo: string) => `facts/${repo.replace('/', '__')}.json`;

/** A repository's facts from the shared state, or null if none have been published. */
const latest = new Map<string, RepoFacts>(); // what this process collected most recently

/**
 * A repository's facts: the newer of what this machine just collected and what is published. A
 * deployed copy has nothing of its own, so it shows the published ones.
 */
export function getFacts(repo: string): RepoFacts | null {
	const published = stateJson<RepoFacts | null>(factsPath(repo), null);
	const mine = latest.get(repo);
	return mine && (!published || mine.collectedAt > published.collectedAt) ? mine : published;
}

// ---------------------------------------------------------------- helpers

const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "src/{old => new}/f.py" and "old.py => new.py" → the new path. */
const renamedPath = (p: string) =>
	p
		.replace(/\{[^{}]* => ([^{}]*)\}/, '$1')
		.replace(/^.* => /, '')
		.replace(/\/\//g, '/');

function tally(log: string): DayCounts {
	const days: DayCounts = {};
	for (const iso of log.split('\n').filter(Boolean)) {
		const day = localDay(iso);
		days[day] = (days[day] ?? 0) + 1;
	}
	return days;
}

// ---------------------------------------------------------------- branch labels

// A bare prod, stage, uat, staging, main… or one carrying a version (prod-v1.1.0, stage_2).
// Anything else with those words in it (master-agent-tags, prod/AA-780) is a feature branch named
// after where it is headed, and is not a release branch.
const RELEASE_BRANCH =
	/^(main|master|develop|staging|stage|uat|prod|production|release)([-_]?v?\d[\w.]*)?$/i;
const RELEASE_ORDER = ['prod', 'release', 'stage', 'uat', 'main', 'develop'];

const releaseRank = (name: string) => {
	const i = RELEASE_ORDER.findIndex((prefix) => name.toLowerCase().startsWith(prefix));
	return i === -1 ? RELEASE_ORDER.length : i;
};

const cutoff = (since: string) => `--since-as-filter=${since}T00:00:00`;

/** For each of my commits, the release branches that contain it (one `git log` per branch). */
async function releaseBranchesOf(repo: string, since: string, emails: string[]) {
	const names = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
		.split('\n')
		.filter((name) => RELEASE_BRANCH.test(name));

	const membership = new Map<string, string[]>();
	await Promise.all(
		names.map(async (branch) => {
			const shas = await git(repo, [
				'log',
				branch,
				cutoff(since),
				...authorArgs(emails),
				'--format=%H'
			]);
			for (const sha of shas.split('\n').filter(Boolean)) {
				membership.set(sha, [...(membership.get(sha) ?? []), branch]);
			}
		})
	);
	for (const [sha, branches] of membership) {
		membership.set(
			sha,
			branches.sort((a, b) => releaseRank(a) - releaseRank(b) || a.localeCompare(b))
		);
	}
	return membership;
}

/**
 * The branch a commit most plausibly belongs to. A commit is usually on several (the feature
 * branch it was written on, then each release branch it was merged into); `name-rev` picks the
 * nearest branch tip, which is normally the one the work was done on.
 */
async function nearestBranches(repo: string, shas: string[]) {
	const names: string[] = [];
	for (let i = 0; i < shas.length; i += 400) {
		const out = await git(repo, [
			'name-rev',
			'--name-only',
			'--refs=refs/heads/*',
			...shas.slice(i, i + 400)
		]);
		// One line per commit, in order: "prod-v1.1.0~3^2" or "undefined". Branch names cannot
		// contain ~ or ^, so what precedes them is the whole name.
		names.push(
			...out
				.trim()
				.split('\n')
				.map((line) => line.replace(/[~^].*$/, ''))
		);
	}
	return names.map((name) => (name === 'undefined' ? '' : name));
}

// ---------------------------------------------------------------- pull requests

interface SearchResult {
	search: {
		pageInfo: { hasNextPage: boolean; endCursor: string };
		nodes: {
			number: number;
			title: string;
			state: FactPr['state'];
			createdAt: string;
			headRefName: string;
			baseRefName: string;
		}[];
	};
}

const SEARCH_QUERY = `query($q: String!, $first: Int!, $after: String) {
	search(query: $q, type: ISSUE, first: $first, after: $after) {
		pageInfo { hasNextPage endCursor }
		nodes { ... on PullRequest { number title state createdAt headRefName baseRefName } }
	}
}`;

async function myPrs(repo: string, token: string, since: string): Promise<FactPr[]> {
	const prs = new Map<number, FactPr>();
	for (const me of await identities()) {
		let after: string | null = null;
		for (let page = 0; page < 10; page++) {
			// Search returns at most 1,000 results, so 10 pages of 100
			const data: SearchResult = await graphql<SearchResult>(token, SEARCH_QUERY, {
				q: `repo:${repo} is:pr author:${me.login} created:>=${since}`,
				first: 100,
				after
			});
			for (const n of data.search.nodes) {
				prs.set(n.number, {
					number: n.number,
					title: n.title,
					state: n.state,
					createdAt: n.createdAt,
					branch: n.headRefName,
					base: n.baseRefName
				});
			}
			if (!data.search.pageInfo.hasNextPage) break;
			after = data.search.pageInfo.endCursor;
		}
	}
	return [...prs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** How many pull requests anyone opened on each day: the denominator of "your share of the team". */
async function orgPrCounts(
	repo: string,
	token: string,
	since: string,
	previous: RepoFacts['daily'] | undefined
): Promise<{ counts: DayCounts; through: string }> {
	// GitHub's created: qualifier works in UTC days
	const days: string[] = [];
	const last = new Date().toISOString().slice(0, 10);
	for (let day = since; day <= last; ) {
		days.push(day);
		day = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
	}

	// A past day's count never changes, so only days after the last counted one (less the last few,
	// which can still be moving) are asked about. Days with no PRs are not stored, which is why
	// "already counted" has to be remembered as a date rather than by the day being present.
	const settledThrough = previous?.orgPrsThrough
		? (days[Math.max(0, days.indexOf(previous.orgPrsThrough) - 3)] ?? since)
		: '';
	const todo = days.filter((day) => !previous?.orgPrsThrough || day > settledThrough);
	const counts: DayCounts = {};
	for (const [day, n] of Object.entries(previous?.orgPrs ?? {})) {
		if (day >= since && day <= settledThrough) counts[day] = n;
	}

	for (let i = 0; i < todo.length; i += 40) {
		const batch = todo.slice(i, i + 40);
		const query = `query { ${batch
			.map(
				(day, k) =>
					`d${k}: search(query: "repo:${repo} is:pr created:${day}", type: ISSUE, first: 0) { issueCount }`
			)
			.join('\n')} }`;
		const data = await graphql<Record<string, { issueCount: number }>>(token, query, {});
		batch.forEach((day, k) => {
			if (data[`d${k}`].issueCount) counts[day] = data[`d${k}`].issueCount;
		});
	}
	return { counts, through: last };
}

// ---------------------------------------------------------------- the collector

/** Build a repository's facts from its local clone and GitHub. Needs the clone and a token. */
export async function collectFacts(repo: string): Promise<RepoFacts> {
	if (!hasMirror(repo)) throw new Error(`${repo} has no local clone yet`);
	const token = await repoToken(repo);
	if (!token) throw new Error(`no configured GitHub token can read ${repo}`);

	const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toLocaleDateString('en-CA');
	const emails = await myEmails(repo);
	const mine = authorArgs(emails);
	const previous = getFacts(repo);

	const reuse =
		previous && Date.now() - Date.parse(previous.collectedAt) < PR_REUSE_MS ? previous : null;
	const [prs, log, allLog, head] = await Promise.all([
		reuse ? Promise.resolve(reuse.prs) : myPrs(repo, token, since),
		emails.length
			? git(repo, [
					'-c',
					'core.quotePath=false',
					'log',
					'--branches',
					'--source',
					cutoff(since),
					...mine,
					'--format=%x1e%H%x1f%aI%x1f%cI%x1f%S%x1f%an%x1f%ae%x1f%P%x1f%s',
					'--numstat'
				])
			: '',
		git(repo, ['log', '--branches', '--no-merges', cutoff(since), '--format=%cI']),
		git(repo, ['symbolic-ref', '--short', 'HEAD'])
	]);
	const defaultBranch = head.trim();

	const rows = log
		.split('\x1e')
		.slice(1)
		.map((block) => {
			const [line, ...stats] = block.split('\n');
			const [sha, date, cdate, src, author, email, parents, subject] = line.split('\x1f');
			const files = stats.filter(Boolean).map((s) => {
				const [add, del, ...p] = s.split('\t');
				return [
					renamedPath(p.join('\t')),
					add === '-' ? 0 : Number(add),
					del === '-' ? 0 : Number(del)
				] as [string, number, number];
			});
			return {
				sha,
				date,
				cdate,
				src,
				author,
				email,
				merge: parents.trim().includes(' '),
				subject,
				files
			};
		});

	const [nearest, release] = await Promise.all([
		nearestBranches(
			repo,
			rows.map((r) => r.sha)
		),
		releaseBranchesOf(repo, since, emails)
	]);

	const commits: FactCommit[] = rows
		.map((r, i) => ({
			sha: r.sha,
			date: r.date,
			cdate: r.cdate,
			subject: r.subject,
			author: r.author,
			email: r.email,
			src: r.src.replace(/^refs\/heads\//, ''),
			branch: nearest[i] || undefined,
			branches: release.get(r.sha) ?? [],
			merge: r.merge,
			files: r.merge ? undefined : r.files
		}))
		.sort((a, b) => b.date.localeCompare(a.date));

	// Daily totals for the branches a metrics view may treat as "the mainline": whatever my pull
	// requests merge into, plus the default branch
	const bases = new Set([defaultBranch, ...prs.map((p) => p.base)]);
	const branches: RepoFacts['daily']['branches'] = {};
	await Promise.all(
		[...bases].map(async (base) => {
			const exists = await git(repo, [
				'rev-parse',
				'--verify',
				'--quiet',
				`refs/heads/${base}`
			]).then(
				() => true,
				() => false
			);
			if (!exists) return;
			const ref = `refs/heads/${base}`;
			const [all, theirs] = await Promise.all([
				git(repo, ['log', ref, '--no-merges', cutoff(since), '--format=%cI']),
				emails.length
					? git(repo, ['log', ref, '--no-merges', cutoff(since), ...mine, '--format=%cI'])
					: ''
			]);
			branches[base] = { all: tally(all), mine: tally(theirs) };
		})
	);

	// The team's PR counts only matter next to mine, and cost a search per day the first time
	const org = !prs.length
		? { counts: {}, through: '' }
		: reuse
			? { counts: reuse.daily.orgPrs, through: reuse.daily.orgPrsThrough ?? '' }
			: await orgPrCounts(repo, token, since, previous?.daily);

	return {
		version: 1,
		repo,
		collectedAt: new Date().toISOString(),
		since,
		tz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
		defaultBranch,
		identities: [...(await identities()).map((i) => i.login), ...configuredEmails()],
		commits,
		prs,
		daily: {
			allBranches: tally(allLog),
			branches,
			orgPrs: org.counts,
			orgPrsThrough: org.through || undefined
		}
	};
}

// ---------------------------------------------------------------- keeping facts fresh (full mode)

const FRESH_MS = 60_000; // facts (and the clone) older than this are rebuilt before being read
const WAIT_MS = 15_000; // …but a page never waits longer than this for that
const HEARTBEAT_MS = 6 * 3_600_000; // unchanged facts are re-stamped this often, so readers see life
const TEAM_COUNTS_MS = 30 * 60_000; // team-wide daily totals move whenever anyone commits: publish rarely

const collecting = new Map<string, Promise<void>>();
const lastChecked = new Map<string, number>();

const stable = (facts: RepoFacts) => JSON.stringify({ ...facts, collectedAt: '' });

/** Rebuild one repository's facts and publish them if anything changed. */
export function refreshFacts(repo: string): Promise<void> {
	const running = collecting.get(repo);
	if (running) return running;

	const job = (async () => {
		if (!hasMirror(repo)) {
			void syncMirror(repo); // first clone runs in the background; the page says facts are pending
			return;
		}
		const age = mirrorAgeMs(repo);
		if (age === null || age > FRESH_MS) await syncMirror(repo);

		const facts = await collectFacts(repo);
		lastChecked.set(repo, Date.now());
		latest.set(repo, facts); // shown at once, even if publishing below fails

		await updateState((files): Record<string, string | null> => {
			const old = files[factsPath(repo)] ? (JSON.parse(files[factsPath(repo)]) as RepoFacts) : null;
			const age = old ? Date.now() - Date.parse(old.collectedAt) : Infinity;
			if (old && stable(old) === stable(facts) && age < HEARTBEAT_MS) return {};
			// My own commits and PRs are published straight away; when only the team-wide totals
			// moved, wait: they change every few minutes and each publish is a commit
			const mineSame =
				old &&
				JSON.stringify([old.commits, old.prs]) === JSON.stringify([facts.commits, facts.prs]);
			if (mineSame && age < TEAM_COUNTS_MS) return {};

			const known = new Set(
				Object.keys(files)
					.filter((f) => f.startsWith('facts/'))
					.map((f) => f.slice(6, -5).replace('__', '/'))
			);
			known.add(repo);
			return {
				[factsPath(repo)]: stateText(facts),
				'manifest.json': stateText(
					{ version: 1, updatedAt: facts.collectedAt, tz: facts.tz, repos: [...known].sort() },
					true
				)
			};
		}, `Update facts: ${repo}`);
	})()
		.catch((e) => console.error(`Collecting facts for ${repo} failed:`, e))
		.finally(() => collecting.delete(repo));

	collecting.set(repo, job);
	return job;
}

/**
 * Make sure a repository's facts are recent enough to show. In full mode a stale set is rebuilt
 * (the page waits a moment for it, never longer than WAIT_MS); in read mode the published facts are
 * all there is.
 */
export async function ensureFacts(repo: string, { force = false } = {}) {
	if (isReadOnly()) return;
	const recent = Date.now() - (lastChecked.get(repo) ?? 0) < FRESH_MS;
	if (recent && !force) return;
	await Promise.race([refreshFacts(repo), sleep(WAIT_MS)]);
}
