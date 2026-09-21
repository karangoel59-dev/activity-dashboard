import { ensureFacts, getFacts } from '$lib/server/facts';
import { getRepos, refreshDiscovered } from '$lib/server/repos';
import { computeInsights, computeMetrics, sourceStatus } from '$lib/server/metrics';
import { resetTaxonomy } from '$lib/server/classify';
import { aiConfigured } from '$lib/server/aiCommentator';
import { isReadOnly, stateInfo } from '$lib/server/state';
import type { Actions, PageServerLoad } from './$types';

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export const load: PageServerLoad = async ({ url, cookies }) => {
	const aiEnabled =
		cookies.get('ai_insights_enabled') === 'true' && (aiConfigured() || isReadOnly());

	const today = new Date().toLocaleDateString('en-CA');
	const sixMonthsAgo = new Date();
	sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const window = {
		from: isDate(from) ? from : sixMonthsAgo.toLocaleDateString('en-CA'),
		to: isDate(to) ? to : today
	};

	await refreshDiscovered();
	const computed = computeMetrics(window, { fresh: url.searchParams.has('refresh') });

	return {
		window,
		aiEnabled,
		readOnly: isReadOnly(),
		state: stateInfo(),
		repos: getRepos().map((repo) => ({ repo, mirror: sourceStatus(repo, getFacts(repo)) })),
		// Streamed: refreshing a repository's facts can take a while
		metrics: computed.then((c) => c.metrics),
		insights: aiEnabled ? computed.then(computeInsights) : null
	};
};

export const actions: Actions = {
	sync: async () => {
		if (isReadOnly()) return;
		await Promise.all(getRepos().map((repo) => ensureFacts(repo, { force: true })));
	},
	reclassify: async () => {
		if (isReadOnly()) return;
		await resetTaxonomy();
	}
};
