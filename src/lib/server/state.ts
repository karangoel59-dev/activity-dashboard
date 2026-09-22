/**
 * Shared state: the one place the dashboard keeps what it has computed and what you have chosen.
 *
 * Your Mac (which has the git clones) computes commit facts and publishes them here; a deployed
 * copy (Railway) only reads them. Both see the same state, and both can update the small parts
 * they own (repo selection, AI summaries).
 *
 * Storage is a private GitHub repository (STATE_REPO), one JSON file per concern:
 *
 *   manifest.json            what the state holds and when it was last confirmed
 *   settings.json            which repositories are switched off
 *   discovered.json          the repositories found for the configured accounts
 *   facts/<owner>__<repo>.json   one repository's commits, PRs and daily totals
 *   insights.json            LLM domain/work-type classifications
 *   summaries.json           LLM day summaries
 *
 * Without STATE_REPO the same files live in data/state/, so a plain local run works unchanged.
 *
 * The whole repository is read in one request and cached by its latest commit id. Writes are one
 * atomic commit that names the commit it was based on, so an update made elsewhere in the
 * meantime is noticed and merged rather than overwritten.
 */
import fs from 'fs';
import path from 'path';
import { env } from '$env/dynamic/private';
import { fetchRetry, graphql, repoToken } from './github';

export type StateFiles = Record<string, string>; // path -> file text

/** `read`: a deployed copy that shows the state and never touches clones, git or the LLM. */
export const dashboardMode = (): 'full' | 'read' =>
	env.DASHBOARD_MODE === 'read' ? 'read' : 'full';
export const isReadOnly = () => dashboardMode() === 'read';

/** The repository holding the shared state, e.g. karangoel59-dev/dashboard-state (empty: local files). */
export const stateRepo = () =>
	(env.STATE_REPO || '')
		.trim()
		.replace(/^https:\/\/github\.com\//, '')
		.replace(/\.git$/, '');

const LOCAL_DIR = 'data/state';
const CACHE_FILE = 'data/state-cache.json'; // last snapshot fetched from GitHub: offline and fast start
const CHECK_EVERY = 15_000; // how often the latest commit is looked at

interface Snapshot {
	backend: 'github' | 'local';
	oid: string | null;
	branch: string;
	committedAt: string | null;
	files: StateFiles;
	checkedAt: number;
	stale?: string; // set when GitHub could not be reached and older data is being shown
}

let snapshot: Snapshot | null = null;
let refreshing: Promise<void> | null = null;

// ---------------------------------------------------------------- reading from GitHub

const HEAD_QUERY = `query($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		defaultBranchRef { name target { ... on Commit { oid committedDate } } }
	}
}`;

// The whole repository, two levels deep (the root files and facts/), in a single request
const TREE_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
	repository(owner: $owner, name: $name) {
		object(oid: $oid) {
			... on Commit {
				tree {
					entries {
						name type
						object {
							... on Blob { text isTruncated }
							... on Tree { entries { name type object { ... on Blob { text isTruncated } } } }
						}
					}
				}
			}
		}
	}
}`;

interface HeadResult {
	repository: {
		defaultBranchRef: { name: string; target: { oid: string; committedDate: string } } | null;
	} | null;
}

type Blob = { text?: string | null; isTruncated?: boolean } | null;
interface TreeResult {
	repository: {
		object: {
			tree: {
				entries: {
					name: string;
					type: string;
					object: (Blob & { entries?: { name: string; type: string; object: Blob }[] }) | null;
				}[];
			};
		} | null;
	} | null;
}

/** A file GitHub truncated in the tree query (over ~0.5 MB) is fetched whole instead. */
async function fetchRaw(repo: string, token: string, file: string): Promise<string> {
	const res = await fetchRetry(`https://api.github.com/repos/${repo}/contents/${file}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github.raw+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	});
	if (!res.ok) throw new Error(`could not read ${file} (GitHub ${res.status})`);
	return res.text();
}

async function readGitHub(repo: string, previous: Snapshot | null): Promise<Snapshot> {
	const token = await repoToken(repo);
	if (!token) throw new Error(`no configured GitHub token can read ${repo}`);
	const [owner, name] = repo.split('/');

	const head = (await graphql<HeadResult>(token, HEAD_QUERY, { owner, name })).repository
		?.defaultBranchRef;
	if (!head) throw new Error(`${repo} has no commits yet`);
	const { oid, committedDate } = head.target;

	if (previous?.backend === 'github' && previous.oid === oid) {
		return { ...previous, checkedAt: Date.now(), stale: undefined };
	}

	const tree = (await graphql<TreeResult>(token, TREE_QUERY, { owner, name, oid })).repository
		?.object?.tree;
	if (!tree) throw new Error(`could not read the files of ${repo}`);

	const files: StateFiles = {};
	const take = async (file: string, blob: Blob) => {
		if (blob?.isTruncated) files[file] = await fetchRaw(repo, token, file);
		else if (typeof blob?.text === 'string') files[file] = blob.text;
	};
	for (const entry of tree.entries) {
		if (entry.type === 'blob') await take(entry.name, entry.object);
		else if (entry.type === 'tree') {
			for (const child of entry.object?.entries ?? []) {
				if (child.type === 'blob') await take(`${entry.name}/${child.name}`, child.object);
			}
		}
	}
	return {
		backend: 'github',
		oid,
		branch: head.name,
		committedAt: committedDate,
		files,
		checkedAt: Date.now()
	};
}

// ---------------------------------------------------------------- reading from disk

function walk(dir: string, prefix = ''): StateFiles {
	const out: StateFiles = {};
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) Object.assign(out, walk(path.join(dir, entry.name), rel));
		else out[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
	}
	return out;
}

const readLocal = (): Snapshot => ({
	backend: 'local',
	oid: null,
	branch: 'main',
	committedAt: null,
	files: walk(LOCAL_DIR),
	checkedAt: Date.now()
});

function readCache(): Snapshot | null {
	try {
		return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Snapshot;
	} catch {
		return null;
	}
}

function writeCache(snap: Snapshot) {
	try {
		fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
		fs.writeFileSync(CACHE_FILE, JSON.stringify(snap));
	} catch {
		// the cache is only an optimisation
	}
}

// ---------------------------------------------------------------- refresh

async function load(force: boolean) {
	const repo = stateRepo();
	if (!repo) {
		// Local files are cheap to read and edited by this process only, so always re-read
		snapshot = readLocal();
		return;
	}

	if (!snapshot) snapshot = readCache(); // start instantly from the last copy, then revalidate
	if (!force && snapshot && Date.now() - snapshot.checkedAt < CHECK_EVERY) return;

	try {
		const next = await readGitHub(repo, snapshot);
		if (next.oid !== snapshot?.oid || !snapshot) writeCache(next);
		snapshot = next;
	} catch (e) {
		console.error(`Reading state from ${repo} failed:`, e);
		// Keep serving what we have, and say so
		snapshot = snapshot
			? { ...snapshot, checkedAt: Date.now(), stale: (e as Error).message }
			: { ...readLocal(), stale: (e as Error).message };
	}
}

/** Make sure the state is loaded and recent. Cheap when it was checked in the last few seconds. */
export function refreshState({ force = false } = {}): Promise<void> {
	return (refreshing ??= load(force).finally(() => {
		refreshing = null;
	}));
}

// ---------------------------------------------------------------- reading (after refreshState)

// Changes made optimistically that are still being committed to GitHub. Reads see them straight
// away; each entry is dropped when the commit that carries it has landed (or failed).
const overlay = new Map<string, { text: string | null; seq: number }>();
let seq = 0;

const view = (file: string): string | undefined =>
	overlay.has(file) ? (overlay.get(file)!.text ?? undefined) : snapshot?.files[file];

/** The published files with any changes still being saved applied on top. */
function merged(): StateFiles {
	const files = { ...(snapshot?.files ?? {}) };
	for (const [file, { text }] of overlay) {
		if (text === null) delete files[file];
		else files[file] = text;
	}
	return files;
}

const parsed = new Map<string, { text: string; value: unknown }>();

/** A JSON file from the state, or `fallback` when it does not exist. Parsed once per version. */
export function stateJson<T>(file: string, fallback: T): T {
	const text = view(file);
	if (text === undefined) return fallback;
	const hit = parsed.get(file);
	if (hit?.text === text) return hit.value as T;
	try {
		const value = JSON.parse(text) as T;
		parsed.set(file, { text, value });
		return value;
	} catch {
		return fallback;
	}
}

/** A file's raw text from the state, or undefined if it does not exist. */
export const stateRaw = (file: string): string | undefined => view(file);

export const stateFiles = (prefix: string) =>
	Object.keys(merged()).filter((file) => file.startsWith(prefix));

export interface StateInfo {
	backend: 'github' | 'local';
	repo: string;
	commit: string | null;
	committedAt: string | null;
	stale?: string;
}

export const stateInfo = (): StateInfo => ({
	backend: snapshot?.backend ?? 'local',
	repo: stateRepo(),
	commit: snapshot?.oid?.slice(0, 7) ?? null,
	committedAt: snapshot?.committedAt ?? null,
	stale: snapshot?.stale
});

// ---------------------------------------------------------------- writing

const json = (value: unknown, pretty = false) =>
	pretty ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value);
export { json as stateText };

/** File path to its new text, or null to delete it. Leaving a path out (or undefined) leaves it alone. */
export type Changes = Record<string, string | null | undefined>;

let writing: Promise<unknown> = Promise.resolve();

const CREATE_COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
	createCommitOnBranch(input: $input) { commit { oid committedDate } }
}`;

interface CommitResult {
	createCommitOnBranch: { commit: { oid: string; committedDate: string } };
}

const isConflict = (e: unknown) => /expected|stale|did not match|not up to date/i.test(String(e));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Change files in the state. `change` receives the current files and returns only what should
 * differ (a path to its new text, or null to delete it). If the state moved on since it was read
 * (another machine published), the change is computed again on the newer state and retried, so
 * two writers never overwrite each other. Nothing is written when nothing changed.
 *
 * Every attempt re-reads the state and recomputes `change` against it, so retrying is safe
 * regardless of why the previous attempt failed, not only on a conflicting head. Without this, a
 * transient GitHub error (a rate limit, a dropped mutation) would drop the change after one try,
 * which for an optimistic write silently reverts whatever the user just toggled.
 */
function commit(
	change: (files: StateFiles) => Changes | Promise<Changes>,
	message: string
): Promise<boolean> {
	const run = async (): Promise<boolean> => {
		for (let attempt = 1; attempt <= 4; attempt++) {
			await refreshState({ force: true });
			const current = snapshot!;
			const wanted = await change(current.files);
			const changed = Object.entries(wanted).filter(
				(entry): entry is [string, string | null] =>
					entry[1] !== undefined &&
					(entry[1] === null ? entry[0] in current.files : current.files[entry[0]] !== entry[1])
			);
			if (!changed.length) return false;

			if (current.backend === 'local') {
				for (const [file, text] of changed) {
					const target = path.join(LOCAL_DIR, file);
					if (text === null) fs.rmSync(target, { force: true });
					else {
						fs.mkdirSync(path.dirname(target), { recursive: true });
						fs.writeFileSync(target, text);
					}
				}
				snapshot = readLocal();
				return true;
			}

			const repo = stateRepo();
			const token = await repoToken(repo);
			if (!token) throw new Error(`no configured GitHub token can write to ${repo}`);
			try {
				const result = await graphql<CommitResult>(token, CREATE_COMMIT, {
					input: {
						branch: { repositoryNameWithOwner: repo, branchName: current.branch },
						message: { headline: message },
						expectedHeadOid: current.oid,
						fileChanges: {
							additions: changed
								.filter(([, text]) => text !== null)
								.map(([file, text]) => ({
									path: file,
									contents: Buffer.from(text as string).toString('base64')
								})),
							deletions: changed
								.filter(([, text]) => text === null)
								.map(([file]) => ({ path: file }))
						}
					}
				});
				const files = { ...current.files };
				for (const [file, text] of changed) {
					if (text === null) delete files[file];
					else files[file] = text;
				}
				const commit = result.createCommitOnBranch.commit;
				snapshot = {
					...current,
					oid: commit.oid,
					committedAt: commit.committedDate,
					files,
					checkedAt: Date.now(),
					stale: undefined
				};
				writeCache(snapshot);
				return true;
			} catch (e) {
				if (attempt === 4) throw e;
				// A conflict just means someone else published in between: re-read and retry right
				// away. Anything else (a rate limit, a dropped mutation) gets a short backoff first.
				if (!isConflict(e)) await sleep(attempt * 500);
			}
		}
		return false;
	};

	const next = writing.then(run, run);
	writing = next.catch(() => undefined);
	return next;
}

/**
 * Change files in the state. `change` receives the current files and returns only what should
 * differ (a path to its new text, or null to delete it). If the state moved on since it was read
 * (another machine published), the change is computed again on the newer state and retried, so
 * two writers never overwrite each other. Nothing is written when nothing changed.
 *
 * With `optimistic`, the change is visible to every reader immediately and the commit to GitHub
 * finishes in the background: right for small choices like ticking a repository, where waiting a
 * couple of seconds for GitHub would feel broken. If that commit ultimately fails, the change is
 * dropped again and the state is flagged as stale so the page says so.
 */
export async function updateState(
	change: (files: StateFiles) => Changes | Promise<Changes>,
	message: string,
	{ optimistic = false } = {}
): Promise<boolean> {
	if (!optimistic || !stateRepo()) return commit(change, message);

	await refreshState();
	const files = merged();
	const wanted = await change(files);
	const changed = Object.entries(wanted).filter(
		(entry): entry is [string, string | null] =>
			entry[1] !== undefined &&
			(entry[1] === null ? entry[0] in files : files[entry[0]] !== entry[1])
	);
	if (!changed.length) return false;

	const mine = ++seq;
	for (const [file, text] of changed) overlay.set(file, { text, seq: mine });
	commit(change, message)
		.catch((e) => {
			console.error('Saving a change to the shared state failed:', e);
			if (snapshot)
				snapshot = { ...snapshot, stale: `a change could not be saved (${(e as Error).message})` };
		})
		.finally(() => {
			// Later changes to the same file keep their own entry until their commit lands
			for (const [file] of changed) if (overlay.get(file)?.seq === mine) overlay.delete(file);
		});
	return true;
}
