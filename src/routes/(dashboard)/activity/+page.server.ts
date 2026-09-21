import { getActivity, getSummaries } from '$lib/server/activity';
import { listRepos, refreshDiscovered, setOwnerEnabled, setRepoEnabled } from '$lib/server/repos';
import { isReadOnly, stateInfo } from '$lib/server/state';
import { aiConfigured } from '$lib/server/aiCommentator';
import type { Actions, PageServerLoad } from './$types';

const RANGES = [7, 30, 90, 365];

export const load: PageServerLoad = async ({ url, cookies }) => {
	const aiEnabled =
		cookies.get('ai_insights_enabled') === 'true' && (aiConfigured() || isReadOnly());
	const requested = Number(url.searchParams.get('days'));
	const days = RANGES.includes(requested) ? requested : 7;

	await refreshDiscovered();
	const activity = await getActivity(days);

	return {
		repoSettings: listRepos(),
		days,
		ranges: RANGES,
		activity: activity.days,
		notes: activity.notes,
		asOf: activity.asOf,
		readOnly: isReadOnly(),
		state: stateInfo(),
		aiEnabled,
		// Streamed so commits render immediately while the LLM works
		summaries: aiEnabled
			? getSummaries(activity.days).catch((e) => {
					console.error('Activity summaries error:', e);
					return {} as Record<string, string>;
				})
			: Promise.resolve({} as Record<string, string>)
	};
};

export const actions: Actions = {
	toggle: async ({ request }) => {
		const form = await request.formData();
		// An unchecked checkbox is simply absent from the form
		await setRepoEnabled(String(form.get('repo') || ''), form.get('enabled') === 'true');
	},
	owner: async ({ request }) => {
		const form = await request.formData();
		await setOwnerEnabled(String(form.get('owner') || ''), form.get('enabled') === 'true');
	},
	refresh: async () => {
		await refreshDiscovered({ force: true });
	}
};
