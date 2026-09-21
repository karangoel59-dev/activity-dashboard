/**
 * Engineering metrics for a date window across tracked repos, computed from the commit facts
 * (facts.ts): commits with their files, pull requests, and daily totals. The same code runs on the
 * machine that collects the facts and on a deployed copy that only reads them, so both show the
 * same numbers for any range inside the collected history.
 */
import path from 'path';
import { env } from '$env/dynamic/private';
import { ensureFacts, getFacts, type RepoFacts } from './facts';
import { classify, WORK_TYPES, type WorkItem } from './classify';
import { hasMirror, mirrorStatus, type MirrorStatus } from './mirror';
import { getRepos } from './repos';
import { isReadOnly } from './state';

export interface DateWindow {
	from: string; // YYYY-MM-DD, inclusive
	to: string; // YYYY-MM-DD, inclusive
}

interface FileChange {
	path: string;
	additions: number;
	deletions: number;
}

interface GitCommit {
	sha: string;
	repo: string;
	date: string;
	subject: string;
	branch: string;
	files: FileChange[];
}

interface PullRequest {
	repo: string;
	number: number;
	title: string;
	state: 'MERGED' | 'CLOSED' | 'OPEN';
	createdAt: string;
	branch: string;
	base: string;
}

export interface ChurnRow {
	ext: string;
	code: boolean; // false for data, generated and binary-ish files
	additions: number;
	deletions: number;
	changes: number; // file-change events
}

export interface RepoMetrics {
	repo: string;
	mirror: MirrorStatus;
	prs: { authored: number; merged: number; closed: number; open: number; orgTotal: number } | null;
	commits: {
		mine: number;
		mergesMine: number;
		mainline: string;
		mainlineMine: number;
		mainlineTotal: number;
		allBranchTotal: number;
	} | null;
	churn: ChurnRow[];
	topFiles: { path: string; edits: number }[];
	errors: string[];
	notes: string[]; // not problems: e.g. the history only goes back so far
}

export interface Metrics {
	window: DateWindow;
	repos: RepoMetrics[];
	totals: {
		prs: { authored: number; merged: number; closed: number; open: number };
		commits: number;
		additions: number;
		deletions: number;
		fileChanges: number;
		firstCommit: { sha: string; date: string; repo: string } | null;
		lastCommit: { sha: string; date: string; repo: string } | null;
	};
	cadence: {
		spanDays: number;
		activeDays: number;
		activeWeeks: number;
		longestWeekStreak: number;
		commitsPerActiveDay: number;
		commitsPerWeek: number;
		prsPerActiveDay: number;
		prsPerWeek: number;
	};
	months: { month: string; commits: number; prs: number }[];
	jira: { total: number; projects: { project: string; count: number }[] };
	identities: string[];
}

export interface Insights {
	domains: { name: string; description: string; commits: number; prs: number }[];
	types: { name: string; commits: number }[];
	monthFocus: Record<string, string[]>;
	classified: number;
	total: number;
}

interface Computed {
	metrics: Metrics;
	commits: GitCommit[];
	prs: PullRequest[];
}

// ---------------------------------------------------------------- dates

const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA');

function daysBetween(from: string, to: string) {
	return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

/** Monday of the week containing `d` (YYYY-MM-DD). */
function weekOf(d: string) {
	const date = new Date(d + 'T12:00:00');
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return date.toLocaleDateString('en-CA');
}

function longestStreak(weeks: string[]) {
	let best = 0;
	let run = 0;
	let prev = 0;
	for (const w of [...weeks].sort()) {
		const t = Date.parse(w);
		run = prev && Math.round((t - prev) / 86_400_000) === 7 ? run + 1 : 1;
		best = Math.max(best, run);
		prev = t;
	}
	return best;
}

function monthsIn({ from, to }: DateWindow) {
	const months: string[] = [];
	const d = new Date(from.slice(0, 7) + '-01T12:00:00');
	while (d.toLocaleDateString('en-CA').slice(0, 7) <= to.slice(0, 7)) {
		months.push(d.toLocaleDateString('en-CA').slice(0, 7));
		d.setMonth(d.getMonth() + 1);
	}
	return months;
}

// Source and config types counted as code; data files (.csv, .pickle, stopword lists, …) can add
// millions of "lines" and would swamp the totals
const CODE_TYPES = new Set(
	(
		'.py .js .mjs .cjs .ts .tsx .jsx .svelte .vue .go .rs .java .kt .rb .php .cs .c .h .cpp .hpp ' +
		'.swift .scala .sql .sh .ps1 .html .css .scss .yaml .yml .toml .ini .cfg Dockerfile'
	).split(' ')
);

// Test, generated and non-code files would drown out the files that carry the real work
const NOT_PRODUCTION =
	/(^|\/)(tests?|__tests__|migrations|fixtures|docs?)\/|(^|\/)test_|_test\.|\.(test|spec)\.|\.(lock|md|txt|ipynb|svg|png|jpe?g|csv)$|package-lock\.json$/i;

function churnOf(commits: GitCommit[]): ChurnRow[] {
	const byExt = new Map<string, ChurnRow>();
	for (const f of commits.flatMap((c) => c.files)) {
		const ext = path.extname(f.path).toLowerCase() || path.basename(f.path);
		const row = byExt.get(ext) || {
			ext,
			code: CODE_TYPES.has(ext),
			additions: 0,
			deletions: 0,
			changes: 0
		};
		row.additions += f.additions;
		row.deletions += f.deletions;
		row.changes++;
		byExt.set(ext, row);
	}
	return [...byExt.values()].sort(
		(a, b) => b.additions + b.deletions - (a.additions + a.deletions)
	);
}

function topFilesOf(commits: GitCommit[], limit = 15) {
	const edits = new Map<string, number>();
	for (const f of commits.flatMap((c) => c.files)) {
		if (!NOT_PRODUCTION.test(f.path)) edits.set(f.path, (edits.get(f.path) || 0) + 1);
	}
	return [...edits.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([path, edits]) => ({ path, edits }));
}

// ---------------------------------------------------------------- jira

// Uppercase tokens that look like ticket keys but are not (UTF-8, GPT-4, …)
const NOT_JIRA = new Set([
	'UTF',
	'GPT',
	'SHA',
	'ISO',
	'HTTP',
	'TLS',
	'SSL',
	'CVE',
	'RFC',
	'PR',
	'V',
	'REVERT'
]);

function jiraTickets(texts: string[]) {
	const configured = (env.JIRA_PROJECTS || '')
		.split(',')
		.map((p) => p.trim().toUpperCase())
		.filter(Boolean);
	const keys = new Set<string>();
	for (const text of texts) {
		for (const m of text.toUpperCase().matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)) {
			if (configured.length ? configured.includes(m[1]) : !NOT_JIRA.has(m[1])) keys.add(m[0]);
		}
	}

	const byProject = new Map<string, number>();
	for (const key of keys) {
		const project = key.split('-')[0];
		byProject.set(project, (byProject.get(project) || 0) + 1);
	}
	// Without a configured list, a prefix seen only once or twice is more likely noise than a project
	const projects = [...byProject.entries()]
		.filter(([, count]) => configured.length || count >= 3)
		.sort((a, b) => b[1] - a[1])
		.map(([project, count]) => ({ project, count }));
	return { total: projects.reduce((n, p) => n + p.count, 0), projects };
}

// ---------------------------------------------------------------- from the facts

// Git's date window applies to the committer date, and GitHub's created: qualifier to UTC days
const inWindow = (d: string, w: DateWindow) => d >= w.from && d <= w.to;
const utcDay = (iso: string) => iso.slice(0, 10);

function sumDays(counts: Record<string, number> | undefined, w: DateWindow) {
	let total = 0;
	for (const [d, n] of Object.entries(counts ?? {})) if (inWindow(d, w)) total += n;
	return total;
}

/**
 * The branch work actually lands on. Team repos often integrate into a release/stage branch while
 * the default branch sits idle, so use the base most of my PRs targeted, if it was collected.
 */
function mainlineOf(facts: RepoFacts, prs: PullRequest[]) {
	const counts = new Map<string, number>();
	for (const p of prs) counts.set(p.base, (counts.get(p.base) || 0) + 1);
	for (const [base] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
		if (facts.daily.branches[base]) return base;
	}
	return facts.defaultBranch;
}

/** Where a repository's numbers come from, in the shape the page already shows. */
export function sourceStatus(repo: string, facts: RepoFacts | null): MirrorStatus {
	if (!isReadOnly()) {
		const live = mirrorStatus(repo);
		if (live.state === 'syncing' || live.state === 'error') return live;
	}
	return facts ? { state: 'ready', syncedAt: Date.parse(facts.collectedAt) } : { state: 'missing' };
}

function repoView(repo: string, window: DateWindow) {
	const facts = getFacts(repo);
	const errors: string[] = [];
	const notes: string[] = [];
	const status = sourceStatus(repo, facts);
	if (status.state === 'error') errors.push(`Sync failed: ${status.error}`);

	if (!facts) {
		notes.push(
			isReadOnly()
				? 'No published data yet. Open the dashboard on the machine that has this clone to publish it.'
				: hasMirror(repo)
					? 'Processing this repository for the first time. Reload in a minute.'
					: 'Copying this repository to this machine for the first time.'
		);
		const row: RepoMetrics = {
			repo,
			mirror: status,
			prs: null,
			commits: null,
			churn: [],
			topFiles: [],
			errors,
			notes
		};
		return { row, commits: [] as GitCommit[], prs: [] as PullRequest[], facts };
	}

	if (facts.since > window.from) {
		notes.push(
			`History is collected from ${facts.since}, so earlier days in this range are not counted.`
		);
	}

	const inRange = facts.commits.filter((c) => inWindow(day(c.cdate), window));
	const nonMerge = inRange.filter((c) => !c.merge);
	const commits: GitCommit[] = nonMerge.map((c) => ({
		sha: c.sha,
		repo,
		date: c.date,
		subject: c.subject,
		branch: c.src,
		files: (c.files ?? []).map(([path, additions, deletions]) => ({ path, additions, deletions }))
	}));
	const prs: PullRequest[] = facts.prs
		.filter((p) => inWindow(utcDay(p.createdAt), window))
		.map((p) => ({ repo, ...p }));

	const mainline = mainlineOf(facts, prs);
	const branch = facts.daily.branches[mainline];
	const row: RepoMetrics = {
		repo,
		mirror: status,
		prs: {
			authored: prs.length,
			merged: prs.filter((p) => p.state === 'MERGED').length,
			closed: prs.filter((p) => p.state === 'CLOSED').length,
			open: prs.filter((p) => p.state === 'OPEN').length,
			orgTotal: sumDays(facts.daily.orgPrs, window)
		},
		commits: {
			mine: commits.length,
			mergesMine: inRange.length - nonMerge.length,
			mainline,
			mainlineMine: sumDays(branch?.mine, window),
			mainlineTotal: sumDays(branch?.all, window),
			allBranchTotal: sumDays(facts.daily.allBranches, window)
		},
		churn: churnOf(commits),
		topFiles: topFilesOf(commits),
		errors,
		notes
	};
	return { row, commits, prs, facts };
}

// ---------------------------------------------------------------- assembly

/**
 * Metrics for a window. In full mode the facts of each repository are refreshed first (a page waits
 * a moment for that at most); a deployed copy computes from what was published.
 */
export async function computeMetrics(
	window: DateWindow,
	{ fresh = false } = {}
): Promise<Computed> {
	const repos = getRepos();
	await Promise.all(repos.map((repo) => ensureFacts(repo, { force: fresh })));

	const perRepo = repos.map((repo) => repoView(repo, window));
	const commits = perRepo.flatMap((r) => r.commits).sort((a, b) => a.date.localeCompare(b.date));
	const prs = perRepo.flatMap((r) => r.prs);
	const churn = churnOf(commits).filter((r) => r.code);

	const activeDays = new Set([
		...commits.map((c) => day(c.date)),
		...prs.map((p) => day(p.createdAt))
	]);
	const weeks = [...new Set([...activeDays].map(weekOf))];
	const spanDays = daysBetween(window.from, window.to);
	const calendarWeeks = spanDays / 7;
	const round = (n: number) => Math.round(n * 10) / 10;
	const edge = (c?: GitCommit) => (c ? { sha: c.sha, date: c.date, repo: c.repo } : null);

	const metrics: Metrics = {
		window,
		repos: perRepo.map((r) => r.row),
		totals: {
			prs: {
				authored: prs.length,
				merged: prs.filter((p) => p.state === 'MERGED').length,
				closed: prs.filter((p) => p.state === 'CLOSED').length,
				open: prs.filter((p) => p.state === 'OPEN').length
			},
			commits: commits.length,
			additions: churn.reduce((n, r) => n + r.additions, 0),
			deletions: churn.reduce((n, r) => n + r.deletions, 0),
			fileChanges: churn.reduce((n, r) => n + r.changes, 0),
			firstCommit: edge(commits[0]),
			lastCommit: edge(commits.at(-1))
		},
		cadence: {
			spanDays,
			activeDays: activeDays.size,
			activeWeeks: weeks.length,
			longestWeekStreak: longestStreak(weeks),
			commitsPerActiveDay: round(commits.length / (activeDays.size || 1)),
			commitsPerWeek: round(commits.length / calendarWeeks),
			prsPerActiveDay: round(prs.length / (activeDays.size || 1)),
			prsPerWeek: round(prs.length / calendarWeeks)
		},
		months: monthsIn(window).map((month) => ({
			month,
			commits: commits.filter((c) => day(c.date).startsWith(month)).length,
			prs: prs.filter((p) => day(p.createdAt).startsWith(month)).length
		})),
		jira: jiraTickets([
			...prs.flatMap((p) => [p.title, p.branch]),
			...commits.flatMap((c) => [c.subject, c.branch])
		]),
		identities: [...new Set(perRepo.flatMap((r) => r.facts?.identities ?? []))]
	};

	return { metrics, commits, prs };
}

/** LLM domain and work-type breakdown of the same commits and PRs. */
export async function computeInsights({ commits, prs }: Computed): Promise<Insights> {
	const topFiles = (c: GitCommit) =>
		[...c.files]
			.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
			.slice(0, 3)
			.map((f) => f.path)
			.join(', ');
	const items: (WorkItem & { month: string; kind: 'commit' | 'pr' })[] = [
		...commits.map((c) => ({
			id: c.sha,
			text: `commit: ${c.subject} [branch ${c.branch}] files: ${topFiles(c)}`,
			month: day(c.date).slice(0, 7),
			kind: 'commit' as const
		})),
		...prs.map((p) => ({
			id: `${p.repo}#${p.number}`,
			text: `PR: ${p.title} [branch ${p.branch}]`,
			month: day(p.createdAt).slice(0, 7),
			kind: 'pr' as const
		}))
	];
	if (!items.length) return { domains: [], types: [], monthFocus: {}, classified: 0, total: 0 };

	const { domains, results } = await classify(items);

	const domainRows = new Map(
		[...domains, { name: 'Other', description: 'Did not fit a domain' }].map((d) => [
			d.name,
			{ ...d, commits: 0, prs: 0 }
		])
	);
	const typeRows = new Map(
		[...WORK_TYPES, { name: 'Other' }].map((t) => [t.name, { name: t.name, commits: 0 }])
	);
	const monthDomains = new Map<string, Map<string, number>>();

	for (const item of items) {
		const c = results[item.id];
		if (!c) continue;
		const domain = domainRows.get(c.domain);
		if (domain) domain[item.kind === 'commit' ? 'commits' : 'prs']++;
		if (item.kind === 'commit') {
			const type = typeRows.get(c.type);
			if (type) type.commits++;
		}
		const counts = monthDomains.get(item.month) || new Map<string, number>();
		counts.set(c.domain, (counts.get(c.domain) || 0) + 1);
		monthDomains.set(item.month, counts);
	}

	return {
		domains: [...domainRows.values()]
			.filter((d) => d.commits || d.prs)
			.sort((a, b) => b.commits + b.prs - (a.commits + a.prs)),
		types: [...typeRows.values()].filter((t) => t.commits).sort((a, b) => b.commits - a.commits),
		monthFocus: Object.fromEntries(
			[...monthDomains.entries()].map(([month, counts]) => [
				month,
				[...counts.entries()]
					.filter(([name]) => name !== 'Other')
					.sort((a, b) => b[1] - a[1])
					.slice(0, 2)
					.map(([name]) => name)
			])
		),
		classified: Object.keys(results).length,
		total: items.length
	};
}
