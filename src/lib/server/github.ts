/**
 * GitHub client: tokens, REST and GraphQL calls with retries, and who "I" am on GitHub.
 * GITHUB_TOKEN may hold several comma-separated tokens (one per account).
 */
import { env } from '$env/dynamic/private';

/** Which configured token can read which repository, learned as calls succeed. */
export const tokenForRepo = new Map<string, string>();

export function tokens() {
	return (env.GITHUB_TOKEN || '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
}

/**
 * GET a repo endpoint. GITHUB_TOKEN may hold several comma-separated tokens (e.g. one per account);
 * each is tried until one can see the repo, and the winner is remembered for that repo.
 */
export async function gh(repo: string, path = '') {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};
	const url = `https://api.github.com/repos/${repo}${path}`;
	const known = tokenForRepo.get(repo);
	const candidates = known ? [known] : tokens();
	if (!candidates.length) return fetchRetry(url, { headers });

	let fallback: Response | undefined;
	for (const token of candidates) {
		const res = await fetchRetry(url, {
			headers: { ...headers, Authorization: `Bearer ${token}` }
		});
		if (res.ok) {
			tokenForRepo.set(repo, token);
			return res;
		}
		// Prefer reporting "not found" over "bad token" when one token is merely stale
		if (!fallback || fallback.status === 401) fallback = res;
	}
	return fallback!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Errors worth retrying: the connection dropped, or GitHub had a server-side hiccup. */
class Transient extends Error {}

/**
 * fetch + read the whole body, retried on dropped connections, 5xx responses and bodies that
 * arrive cut off (which fail to parse). Anything else is returned or thrown straight away.
 */
export async function githubJson(url: string, init: RequestInit, attempts = 3) {
	let last: Error | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetch(url, init).catch((e) => {
				throw new Transient(`connection failed (${e.cause?.code ?? e.message})`);
			});
			const text = await res.text().catch((e) => {
				throw new Transient(`connection dropped mid-response (${e.cause?.code ?? e.message})`);
			});
			if (res.status >= 500) throw new Transient(`GitHub ${res.status}`);
			try {
				return { res, body: JSON.parse(text) };
			} catch {
				throw new Transient(`response cut off after ${Math.round(text.length / 1024)} KB`);
			}
		} catch (e) {
			if (!(e instanceof Transient)) throw e;
			last = e;
			if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
		}
	}
	throw new Error(`GitHub request failed after ${attempts} attempts: ${last?.message}`);
}

/** fetch, retried on a dropped connection or a 5xx response. Bodies are the caller's to read. */
export async function fetchRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(url, init);
			if (res.status < 500 || attempt >= attempts) return res;
		} catch (e) {
			if (attempt >= attempts) throw e;
		}
		await sleep(500 * 2 ** (attempt - 1));
	}
}

export async function graphql<T>(token: string, query: string, variables: Record<string, unknown>) {
	const { res, body } = await githubJson('https://api.github.com/graphql', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables })
	});
	if (!res.ok || body.errors) {
		throw new Error(`GitHub GraphQL: ${body.errors?.[0]?.message || res.status}`);
	}
	return body.data as T;
}

/**
 * Extra commit emails that count as mine, from GIT_AUTHOR_EMAILS (comma separated). For commits
 * GitHub can't tie to an account, e.g. made with an email that isn't added to the profile.
 */
export function configuredEmails() {
	return (env.GIT_AUTHOR_EMAILS || '')
		.split(',')
		.map((e) => e.trim())
		.filter(Boolean);
}

let identitiesPromise: Promise<{ login: string; id: string }[]> | null = null;

/** The GitHub accounts behind the configured tokens — "me" when filtering commits by author. */
export function identities() {
	if (identitiesPromise) return identitiesPromise;

	let failed = false;
	const lookup = Promise.all(
		tokens().map(async (token) => {
			try {
				const { res, body } = await githubJson('https://api.github.com/user', {
					headers: { Authorization: `Bearer ${token}` }
				});
				if (res.ok) return { login: body.login as string, id: body.node_id as string };
			} catch {
				// network trouble: retried below, on the next call
			}
			failed = true;
			return null;
		})
	).then((users) => {
		// A lookup that failed must not stick for the life of the server
		if (failed) identitiesPromise = null;
		return users.filter((u) => u !== null);
	});
	return (identitiesPromise = lookup);
}

/** Token that can read `repo`, or undefined when no configured token can (or none is set). */
export async function repoToken(repo: string) {
	if (!tokenForRepo.has(repo) && tokens().length) await gh(repo);
	return tokenForRepo.get(repo);
}
