/**
 * Reads Forward Flow entries: one markdown file per entry, named by timestamp
 * (2026-09-21-143012.md) with a small frontmatter block:
 *
 *   ---
 *   created: 2026-09-21T14:30:12+05:30
 *   tags: [rivers, tooling]
 *   links: [2026-09-20-101133]
 *   ---
 *
 * The source of truth is the entries' git repository on GitHub (FFLOW_REPO), which Forward Flow
 * pushes to after every save. If that cannot be reached, the local folder is shown instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { env } from '$env/dynamic/private';
import { graphql, repoToken } from './github';

export interface FlowEntry {
	id: string; // file name without .md
	created: string; // ISO timestamp
	tags: string[];
	related: string[]; // ids of linked entries, in either direction
	body: string;
	words: number;
}

const APP_ID = 'com.karangoel59.forward-flow';

/** The folder to read: FFLOW_DIR, else the one Forward Flow itself is set to use. */
export function vaultDir(): string | null {
	const configs = [
		path.join(os.homedir(), 'Library', 'Application Support', APP_ID, 'config.json'), // macOS
		path.join(os.homedir(), '.config', APP_ID, 'config.json') // Linux
	];
	const candidates = [env.FFLOW_DIR];
	for (const file of configs) {
		try {
			candidates.push(JSON.parse(fs.readFileSync(file, 'utf-8')).vault);
		} catch {
			// no config here
		}
	}
	return candidates.find((dir) => dir && fs.existsSync(dir)) ?? null;
}

/** Splits `---\n…\n---\n` frontmatter off the top of a file, as Forward Flow does. */
function splitFrontmatter(raw: string): { fm: string; body: string } {
	const text = raw.replace(/\r\n/g, '\n');
	if (!text.startsWith('---\n')) return { fm: '', body: text };

	const rest = text.slice(4);
	const close = /(^|\n)---(\n|$)/.exec(rest);
	if (!close) return { fm: '', body: text };
	return {
		fm: rest.slice(0, close.index),
		body: rest.slice(close.index + close[0].length).trimStart()
	};
}

function frontmatterValue(fm: string, key: string): string | undefined {
	for (const line of fm.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith(`${key}:`)) return trimmed.slice(key.length + 1).trim();
	}
}

/** Inline list: `[a, b, "c"]` */
function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.replace(/^\[/, '')
		.replace(/\]$/, '')
		.split(',')
		.map((s) => s.trim().replace(/^"|"$/g, '').trim())
		.filter(Boolean);
}

/** `2026-09-21-143012` → an ISO-like local timestamp, for files without a `created` field. */
function createdFromName(name: string) {
	const m = name.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})/);
	return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}` : name;
}

interface RawFile {
	name: string; // e.g. 2026-09-21-143012.md
	raw: string;
}

/** Every entry, newest first, with each entry's related entries resolved. */
function buildEntries(files: RawFile[]): FlowEntry[] {
	const parsed = files
		.filter(({ name }) => name.endsWith('.md') && !name.startsWith('.'))
		.map(({ name, raw }) => {
			const { fm, body } = splitFrontmatter(raw);
			const id = name.slice(0, -3);
			return {
				id,
				created: frontmatterValue(fm, 'created') || createdFromName(id),
				tags: parseList(frontmatterValue(fm, 'tags')),
				links: parseList(frontmatterValue(fm, 'links')),
				body: body.trim(),
				words: body.split(/\s+/).filter(Boolean).length
			};
		})
		.sort((a, b) => b.id.localeCompare(a.id)); // names are timestamps, so name order is time order

	// Links are symmetric: an entry is related to what it links to and to whatever links to it,
	// so a half-written pair still shows up on both sides.
	const known = new Set(parsed.map((e) => e.id));
	const related = new Map<string, Set<string>>(parsed.map((e) => [e.id, new Set<string>()]));
	for (const entry of parsed) {
		for (const other of entry.links) {
			if (other !== entry.id && known.has(other)) {
				related.get(entry.id)!.add(other);
				related.get(other)!.add(entry.id);
			}
		}
	}

	return parsed.map(({ id, created, tags, body, words }) => ({
		id,
		created,
		tags,
		body,
		words,
		related: [...related.get(id)!]
	}));
}

// ---------------------------------------------------------------- local folder

function readLocal(): { dir: string; entries: FlowEntry[] } | null {
	const dir = vaultDir();
	if (!dir) return null;

	const files = fs.readdirSync(dir).flatMap((name) => {
		try {
			return name.endsWith('.md')
				? [{ name, raw: fs.readFileSync(path.join(dir, name), 'utf-8') }]
				: [];
		} catch {
			return []; // unreadable file: skip it rather than fail the whole page
		}
	});
	return { dir, entries: buildEntries(files) };
}

// ---------------------------------------------------------------- GitHub repository

const HEAD_QUERY = `query($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		defaultBranchRef { target { ... on Commit { oid committedDate } } }
	}
}`;

// The whole folder in one request: every file's name and text at that commit
const TREE_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
	repository(owner: $owner, name: $name) {
		object(oid: $oid) {
			... on Commit {
				tree { entries { name type object { ... on Blob { text } } } }
			}
		}
	}
}`;

interface HeadResult {
	repository: {
		defaultBranchRef: { target: { oid: string; committedDate: string } } | null;
	} | null;
}

interface TreeResult {
	repository: {
		object: {
			tree: { entries: { name: string; type: string; object: { text?: string | null } | null }[] };
		} | null;
	} | null;
}

interface RepoSnapshot {
	repo: string;
	oid: string;
	committedAt: string;
	entries: FlowEntry[];
	checkedAt: number;
}

// Looking at what is newest on GitHub costs a request, so do it at most this often
const CHECK_EVERY = 15_000;
let snapshot: RepoSnapshot | null = null;

/**
 * Entries as of the repo's latest commit. The files are only downloaded when that commit is new;
 * otherwise the last download is reused.
 */
async function readRepo(repo: string): Promise<RepoSnapshot> {
	if (snapshot?.repo === repo && Date.now() - snapshot.checkedAt < CHECK_EVERY) return snapshot;

	const token = await repoToken(repo);
	if (!token) throw new Error('no configured GitHub token can read it');
	const [owner, name] = repo.split('/');

	const head = (await graphql<HeadResult>(token, HEAD_QUERY, { owner, name })).repository
		?.defaultBranchRef?.target;
	if (!head) throw new Error(`${repo} has no commits yet`);

	if (snapshot?.repo === repo && snapshot.oid === head.oid) {
		snapshot.checkedAt = Date.now();
		return snapshot;
	}

	const tree = (await graphql<TreeResult>(token, TREE_QUERY, { owner, name, oid: head.oid }))
		.repository?.object?.tree;
	if (!tree) throw new Error(`could not read the files of ${repo}`);

	const files = tree.entries.flatMap((e) =>
		e.type === 'blob' && typeof e.object?.text === 'string'
			? [{ name: e.name, raw: e.object.text }]
			: []
	);
	return (snapshot = {
		repo,
		oid: head.oid,
		committedAt: head.committedDate,
		entries: buildEntries(files),
		checkedAt: Date.now()
	});
}

// ---------------------------------------------------------------- public

export interface FlowSource {
	kind: 'github' | 'local';
	label: string; // "owner/repo" or the folder path
	commit?: string; // short commit id, for the repo
	committedAt?: string; // when that commit was made
}

export interface FlowResult {
	source: FlowSource | null;
	entries: FlowEntry[];
	warning?: string; // shown while entries come from the fallback
	error?: string; // nothing could be read at all
}

/** The entries from the git repo, or the local folder if the repo cannot be reached. */
export async function getEntries(): Promise<FlowResult> {
	const repo = (env.FFLOW_REPO || '')
		.trim()
		.replace(/^https:\/\/github\.com\//, '')
		.replace(/\.git$/, '');

	let failure: string | undefined;
	if (repo) {
		try {
			const snap = await readRepo(repo);
			return {
				source: {
					kind: 'github',
					label: repo,
					commit: snap.oid.slice(0, 7),
					committedAt: snap.committedAt
				},
				entries: snap.entries
			};
		} catch (e) {
			failure = (e as Error).message;
			console.error(`Reading ${repo} failed:`, e);
		}
	}

	const local = readLocal();
	if (local) {
		return {
			source: { kind: 'local', label: local.dir },
			entries: local.entries,
			warning: failure
				? `Could not read ${repo} on GitHub (${failure}); showing the local folder.`
				: undefined
		};
	}
	return { source: null, entries: [], error: failure };
}
