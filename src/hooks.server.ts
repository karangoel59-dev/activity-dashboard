import crypto from 'crypto';
import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { refreshState, stateJson } from '$lib/server/state';

const same = (a: string, b: string) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * A deployed copy is reachable by anyone with its URL and shows work commit messages, so when
 * DASHBOARD_PASSWORD is set every request needs it (HTTP Basic auth: any username, that password).
 */
function allowed(header: string | null): boolean {
	const password = env.DASHBOARD_PASSWORD;
	if (!password) return true;
	if (!header?.startsWith('Basic ')) return false;
	const given = Buffer.from(header.slice(6), 'base64').toString();
	return same(given.slice(given.indexOf(':') + 1), password);
}

// Every request sees the shared state as of a few seconds ago. This is a single small request to
// GitHub when the state changed, and nothing at all when it has just been checked.
export const handle: Handle = async ({ event, resolve }) => {
	if (!allowed(event.request.headers.get('authorization'))) {
		return new Response('Sign in to view the dashboard.', {
			status: 401,
			headers: { 'WWW-Authenticate': 'Basic realm="Dashboard", charset="UTF-8"' }
		});
	}

	await refreshState();

	// Which calendar day a commit belongs to depends on the timezone. The machine that collected the
	// facts recorded its own, so every copy groups days the way that machine does, whatever its
	// server happens to be set to (a hosted copy usually runs in UTC).
	const { tz } = stateJson<{ tz?: string }>('manifest.json', {});
	if (tz && process.env.TZ !== tz) process.env.TZ = tz;

	return resolve(event);
};
