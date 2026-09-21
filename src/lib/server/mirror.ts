/**
 * Local bare clones of tracked repos (branches only) so metrics can run on real git history:
 * churn, file frequency and all-branch counts are impractical over the GitHub API.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { gh, repoToken } from './github';

const exec = promisify(execFile);
const mirrorsDir = 'data/mirrors';
const MAX_BUFFER = 1024 * 1024 * 512;

export type MirrorStatus =
	| { state: 'missing' | 'syncing' }
	| { state: 'ready'; syncedAt: number }
	| { state: 'error'; error: string };

const syncing = new Map<string, Promise<void>>();
const lastError = new Map<string, string>();

export function mirrorPath(repo: string) {
	return path.join(mirrorsDir, repo.replace('/', '__') + '.git');
}

/** Run git against a repo's mirror and return stdout. */
export async function git(repo: string, args: string[], env?: NodeJS.ProcessEnv) {
	const { stdout } = await exec('git', ['--git-dir', mirrorPath(repo), ...args], {
		maxBuffer: MAX_BUFFER,
		env: { ...process.env, ...env }
	});
	return stdout;
}

const SYNCED_MARKER = 'dashboard-synced';

/** A clone that finished at least one sync exists (even if the latest refresh failed). */
export function hasMirror(repo: string) {
	return fs.existsSync(path.join(mirrorPath(repo), SYNCED_MARKER));
}

/** Milliseconds since the last completed sync, or null if there is no clone yet. */
export function mirrorAgeMs(repo: string) {
	const marker = path.join(mirrorPath(repo), SYNCED_MARKER);
	return fs.existsSync(marker) ? Date.now() - fs.statSync(marker).mtimeMs : null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `git log` arguments that keep only commits by any of these email addresses. */
export function authorArgs(emails: string[]) {
	return emails.length
		? ['--regexp-ignore-case', ...emails.map((e) => `--author=<${escapeRegex(e)}>`)]
		: [];
}

export function mirrorStatus(repo: string): MirrorStatus {
	if (syncing.has(repo)) return { state: 'syncing' };
	const error = lastError.get(repo);
	if (error) return { state: 'error', error };

	// Written only after a fetch completes; git creates FETCH_HEAD when a fetch starts
	const age = mirrorAgeMs(repo);
	if (age === null) return { state: 'missing' };
	return { state: 'ready', syncedAt: Date.now() - age };
}

/** Clone or update a mirror. Concurrent calls for the same repo share one fetch. */
export function syncMirror(repo: string): Promise<void> {
	const running = syncing.get(repo);
	if (running) return running;

	const job = (async () => {
		const dir = mirrorPath(repo);
		const res = await gh(repo);
		if (!res.ok) throw new Error(`GitHub ${res.status} for ${repo}`);
		const { default_branch } = await res.json();

		if (!fs.existsSync(path.join(dir, 'HEAD'))) {
			fs.mkdirSync(dir, { recursive: true });
			await exec('git', ['init', '--bare', '--quiet', '--ref-format=reftable', dir]);
			await git(repo, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
			// Branches only: a plain --mirror would also pull every refs/pull/* head
			await git(repo, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
		}

		// Reftable stores refs in one table instead of a file per branch, so branches differing only
		// in case (driveDubai vs drivedubai/changes) don't collide on case-insensitive filesystems
		if ((await git(repo, ['rev-parse', '--show-ref-format'])).trim() !== 'reftable') {
			await git(repo, ['refs', 'migrate', '--ref-format=reftable']);
		}

		// Pass the token through env config so it never appears in argv, logs or error messages
		const token = await repoToken(repo);
		const auth = token
			? {
					GIT_CONFIG_COUNT: '1',
					GIT_CONFIG_KEY_0: 'http.extraHeader',
					GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
				}
			: {};
		await git(repo, ['fetch', '--prune', '--no-tags', '--quiet', 'origin'], {
			...auth,
			GIT_TERMINAL_PROMPT: '0'
		});
		await git(repo, ['symbolic-ref', 'HEAD', `refs/heads/${default_branch}`]);
		fs.writeFileSync(path.join(dir, SYNCED_MARKER), new Date().toISOString());
	})()
		.then(() => {
			lastError.delete(repo);
		})
		.catch((e) => {
			const stderr: string = e.stderr?.trim().split('\n').at(-1) || e.message;
			lastError.set(repo, stderr);
			console.error(`Mirror sync failed for ${repo}:`, stderr);
		})
		.finally(() => syncing.delete(repo));

	syncing.set(repo, job);
	return job;
}

export function removeMirror(repo: string) {
	fs.rmSync(mirrorPath(repo), { recursive: true, force: true });
	lastError.delete(repo);
}
