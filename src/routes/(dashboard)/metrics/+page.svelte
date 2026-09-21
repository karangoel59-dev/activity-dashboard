<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import {
		CalendarDays,
		ChevronDown,
		Code,
		GitCommitHorizontal,
		GitMerge,
		GitPullRequest,
		RefreshCw,
		Sparkles,
		Ticket,
		TriangleAlert
	} from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import BarChart from '$lib/components/BarChart.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import { formatDate } from '$lib/utils';

	let { data } = $props();

	type ChurnRow = {
		ext: string;
		code: boolean;
		additions: number;
		deletions: number;
		changes: number;
	};

	let repoFilter = $state('all');

	const nf = new Intl.NumberFormat('en-US');
	const n = (v: number) => nf.format(v);
	const pct = (part: number, whole: number) =>
		whole ? `${((part / whole) * 100).toFixed(1)}%` : '—';
	const at = (date: string) => new Date(date + 'T12:00:00');
	const monthName = (m: string, style: 'long' | 'short' = 'long') =>
		new Date(m + '-01T12:00:00').toLocaleDateString('en-US', {
			month: style,
			year: style === 'long' ? 'numeric' : undefined
		});

	// Keep polling while a mirror is cloning so git metrics appear without a manual reload
	$effect(() => {
		if (
			data.readOnly ||
			!data.repos.some((r) => r.mirror.state === 'syncing' || r.mirror.state === 'missing')
		)
			return;
		const timer = setInterval(() => invalidateAll(), 10_000);
		return () => clearInterval(timer);
	});

	// ---- date range presets (same maths the server uses for its default window)
	const today = new Date().toLocaleDateString('en-CA');
	// The Date constructor rolls month and day overflow over exactly as setMonth/setDate would
	const daysAgo = (days: number) => {
		const t = at(today);
		return new Date(t.getFullYear(), t.getMonth(), t.getDate() - (days - 1)).toLocaleDateString(
			'en-CA'
		);
	};
	const monthsAgo = (months: number) => {
		const t = at(today);
		return new Date(t.getFullYear(), t.getMonth() - months, t.getDate()).toLocaleDateString(
			'en-CA'
		);
	};
	const presets = [
		{ label: '30d', from: daysAgo(30) },
		{ label: '90d', from: daysAgo(90) },
		{ label: '6m', from: monthsAgo(6) },
		{ label: 'This year', from: `${today.slice(0, 4)}-01-01` }
	];
	const rangeItems = $derived(
		presets.map((p) => ({
			label: p.label,
			query: `?from=${p.from}&to=${today}`,
			active: data.window.from === p.from && data.window.to === today
		}))
	);

	const syncState: Record<string, { label: string; dot: string }> = {
		missing: { label: 'Not synced', dot: 'bg-ink-3' },
		syncing: { label: 'Syncing…', dot: 'animate-pulse bg-warn' },
		ready: { label: 'Synced', dot: 'bg-good' },
		error: { label: 'Sync failed', dot: 'bg-bad' }
	};
	const syncing = $derived(data.repos.filter((r) => r.mirror.state === 'syncing').length);
	const failed = $derived(data.repos.filter((r) => r.mirror.state === 'error').length);

	function combineChurn(rows: ChurnRow[]) {
		const byExt: Record<string, ChurnRow> = {};
		for (const r of rows) {
			const row = (byExt[r.ext] ??= { ...r, additions: 0, deletions: 0, changes: 0 });
			row.additions += r.additions;
			row.deletions += r.deletions;
			row.changes += r.changes;
		}
		return Object.values(byExt).sort(
			(a, b) => b.additions + b.deletions - (a.additions + a.deletions)
		);
	}
</script>

<svelte:head>
	<title>Metrics</title>
</svelte:head>

<!-- A ranked list row: label, value, and a bar scaled to the largest -->
{#snippet ranked(label: string, sub: string, value: number, max: number, right: string, title = '')}
	<li title={title || undefined}>
		<div class="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
			<span class="min-w-0 flex-1 truncate">{label}</span>
			<span class="shrink-0 text-ink-2 tabular-nums">{right}</span>
		</div>
		<div class="h-1.5 rounded-full bg-raised">
			<div
				class="h-1.5 rounded-full bg-accent"
				style="width:{max ? Math.max((value / max) * 100, value ? 1.5 : 0) : 0}%"
			></div>
		</div>
		{#if sub}<p class="mt-1 text-[11px] text-ink-3">{sub}</p>{/if}
	</li>
{/snippet}

<PageHeader title="Metrics" description="Pull requests, commits and where the effort went.">
	{#snippet actions()}
		<Segmented base="/metrics" items={rangeItems} label="Date range" />

		<details class="group relative">
			<summary class="btn list-none [&::-webkit-details-marker]:hidden">
				<CalendarDays size={14} /> Custom
				<ChevronDown size={14} class="transition-transform group-open:rotate-180" />
			</summary>
			<form
				method="GET"
				class="card absolute top-full right-0 z-30 mt-2 flex w-72 flex-col gap-3 p-4 shadow-lg"
			>
				<label class="flex flex-col gap-1 text-xs font-medium text-ink-3">
					From
					<input name="from" type="date" value={data.window.from} class="field" />
				</label>
				<label class="flex flex-col gap-1 text-xs font-medium text-ink-3">
					To
					<input name="to" type="date" value={data.window.to} class="field" />
				</label>
				<button type="submit" class="btn btn-primary">Apply range</button>
			</form>
		</details>

		{#if !data.readOnly}
			<form method="POST" action="?/sync" use:enhance>
				<button type="submit" class="btn" title="Fetch the latest commits into the local copies">
					<RefreshCw size={14} class={syncing ? 'animate-spin' : ''} /> Sync
				</button>
			</form>
		{/if}
	{/snippet}
</PageHeader>

<!-- Where the numbers come from -->
<details class="group -mt-2 mb-6 text-sm">
	<summary
		class="inline-flex cursor-pointer list-none items-center gap-2 text-xs text-ink-3 select-none hover:text-ink-2 [&::-webkit-details-marker]:hidden"
	>
		<span
			class="h-2 w-2 rounded-full {failed
				? 'bg-bad'
				: syncing
					? 'animate-pulse bg-warn'
					: 'bg-good'}"
		></span>
		{data.repos.length} repositories ·
		{failed ? `${failed} failed` : syncing ? `${syncing} syncing` : 'all synced'}
		<ChevronDown size={12} class="transition-transform group-open:rotate-180" />
	</summary>
	<ul class="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
		{#each data.repos as { repo, mirror } (repo)}
			<li
				class="flex items-center gap-2"
				title={mirror.state === 'error' ? mirror.error : undefined}
			>
				<span class="h-1.5 w-1.5 shrink-0 rounded-full {syncState[mirror.state].dot}"></span>
				<span class="truncate text-ink-2">{repo}</span>
				<span class="ml-auto shrink-0 text-ink-3">{syncState[mirror.state].label}</span>
			</li>
		{:else}
			<li class="text-ink-3">No repositories tracked yet: switch some on in Activity.</li>
		{/each}
	</ul>
</details>

{#await data.metrics}
	<!-- Loading: hold the page's shape so nothing jumps when the numbers arrive -->
	<p class="mb-4 text-sm text-ink-3">
		Crunching git history and pull requests. The first load of a new range can take a minute.
	</p>
	<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
		{#each [0, 1, 2, 3, 4, 5] as i (i)}
			<div class="card shimmer h-[104px]"></div>
		{/each}
	</div>
	<div class="mt-4 grid gap-4 lg:grid-cols-2">
		<div class="card shimmer h-64"></div>
		<div class="card shimmer h-64"></div>
	</div>
{:then m}
	{@const repos = m.repos.filter((r) => repoFilter === 'all' || r.repo === repoFilter)}
	{@const churn = combineChurn(repos.flatMap((r) => r.churn.filter((c) => c.code)))}
	{@const mergesMine = m.repos.reduce((s, r) => s + (r.commits?.mergesMine || 0), 0)}
	{@const maxChurn = Math.max(...churn.map((c) => c.additions + c.deletions), 1)}
	{@const monthData = m.months.map((x) => ({
		...x,
		label: monthName(x.month),
		short: monthName(x.month, 'short')
	}))}

	{#each m.repos.filter((r) => r.notes.length) as r (r.repo)}
		<p class="mb-2 flex items-start gap-2 text-xs text-ink-3">
			<span class="font-medium text-ink-2">{r.repo}:</span>
			{r.notes.join(' ')}
		</p>
	{/each}

	{#each m.repos.filter((r) => r.errors.length) as r (r.repo)}
		<p class="card mb-3 flex items-start gap-2 border-bad/30 px-4 py-3 text-sm text-bad">
			<TriangleAlert size={16} class="mt-0.5 shrink-0" />
			<span><span class="font-medium">{r.repo}:</span> {r.errors.join(' · ')}</span>
		</p>
	{/each}

	<StateBadge
		asOf={m.repos
			.map((r) => (r.mirror.state === 'ready' ? r.mirror.syncedAt : null))
			.filter((t): t is number => t !== null)
			.sort((a, b) => a - b)
			.map((t) => new Date(t).toISOString())[0] ?? null}
		readOnly={data.readOnly}
		state={data.state}
	/>

	<!-- Headline -->
	<section class="rise grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
		<Stat
			icon={GitPullRequest}
			label="Pull requests"
			value={n(m.totals.prs.authored)}
			sub="{n(m.totals.prs.merged)} merged"
			spark={m.months.map((x) => x.prs)}
		/>
		<Stat
			icon={GitMerge}
			label="Merge rate"
			value={pct(m.totals.prs.merged, m.totals.prs.authored)}
			sub="{m.totals.prs.closed} closed · {m.totals.prs.open} open"
		/>
		<Stat
			icon={GitCommitHorizontal}
			label="Commits"
			value={n(m.totals.commits)}
			sub="+{n(mergesMine)} merge commits"
			spark={m.months.map((x) => x.commits)}
		/>
		<Stat
			icon={Code}
			label="Lines touched"
			value={n(m.totals.additions + m.totals.deletions)}
			sub="+{n(m.totals.additions)} / −{n(m.totals.deletions)}"
		/>
		<Stat
			icon={CalendarDays}
			label="Active days"
			value={n(m.cadence.activeDays)}
			sub="{pct(m.cadence.activeDays, m.cadence.spanDays)} of {m.cadence.spanDays} days"
		/>
		<Stat
			icon={Ticket}
			label="Jira tickets"
			value={n(m.jira.total)}
			sub={m.jira.projects.map((p) => `${p.project} ${p.count}`).join(' · ') || 'none referenced'}
		/>
	</section>

	{#if m.totals.firstCommit && m.totals.lastCommit}
		<p class="mt-3 text-xs text-ink-3">
			{formatDate(m.window.from + 'T12:00:00')} – {formatDate(m.window.to + 'T12:00:00')} · first commit
			{formatDate(m.totals.firstCommit.date)} · last {formatDate(m.totals.lastCommit.date)} · counted
			as {m.identities.join(', ')}
		</p>
	{/if}

	<!-- Trends -->
	<section class="mt-8">
		<h2 class="section-title mb-3">Month over month</h2>
		<div class="grid gap-4 lg:grid-cols-2">
			<div class="card p-5">
				<p class="mb-4 text-sm text-ink-2">Commits per month</p>
				<BarChart
					data={monthData.map((x) => ({ label: x.label, short: x.short, value: x.commits }))}
					unit="commits"
				/>
			</div>
			<div class="card p-5">
				<p class="mb-4 text-sm text-ink-2">Pull requests per month</p>
				<BarChart
					data={monthData.map((x) => ({ label: x.label, short: x.short, value: x.prs }))}
					unit="pull requests"
				/>
			</div>
		</div>

		<div class="card mt-4 grid divide-y divide-line sm:grid-cols-4 sm:divide-x sm:divide-y-0">
			{#each [['Active weeks', n(m.cadence.activeWeeks), `longest streak ${m.cadence.longestWeekStreak} weeks`], ['PRs per active day', String(m.cadence.prsPerActiveDay), `${m.cadence.prsPerWeek} per calendar week`], ['Commits per active day', String(m.cadence.commitsPerActiveDay), `${m.cadence.commitsPerWeek} per calendar week`], ['File changes', n(m.totals.fileChanges), `${(m.totals.fileChanges / (m.totals.commits || 1)).toFixed(1)} files per commit`]] as [label, value, sub] (label)}
				<div class="px-5 py-4">
					<p class="text-xs font-medium text-ink-3">{label}</p>
					<p class="mt-0.5 text-xl font-semibold tracking-tight">{value}</p>
					<p class="text-xs text-ink-3">{sub}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Repositories -->
	<section class="mt-8">
		<h2 class="section-title">Contribution by repository</h2>
		<p class="mt-0.5 mb-3 text-sm text-ink-3">
			A share is your count divided by everyone's in the same window. Commits exclude merges.
		</p>
		<div class="card overflow-x-auto">
			<table class="w-full min-w-[760px] text-sm">
				<thead>
					<tr class="border-b border-line bg-raised/60">
						<th class="th">Repository</th>
						<th class="th text-right">Pull requests</th>
						<th class="th text-right">Merge rate</th>
						<th class="th text-right">PR share</th>
						<th class="th text-right">Commits</th>
						<th class="th text-right">Mainline share</th>
						<th class="th text-right">All branches</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-line tabular-nums">
					{#each m.repos as r (r.repo)}
						<tr class="transition-colors hover:bg-raised/60">
							<td class="td font-medium">{r.repo}</td>
							{#if r.prs}
								<td class="td text-right">
									{n(r.prs.authored)}
									<span class="block text-[11px] text-ink-3"
										>{n(r.prs.closed)} closed · {n(r.prs.open)} open</span
									>
								</td>
								<td class="td text-right">{pct(r.prs.merged, r.prs.authored)}</td>
								<td class="td text-right">
									{pct(r.prs.authored, r.prs.orgTotal)}
									<span class="block text-[11px] text-ink-3">of {n(r.prs.orgTotal)}</span>
								</td>
							{:else}
								<td class="td text-right text-ink-3" colspan="3">—</td>
							{/if}
							{#if r.commits}
								<td class="td text-right">{n(r.commits.mine)}</td>
								<td class="td text-right">
									{pct(r.commits.mainlineMine, r.commits.mainlineTotal)}
									<span
										class="block font-mono text-[11px] text-ink-3"
										title="The branch most of your PRs merge into"
										>{r.commits.mainline} · {n(r.commits.mainlineMine)}/{n(
											r.commits.mainlineTotal
										)}</span
									>
								</td>
								<td class="td text-right">
									{pct(r.commits.mine, r.commits.allBranchTotal)}
									<span class="block text-[11px] text-ink-3"
										>{n(r.commits.mine)}/{n(r.commits.allBranchTotal)}</span
									>
								</td>
							{:else}
								<td class="td text-right text-ink-3" colspan="3"
									>{syncState[r.mirror.state].label}</td
								>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<!-- Effort -->
	<section class="mt-8">
		<div class="mb-3 flex items-end justify-between gap-4">
			<div>
				<h2 class="section-title">Where the effort went</h2>
				<p class="mt-0.5 text-sm text-ink-3">
					Each commit and pull request is classified by the language model into one domain and one
					work type.
				</p>
			</div>
			{#if data.insights && !data.readOnly}
				<form method="POST" action="?/reclassify" use:enhance>
					<button type="submit" class="btn shrink-0">Rebuild domains</button>
				</form>
			{/if}
		</div>

		{#if !data.insights}
			<div class="card flex items-center gap-3 px-5 py-6 text-sm text-ink-2">
				<Sparkles size={18} class="shrink-0 text-accent" />
				Turn on AI insights in the sidebar to classify your work by domain and work type.
			</div>
		{:else}
			{#await data.insights}
				<div class="grid gap-4 lg:grid-cols-2">
					<div class="card shimmer h-80"></div>
					<div class="card shimmer h-80"></div>
				</div>
				<p class="mt-3 flex items-center gap-2 text-sm text-accent">
					<Sparkles size={14} class="animate-pulse" /> Classifying commits and PRs (the first run takes
					a minute)…
				</p>
			{:then insights}
				{@const domainCommits = insights.domains.reduce((s, d) => s + d.commits, 0)}
				{@const maxDomain = Math.max(...insights.domains.map((d) => d.commits), 1)}
				{@const typeTotal = insights.types.reduce((s, t) => s + t.commits, 0)}
				{@const maxType = Math.max(...insights.types.map((t) => t.commits), 1)}

				{#if insights.classified < insights.total}
					<p class="mb-3 text-xs text-warn">
						{insights.total - insights.classified} of {insights.total} items are not classified yet. Reload
						to retry.
					</p>
				{/if}

				<div class="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
					<div class="card p-5">
						<p class="mb-4 text-sm text-ink-2">Domain (commits, with pull requests)</p>
						<ul class="flex flex-col gap-3.5">
							{#each insights.domains as d (d.name)}
								{@render ranked(
									d.name,
									`${n(d.prs)} pull requests`,
									d.commits,
									maxDomain,
									`${n(d.commits)} · ${pct(d.commits, domainCommits)}`,
									d.description
								)}
							{/each}
						</ul>
					</div>

					<div class="flex flex-col gap-4">
						<div class="card p-5">
							<p class="mb-4 text-sm text-ink-2">Work type (commits)</p>
							<ul class="flex flex-col gap-3.5">
								{#each insights.types as t (t.name)}
									{@render ranked(
										t.name,
										'',
										t.commits,
										maxType,
										`${n(t.commits)} · ${pct(t.commits, typeTotal)}`
									)}
								{/each}
							</ul>
						</div>
						<div class="card p-5">
							<p class="mb-3 text-sm text-ink-2">Main focus by month</p>
							<dl class="flex flex-col divide-y divide-line text-sm">
								{#each monthData as x (x.month)}
									<div class="flex gap-3 py-2 first:pt-0 last:pb-0">
										<dt class="w-24 shrink-0 text-ink-3">{x.short}</dt>
										<dd class="min-w-0 flex-1">
											{insights.monthFocus[x.month]?.join(', ') || '—'}
										</dd>
									</div>
								{/each}
							</dl>
						</div>
					</div>
				</div>
			{:catch error}
				<p class="card border-bad/30 px-4 py-3 text-sm text-bad">
					Classification failed: {error.message}
				</p>
			{/await}
		{/if}
	</section>

	<!-- Code -->
	<section class="mt-8">
		<div class="mb-3 flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 class="section-title">Code churn by file type</h2>
				<p class="mt-0.5 text-sm text-ink-3">
					Your commits on all branches, merges excluded. Code and config only; data files such as
					.csv or .pickle are left out.
				</p>
			</div>
			<select bind:value={repoFilter} aria-label="Repository" class="field">
				<option value="all">All repositories</option>
				{#each m.repos as r (r.repo)}
					<option value={r.repo}>{r.repo}</option>
				{/each}
			</select>
		</div>
		<div class="card overflow-x-auto">
			<table class="w-full min-w-[620px] text-sm">
				<thead>
					<tr class="border-b border-line bg-raised/60">
						<th class="th">Type</th>
						<th class="th text-right">Added</th>
						<th class="th text-right">Deleted</th>
						<th class="th w-2/5">Lines touched</th>
						<th class="th text-right">File changes</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-line tabular-nums">
					{#each churn.slice(0, 10) as c (c.ext)}
						<tr class="transition-colors hover:bg-raised/60">
							<td class="td font-mono text-xs">{c.ext}</td>
							<td class="td text-right text-good">+{n(c.additions)}</td>
							<td class="td text-right text-bad">−{n(c.deletions)}</td>
							<td class="td">
								<div class="flex items-center gap-3">
									<div class="h-1.5 flex-1 rounded-full bg-raised">
										<div
											class="h-1.5 rounded-full bg-accent"
											style="width:{Math.max(((c.additions + c.deletions) / maxChurn) * 100, 1.5)}%"
										></div>
									</div>
									<span class="w-16 text-right text-ink-2">{n(c.additions + c.deletions)}</span>
								</div>
							</td>
							<td class="td text-right">{n(c.changes)}</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="td text-ink-3">No commits in this window.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="mt-8 mb-4">
		<h2 class="section-title">Most frequently modified files</h2>
		<p class="mt-0.5 mb-3 text-sm text-ink-3">
			Commits touching each file. Tests, migrations, docs and lockfiles are left out.
		</p>
		<div class="grid gap-4 lg:grid-cols-2">
			{#each repos.filter((r) => r.topFiles.length) as r (r.repo)}
				{@const maxEdits = r.topFiles[0].edits}
				<div class="card p-5">
					<h3 class="mb-4 text-sm font-medium">{r.repo}</h3>
					<ol class="flex flex-col gap-2.5">
						{#each r.topFiles as f (f.path)}
							<li class="grid grid-cols-[minmax(0,1fr)_5.5rem_2rem] items-center gap-3">
								<span class="truncate font-mono text-xs text-ink-2" title={f.path}>{f.path}</span>
								<div class="h-1.5 rounded-full bg-raised">
									<div
										class="h-1.5 rounded-full bg-accent"
										style="width:{(f.edits / maxEdits) * 100}%"
									></div>
								</div>
								<span class="text-right text-xs text-ink-2 tabular-nums">{f.edits}</span>
							</li>
						{/each}
					</ol>
				</div>
			{/each}
		</div>
	</section>
{:catch error}
	<p class="card flex items-center gap-2 border-bad/30 px-4 py-3 text-sm text-bad">
		<TriangleAlert size={16} class="shrink-0" />
		Could not compute metrics: {error.message}
	</p>
{/await}
