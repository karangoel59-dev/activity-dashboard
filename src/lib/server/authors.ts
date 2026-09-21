/**
 * Which commit emails are mine.
 *
 * The local clone lists every author address in a repository. GitHub knows which account an
 * address belongs to (when the address is on someone's profile), so each distinct address is
 * checked once against one of its commits and the answer is kept on disk for good. That finds every
 * address my accounts commit with, on any branch, without walking GitHub's branches.
 *
 * Addresses GitHub cannot tie to an account (e.g. an unlisted personal email) are set by hand in
 * GIT_AUTHOR_EMAILS.
 */
import { configuredEmails, gh, identities } from './github';
import { readJson, writeJson } from './localjson';
import { git } from './mirror';

const ownersFile = 'data/email-owners.json';
const LOOKBACK_DAYS = 365; // addresses seen in the last year
const MAX_LOOKUPS = 400; // per call: a runaway repository must not become hundreds of requests
const CONCURRENCY = 6;
const CACHE_MS = 2 * 60_000;

// email -> GitHub login, or '' when the address is not linked to any account
let owners: Record<string, string> | null = null;
const known = () => (owners ??= readJson<Record<string, string>>(ownersFile, {}));

const recent = new Map<string, { at: number; emails: string[] }>();

/** Every author address in the repo's last year, each with one commit that used it. */
async function authorsOf(repo: string) {
	const from = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toLocaleDateString('en-CA');
	const log = await git(repo, [
		'log',
		'--branches',
		`--since-as-filter=${from}`,
		'--format=%ae%x1f%H'
	]);
	const sample = new Map<string, string>();
	for (const line of log.split('\n')) {
		const [email, sha] = line.split('\x1f');
		if (email && sha && !sample.has(email)) sample.set(email, sha);
	}
	return sample;
}

/** The GitHub login GitHub links to this commit's author, or '' if none. */
async function loginFor(repo: string, sha: string) {
	const res = await gh(repo, `/commits/${sha}`);
	if (!res.ok) return undefined; // could not tell: try again next time rather than remember "nobody"
	return ((await res.json()).author?.login as string | undefined) ?? '';
}

/** The commit emails my GitHub accounts use in this repository, plus those set in GIT_AUTHOR_EMAILS. */
export async function myEmails(repo: string): Promise<string[]> {
	const cached = recent.get(repo);
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.emails;

	const logins = new Set((await identities()).map((i) => i.login.toLowerCase()));
	const store = known();
	const sample = await authorsOf(repo);

	const todo = [...sample].filter(([email]) => !(email in store)).slice(0, MAX_LOOKUPS);
	let learned = false;
	for (let i = 0; i < todo.length; i += CONCURRENCY) {
		await Promise.all(
			todo.slice(i, i + CONCURRENCY).map(async ([email, sha]) => {
				const login = await loginFor(repo, sha).catch(() => undefined);
				if (login !== undefined) {
					store[email] = login;
					learned = true;
				}
			})
		);
	}
	if (learned) writeJson(ownersFile, store);

	const mine = [...sample.keys()].filter((email) => logins.has((store[email] ?? '').toLowerCase()));
	const emails = [...new Set([...configuredEmails(), ...mine])];
	recent.set(repo, { at: Date.now(), emails });
	return emails;
}
