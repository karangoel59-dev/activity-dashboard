<script lang="ts">
	import { enhance } from '$app/forms';
	import { marked } from 'marked';
	import {
		CalendarDays,
		ChevronDown,
		FolderGit2,
		Flame,
		GitCommitHorizontal,
		Lock,
		RefreshCw,
		Sparkles,
		TriangleAlert
	} from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import Heatmap from '$lib/components/Heatmap.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import { getDotColor, getPillColor } from '$lib/utils';

	let { data } = $props();

	const repoList = $derived(data.repoSettings);
	const enabledCount = $derived(repoList.repos.filter((r) => r.enabled).length);

	// Repos grouped by owner, in the order of each owner's most recently pushed repo
	const owners = $derived.by(() => {
		const groups: Record<string, typeof repoList.repos> = {};
		for (const repo of repoList.repos) (groups[repo.name.split('/')[0]] ??= []).push(repo);
		return Object.entries(groups).map(([owner, repos]) => {
			const on = repos.filter((r) => r.enabled).length;
			return { owner, repos, on, all: on === repos.length };
		});
	});

	const at = (date: string) => new Date(date + 'T12:00:00'); // local noon: immune to DST shifts

	// ---- range and totals
	const today = new Date().toLocaleDateString('en-CA');
	const from = $derived.by(() => {
		const d = at(today);
		d.setDate(d.getDate() - (data.days - 1));
		return d.toLocaleDateString('en-CA');
	});

	// Branch filter: release branches (prod, stage, uat…) that some commit has landed on
	let branchFilter = $state('all');
	const releaseBranches = $derived.by(() => {
		const totals: Record<string, number> = {};
		for (const day of data.activity)
			for (const commit of day.commits)
				for (const branch of commit.branches ?? []) totals[branch] = (totals[branch] ?? 0) + 1;
		return Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	});
	// A stale choice (another range or repo selection no longer has that branch) means "all"
	const activeBranch = $derived(
		releaseBranches.some(([branch]) => branch === branchFilter) ? branchFilter : 'all'
	);
	const activity = $derived(
		activeBranch === 'all'
			? data.activity
			: data.activity
					.map((day) => ({
						...day,
						commits: day.commits.filter((c) => c.branches?.includes(activeBranch))
					}))
					.filter((day) => day.commits.length)
	);

	const counts = $derived(Object.fromEntries(activity.map((d) => [d.date, d.commits.length])));
	const totalCommits = $derived(activity.reduce((sum, d) => sum + d.commits.length, 0));
	const activeRepos = $derived(new Set(activity.flatMap((d) => d.commits.map((c) => c.repo))).size);
	const busiest = $derived(
		activity.reduce<{ date: string; n: number } | null>(
			(best, d) =>
				!best || d.commits.length > best.n ? { date: d.date, n: d.commits.length } : best,
			null
		)
	);

	// Where the commits went: top repositories by count, with bars scaled to the busiest
	const repoTotals = $derived.by(() => {
		const totals: Record<string, number> = {};
		for (const d of activity) for (const c of d.commits) totals[c.repo] = (totals[c.repo] ?? 0) + 1;
		const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
		return { rows: rows.slice(0, 6), more: rows.length - 6, max: rows[0]?.[1] ?? 1 };
	});

	// Commits per slice of the range, for the tile's sparkline (at most 14 points)
	const spark = $derived.by(() => {
		const buckets = Math.min(14, data.days);
		const size = data.days / buckets;
		const out = Array<number>(buckets).fill(0);
		const start = at(from).getTime();
		for (const d of activity) {
			const i = Math.min(
				buckets - 1,
				Math.floor((at(d.date).getTime() - start) / 86_400_000 / size)
			);
			if (i >= 0) out[i] += d.commits.length;
		}
		return out;
	});

	// ---- formatting
	const time = (iso: string) =>
		new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	const firstLine = (message: string) => message.split('\n')[0];
	const shortDate = (date: string) =>
		at(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

	function timeAgo(ms: number) {
		const minutes = Math.round((Date.now() - ms) / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} min ago`;
		return `${Math.round(minutes / 60)} h ago`;
	}

	/** A day's commits grouped by repository, biggest group first. */
	function byRepo(commits: (typeof activity)[number]['commits']) {
		const groups: Record<string, typeof commits> = {};
		for (const commit of commits) (groups[commit.repo] ??= []).push(commit);
		return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
	}

	const rangeItems = $derived(
		data.ranges.map((range) => ({
			label: range === 365 ? '1y' : `${range}d`,
			query: `?days=${range}`,
			active: data.days === range
		}))
	);
</script>

<svelte:head>
	<title>Activity</title>
</svelte:head>

<PageHeader
	title="Activity"
	description="What you shipped, from the commits across every repository you contribute to."
>
	{#snippet actions()}
		{#if releaseBranches.length}
			<label class="flex items-center gap-2 text-xs text-ink-3">
				<span class="sr-only sm:not-sr-only">Branch</span>
				<select
					bind:value={branchFilter}
					class="field py-1.5"
					aria-label="Show commits on a branch"
				>
					<option value="all">All branches</option>
					{#each releaseBranches as [branch, n] (branch)}
						<option value={branch}>{branch} ({n})</option>
					{/each}
				</select>
			</label>
		{/if}
		<Segmented base="/activity" items={rangeItems} label="Date range" />
	{/snippet}
</PageHeader>

<StateBadge asOf={data.asOf} readOnly={data.readOnly} state={data.state} />

{#each data.notes as note (note)}
	<p class="card mb-4 flex items-start gap-2 border-warn/30 px-4 py-3 text-sm text-warn">
		<TriangleAlert size={16} class="mt-0.5 shrink-0" />
		{note}
	</p>
{/each}

<!-- Headline numbers -->
<section class="rise mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
	<Stat
		icon={GitCommitHorizontal}
		label="Commits"
		value={totalCommits.toLocaleString('en-US')}
		sub="last {data.days} days"
		{spark}
	/>
	<Stat
		icon={CalendarDays}
		label="Active days"
		value={String(activity.length)}
		sub="of {data.days} days"
	/>
	<Stat
		icon={FolderGit2}
		label="Repositories"
		value={String(activeRepos)}
		sub="with commits · {enabledCount} shown"
	/>
	<Stat
		icon={Flame}
		label="Busiest day"
		value={busiest ? String(busiest.n) : '—'}
		sub={busiest ? `${shortDate(busiest.date)} · commits` : 'no commits yet'}
	/>
</section>

<!-- Calendar -->
<section class="card rise mb-4 p-5">
	<div class="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
		<div class="min-w-0">
			<div class="mb-4 flex items-baseline justify-between gap-3">
				<h2 class="section-title">Commits per day</h2>
				<p class="text-xs text-ink-3">{shortDate(from)} – {shortDate(today)}</p>
			</div>
			<Heatmap
				{counts}
				{from}
				to={today}
				cell={data.days > 120 ? 12 : 16}
				gap={data.days > 120 ? 3 : 4}
			/>
		</div>

		<div class="border-t border-line pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
			<h2 class="section-title mb-4">By repository</h2>
			<ul class="flex flex-col gap-3">
				{#each repoTotals.rows as [repo, n] (repo)}
					<li>
						<div class="mb-1 flex items-center gap-2 text-sm">
							<span class="h-2 w-2 shrink-0 rounded-full {getDotColor(repo)}"></span>
							<span class="min-w-0 flex-1 truncate" title={repo}>{repo.split('/')[1]}</span>
							<span class="text-ink-2 tabular-nums">{n}</span>
						</div>
						<div class="h-1.5 rounded-full bg-raised">
							<div
								class="h-1.5 rounded-full bg-accent"
								style="width:{Math.max(3, (n / repoTotals.max) * 100)}%"
							></div>
						</div>
					</li>
				{:else}
					<li class="text-sm text-ink-3">No commits in this range.</li>
				{/each}
			</ul>
			{#if repoTotals.more > 0}
				<p class="mt-3 text-xs text-ink-3">+ {repoTotals.more} more</p>
			{/if}
		</div>
	</div>
</section>

<!-- Repositories: switch any off; an owner's switch turns all of theirs on or off -->
<details class="card group mb-8">
	<summary
		class="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5 select-none [&::-webkit-details-marker]:hidden"
	>
		<FolderGit2 size={18} class="text-ink-3" />
		<span class="text-sm font-medium">Repositories</span>
		<span class="text-sm text-ink-3">{enabledCount} of {repoList.repos.length} shown</span>
		<span class="ml-auto hidden items-center -space-x-1 sm:flex">
			{#each repoList.repos.filter((r) => r.enabled).slice(0, 8) as repo (repo.name)}
				<span
					class="h-3 w-3 rounded-full ring-2 ring-surface {getDotColor(repo.name)}"
					title={repo.name}
				></span>
			{/each}
		</span>
		<ChevronDown size={16} class="text-ink-3 transition-transform group-open:rotate-180" />
	</summary>

	<div class="flex flex-col gap-4 border-t border-line px-5 py-4">
		{#if !data.readOnly}
			<div class="flex items-center gap-3 text-xs text-ink-3">
				<form method="POST" action="?/refresh" use:enhance class="flex items-center gap-2">
					<button type="submit" class="btn" title="Look for new repositories now">
						<RefreshCw size={13} /> Refresh list
					</button>
					{#if repoList.discoveredAt}<span>updated {timeAgo(repoList.discoveredAt)}</span>{/if}
				</form>
			</div>
		{/if}

		{#if repoList.discoveryError}
			<p class="text-xs text-bad">Could not refresh the repo list: {repoList.discoveryError}</p>
		{/if}

		{#each owners as group (group.owner)}
			<div class="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:gap-5">
				<form
					method="POST"
					action="?/owner"
					use:enhance
					class="flex shrink-0 items-center gap-2.5 sm:w-52"
				>
					<input type="hidden" name="owner" value={group.owner} />
					<input type="hidden" name="enabled" value={String(!group.all)} />
					<button
						type="submit"
						role="switch"
						aria-checked={group.all}
						aria-label="Show all {group.owner} repos"
						class="relative h-5 w-9 shrink-0 rounded-full transition-colors {group.all
							? 'bg-accent'
							: group.on
								? 'bg-accent/40'
								: 'bg-line-strong'}"
					>
						<span
							class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform {group.all
								? 'translate-x-4'
								: ''}"
						></span>
					</button>
					<span class="truncate text-sm font-medium">{group.owner}</span>
					<span class="text-xs text-ink-3 tabular-nums">{group.on}/{group.repos.length}</span>
				</form>

				<div class="flex flex-wrap gap-x-4 gap-y-2">
					{#each group.repos as repo (repo.name)}
						<form
							method="POST"
							action="?/toggle"
							use:enhance={() =>
								async ({ update }) => {
									await update({ reset: false });
								}}
						>
							<input type="hidden" name="repo" value={repo.name} />
							<label class="flex cursor-pointer items-center gap-2">
								<input
									type="checkbox"
									name="enabled"
									value="true"
									checked={repo.enabled}
									onchange={(e) => e.currentTarget.form?.requestSubmit()}
									class="h-4 w-4 rounded border-line-strong bg-surface text-accent focus:ring-accent"
								/>
								<span
									class="chip {repo.enabled ? getPillColor(repo.name) : 'bg-raised text-ink-3'}"
								>
									{repo.name.split('/')[1]}
									{#if repo.private}<Lock size={11} class="opacity-60" aria-label="private" />{/if}
									{#if repo.archived}<span class="text-[10px] opacity-60">archived</span>{/if}
								</span>
							</label>
						</form>
					{/each}
				</div>
			</div>
		{:else}
			<p class="text-sm text-ink-3">
				No repositories found. Make sure GITHUB_TOKEN is set, then press Refresh.
			</p>
		{/each}
	</div>
</details>

<!-- Timeline -->
<div class="flex flex-col gap-8">
	{#each activity as day (day.date)}
		{@const d = at(day.date)}
		<section class="grid gap-x-6 gap-y-3 md:grid-cols-[7.5rem_1fr]">
			<header
				class="flex items-baseline gap-3 md:sticky md:top-8 md:flex-col md:items-start md:gap-0 md:self-start"
			>
				<p class="text-3xl leading-none font-semibold tracking-tight">{d.getDate()}</p>
				<p class="text-sm text-ink-2 md:mt-1">
					{d.toLocaleDateString('en-US', { weekday: 'long' })}
				</p>
				<p class="text-xs text-ink-3">
					{d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
				</p>
				<p class="chip mt-0 bg-raised text-ink-2 md:mt-2">
					{day.commits.length} commit{day.commits.length === 1 ? '' : 's'}
				</p>
			</header>

			<div class="card overflow-hidden">
				{#if data.aiEnabled && activeBranch === 'all'}
					{#await data.summaries}
						<div class="flex items-center gap-2 border-b border-line px-4 py-3 text-sm text-accent">
							<Sparkles size={14} class="animate-pulse" />
							<span class="shimmer h-3 w-56 rounded"></span>
						</div>
					{:then summaries}
						{#if summaries[day.date]}
							<div class="flex gap-3 border-b border-line bg-accent/5 px-4 py-3.5">
								<Sparkles size={15} class="mt-1 shrink-0 text-accent" />
								<article class="prose-app prose prose-sm max-w-none prose-p:my-1 prose-li:my-0.5">
									<!-- eslint-disable-next-line svelte/no-at-html-tags -->
									{@html marked.parse(summaries[day.date])}
								</article>
							</div>
						{/if}
					{/await}
				{/if}

				<div class="divide-y divide-line">
					{#each byRepo(day.commits) as [repo, commits] (repo)}
						<div class="px-2 py-2">
							<p class="flex items-center gap-2 px-2 py-1.5 text-xs font-medium text-ink-2">
								<span class="h-2 w-2 rounded-full {getDotColor(repo)}"></span>
								{repo}
								<span class="font-normal text-ink-3">{commits.length}</span>
							</p>
							<ul>
								{#each commits as commit (commit.sha)}
									<li>
										<a
											href={commit.url}
											target="_blank"
											rel="noopener noreferrer"
											class="group/row flex items-baseline gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-raised"
										>
											<span class="w-[4.25rem] shrink-0 text-xs text-ink-3 tabular-nums"
												>{time(commit.date)}</span
											>
											<span class="min-w-0 flex-1 text-sm text-ink"
												>{firstLine(commit.message)}</span
											>
											<span class="hidden shrink-0 items-center gap-1 sm:flex">
												{#if commit.branch && !commit.branches?.includes(commit.branch)}
													<span
														class="max-w-40 truncate rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-3"
														title="Written on {commit.branch}">{commit.branch}</span
													>
												{/if}
												{#each (commit.branches ?? []).slice(0, 3) as branch (branch)}
													<span
														class="max-w-32 truncate rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent"
														title="Landed on {branch}">{branch}</span
													>
												{/each}
												{#if (commit.branches?.length ?? 0) > 3}
													<span
														class="text-[10px] text-ink-3"
														title={commit.branches?.slice(3).join(', ')}
														>+{(commit.branches?.length ?? 0) - 3}</span
													>
												{/if}
											</span>
										</a>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				</div>
			</div>
		</section>
	{:else}
		<div class="card flex flex-col items-center gap-2 px-6 py-14 text-center">
			<GitCommitHorizontal size={28} class="text-ink-3" />
			<p class="font-medium">
				{enabledCount ? `No commits in the last ${data.days} days` : 'No repositories selected'}
			</p>
			<p class="max-w-sm text-sm text-ink-3">
				{enabledCount
					? 'Try a longer range, or check that the right repositories are switched on.'
					: 'Open the Repositories panel above and tick at least one to see its activity.'}
			</p>
		</div>
	{/each}
</div>
