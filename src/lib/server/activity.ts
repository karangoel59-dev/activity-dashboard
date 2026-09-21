/**
 * Activity: my commits on every branch of every tracked repository, grouped by day.
 *
 * A view over the commit facts (facts.ts): the same code runs on your machine, where the facts
 * are kept fresh from the local clones, and on a deployed copy, which only reads what was
 * published. Nothing here touches git or asks GitHub.
 */
import crypto from 'crypto';
import { chat } from './aiCommentator';
import { readJson } from './localjson';
import { ensureFacts, getFacts, type FactCommit } from './facts';
import { hasMirror } from './mirror';
import { getRepos } from './repos';
import { isReadOnly, stateJson, stateRaw, stateText, updateState } from './state';

export interface Commit {
	sha: string;
	repo: string;
	branch?: string; // the branch it was most likely written on
	branches?: string[]; // long-lived branches (prod, stage, uat…) it has since landed on
	message: string;
	date: string; // author timestamp, ISO
	author: string;
	url: string;
}

export interface ActivityDay {
	date: string; // YYYY-MM-DD in the server's timezone (set TZ to control it)
	commits: Commit[];
}

const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA'); // YYYY-MM-DD

/** Commits from every tracked repo in the last `days` days, grouped by local day, newest first. */
export async function getActivity(days: number): Promise<{
	days: ActivityDay[];
	notes: string[];
	asOf: string | null; // when the oldest of the facts used was collected
}> {
	const since = new Date();
	since.setHours(0, 0, 0, 0);
	since.setDate(since.getDate() - (days - 1));
	const sinceDay = since.toLocaleDateString('en-CA');

	const repos = getRepos();
	await Promise.all(repos.map((repo) => ensureFacts(repo)));

	const notes: string[] = [];
	const byDay = new Map<string, Commit[]>();
	let asOf: string | null = null;

	for (const repo of repos) {
		const facts = getFacts(repo);
		if (!facts) {
			notes.push(
				isReadOnly()
					? `${repo} has no published data yet. Open the dashboard on the machine that has its clone and it will be published.`
					: hasMirror(repo)
						? `${repo} is being processed for the first time. Reload in a minute.`
						: `${repo} is being copied to this machine for the first time. It will appear here shortly.`
			);
			continue;
		}
		if (!asOf || facts.collectedAt < asOf) asOf = facts.collectedAt;
		if (facts.since > sinceDay) {
			notes.push(
				`${repo}: only the last ${Math.round((Date.now() - Date.parse(facts.since)) / 86_400_000)} days are collected, so an earlier start is not shown.`
			);
		}

		for (const c of facts.commits) {
			// Filed under the day it was written, and only if git's own date window also holds it
			if (new Date(c.date) < since || new Date(c.cdate) < since) continue;
			const day = localDay(c.date);
			byDay.set(day, [
				...(byDay.get(day) ?? []),
				{
					sha: c.sha,
					repo,
					branch: c.branch,
					branches: c.branches,
					message: c.subject,
					date: c.date,
					author: c.author,
					url: `https://github.com/${repo}/commit/${c.sha}`
				}
			]);
		}
	}

	return {
		days: [...byDay.entries()]
			.map(([date, commits]) => ({
				date,
				commits: commits.sort((a, b) => b.date.localeCompare(a.date))
			}))
			.sort((a, b) => b.date.localeCompare(a.date)),
		notes,
		asOf
	};
}

// ---------------------------------------------------------------- AI day summaries

const SUMMARY_PROMPT = `You turn a developer's git commits for one day into a short work log written for them.
Group by project. For each project write 1-3 bullets describing what was actually worked on,
inferred from commit messages AND the files changed (commit messages are often vague like "update ui").
Be concrete (features, fixes, areas of the codebase). Estimate focus time from commit timestamps when useful.
Output markdown only: "**owner/repo**" lines followed by "- " bullets. No intro, no conclusion.`;

type DaySummary = { key: string; summary: string };
const SUMMARIES = 'summaries.json';

// What earlier versions kept in a local file; imported into the state once
const earlierSummaries = () =>
	readJson<Record<string, DaySummary>>('data/activity-summaries.json', {});
const currentSummaries = (files: Record<string, string>): Record<string, DaySummary> =>
	files[SUMMARIES] ? JSON.parse(files[SUMMARIES]) : earlierSummaries();

/** Files each commit changed, from the facts (already collected, so no GitHub calls). */
function filesOf(commits: Commit[]) {
	const byRepo = new Map<string, Map<string, FactCommit>>();
	for (const { repo } of commits) {
		if (byRepo.has(repo)) continue;
		byRepo.set(repo, new Map((getFacts(repo)?.commits ?? []).map((c) => [c.sha, c])));
	}
	return (c: Commit) => byRepo.get(c.repo)?.get(c.sha)?.files ?? [];
}

function formatForPrompt(commits: Commit[]) {
	const files = filesOf(commits);
	return commits
		.slice()
		.reverse()
		.map((c) => {
			const time = new Date(c.date).toTimeString().slice(0, 5);
			const changed = files(c)
				.slice(0, 25)
				.map(([path, add, del]) => `    ${path} (+${add}/-${del})`)
				.join('\n');
			const branch = c.branch ? ` (${c.branch})` : '';
			return `[${time}] ${c.repo}${branch}: ${c.message.split('\n')[0]}\n${changed}`;
		})
		.join('\n');
}

/**
 * LLM summary for each day. A summary is kept until that day's set of commits changes.
 * Only the newest `limit` days are summarised to keep API usage bounded. A deployed copy (read
 * mode) shows the summaries your machine wrote and never calls the model.
 */
export async function getSummaries(
	activity: ActivityDay[],
	limit = 14
): Promise<Record<string, string>> {
	if (
		stateRaw(SUMMARIES) === undefined &&
		!isReadOnly() &&
		Object.keys(earlierSummaries()).length
	) {
		await updateState(
			(files) => (files[SUMMARIES] ? {} : { [SUMMARIES]: stateText(earlierSummaries()) }),
			'Import earlier AI summaries'
		).catch((e) => console.error('Importing summaries failed:', e));
	}
	const stored =
		stateJson<Record<string, DaySummary> | null>(SUMMARIES, null) ?? earlierSummaries();
	const out: Record<string, string> = {};
	const made: Record<string, DaySummary> = {};

	await Promise.all(
		activity.slice(0, limit).map(async (day) => {
			const key = crypto
				.createHash('sha1')
				.update(
					day.commits
						.map((c) => c.sha)
						.sort()
						.join(',')
				)
				.digest('hex');

			if (stored[day.date]?.key === key) {
				out[day.date] = stored[day.date].summary;
				return;
			}
			if (isReadOnly()) return;

			try {
				const summary = await chat(SUMMARY_PROMPT, formatForPrompt(day.commits.slice(0, 40)), 400);
				if (summary) {
					made[day.date] = { key, summary };
					out[day.date] = summary;
				}
			} catch (e) {
				console.error(`Activity summary failed for ${day.date}:`, e);
			}
		})
	);

	if (Object.keys(made).length) {
		await updateState(
			(files) => ({
				[SUMMARIES]: stateText({ ...currentSummaries(files), ...made })
			}),
			`Add AI summaries for ${Object.keys(made).length} day(s)`
		).catch((e) => console.error('Saving summaries failed:', e));
	}
	return out;
}
