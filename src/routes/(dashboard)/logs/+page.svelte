<script lang="ts">
	import { resolve } from '$app/paths';
	import { marked } from 'marked';
	import { ArrowLeftRight, BookOpen, Search, TriangleAlert } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { getPillColor } from '$lib/utils';

	let { data } = $props();

	let query = $state('');
	let activeTag = $state('');
	let sort = $state<'desc' | 'asc'>('desc');

	// Long entries are clamped on their card until expanded
	const CLAMP_WORDS = 90;
	let expanded = $state<Record<string, boolean>>({});

	const byId = $derived(Object.fromEntries(data.entries.map((e) => [e.id, e])));
	const totalWords = $derived(data.entries.reduce((sum, e) => sum + e.words, 0));

	const tagCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const entry of data.entries)
			for (const tag of entry.tags) counts[tag] = (counts[tag] || 0) + 1;
		return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	});

	// A query starting with # matches tags only; anything else matches date, prose and tags together
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const tagsOnly = q.startsWith('#');
		const needle = tagsOnly ? q.slice(1).trim() : q;

		const rows = data.entries.filter((entry) => {
			if (activeTag && !entry.tags.includes(activeTag)) return false;
			if (!needle) return true;
			const inTags = entry.tags.some((tag) => tag.includes(needle));
			return tagsOnly
				? inTags
				: inTags || entry.id.includes(needle) || entry.body.toLowerCase().includes(needle);
		});
		return sort === 'desc' ? rows : [...rows].reverse();
	});

	const localDay = (iso: string) => {
		const date = new Date(iso);
		return isNaN(date.getTime()) ? iso.slice(0, 10) : date.toLocaleDateString('en-CA');
	};

	const days = $derived.by(() => {
		const groups: Record<string, typeof filtered> = {};
		for (const entry of filtered) (groups[localDay(entry.created)] ??= []).push(entry);
		return Object.entries(groups);
	});

	function timeAgo(iso: string) {
		const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} min ago`;
		if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
		return `${Math.round(minutes / 60 / 24)} d ago`;
	}

	const dayLabel = (day: string) =>
		new Date(day + 'T12:00:00').toLocaleDateString('en-US', {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		});

	const time = (iso: string) => {
		const date = new Date(iso);
		return isNaN(date.getTime())
			? ''
			: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	};

	// First few words as plain text: markdown markers would just be noise in a one-line link
	const preview = (body: string) => {
		const words = body
			.replace(/^[#>\-*+\s]+/gm, '')
			.replace(/[*_`]/g, '')
			.split(/\s+/)
			.filter(Boolean);
		return words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '');
	};
</script>

<svelte:head>
	<title>Journal</title>
</svelte:head>

<PageHeader title="Journal" description="Your writing, from Forward Flow.">
	{#snippet actions()}
		{#if data.source}
			<p class="flex max-w-[26rem] items-center gap-1.5 text-xs text-ink-3">
				<span
					class="h-1.5 w-1.5 rounded-full {data.source.kind === 'github' ? 'bg-good' : 'bg-warn'}"
				></span>
				{#if data.source.kind === 'github'}
					<span class="font-medium text-ink-2">{data.source.label}</span>
					· <code class="font-mono">{data.source.commit}</code>
					{#if data.source.committedAt}· updated {timeAgo(data.source.committedAt)}{/if}
				{:else}
					<span class="shrink-0">Local folder</span>
					<code class="truncate font-mono" title={data.source.label}>{data.source.label}</code>
				{/if}
			</p>
		{/if}
	{/snippet}
</PageHeader>

{#if !data.source}
	<div class="card mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-14 text-center">
		<BookOpen size={28} class="text-ink-3" />
		<p class="font-medium">No Forward Flow entries found</p>
		{#if data.error}<p class="text-sm text-bad">{data.error}</p>{/if}
		<p class="text-sm text-ink-3">
			Set <code class="font-mono text-xs">FFLOW_REPO</code> to the GitHub repository Forward Flow
			syncs to (for example <code class="font-mono text-xs">you/fflow</code>), together with a
			<code class="font-mono text-xs">GITHUB_TOKEN</code> that can read it.
		</p>
	</div>
{:else}
	{#if data.warning}
		<p class="card mb-4 flex items-start gap-2 border-warn/30 px-4 py-3 text-sm text-warn">
			<TriangleAlert size={16} class="mt-0.5 shrink-0" />
			{data.warning}
		</p>
	{/if}

	<div class="mb-8 flex flex-col gap-3">
		<div class="flex flex-wrap items-center gap-3">
			<div class="relative min-w-0 basis-full sm:max-w-md sm:flex-1 sm:basis-0">
				<Search
					size={16}
					class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
				/>
				<input
					id="search"
					type="search"
					bind:value={query}
					placeholder="Search words, a date, or #tag"
					aria-label="Search entries"
					class="field w-full py-2 pl-9"
				/>
			</div>
			<select bind:value={sort} aria-label="Order" class="field py-2">
				<option value="desc">Newest first</option>
				<option value="asc">Oldest first</option>
			</select>
			<p class="ml-auto text-xs text-ink-3 tabular-nums">
				{data.entries.length} entries · {totalWords.toLocaleString('en-US')} words
			</p>
		</div>

		{#if tagCounts.length}
			<div class="flex flex-wrap gap-2">
				{#each tagCounts as [tag, count] (tag)}
					<button
						type="button"
						onclick={() => (activeTag = activeTag === tag ? '' : tag)}
						aria-pressed={activeTag === tag}
						class="chip px-2.5 py-1 transition-colors {activeTag === tag
							? 'bg-accent text-accent-ink'
							: getPillColor(tag)}"
					>
						#{tag} <span class="opacity-60">{count}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="flex flex-col gap-10">
		{#each days as [day, entries] (day)}
			<section>
				<h2 class="mb-4 flex items-center gap-3 text-sm font-semibold text-ink-2">
					{dayLabel(day)}
					<span class="h-px flex-1 bg-line"></span>
					<span class="text-xs font-normal text-ink-3"
						>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span
					>
				</h2>

				<div class="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
					{#each entries as entry (entry.id)}
						{@const long = entry.words > CLAMP_WORDS}
						{@const clamped = long && !expanded[entry.id]}
						<article
							id="e-{entry.id}"
							class="card rise flex scroll-mt-24 flex-col gap-3 p-5 transition-[box-shadow,border-color] hover:border-line-strong hover:shadow-md"
						>
							<header class="flex items-center justify-between text-xs text-ink-3">
								<span class="font-medium text-ink-2 tabular-nums">{time(entry.created)}</span>
								<span class="tabular-nums"
									>{entry.words} {entry.words === 1 ? 'word' : 'words'}</span
								>
							</header>

							{#if entry.body}
								<div class="relative">
									<div
										class="prose-app prose max-w-none font-serif text-[15.5px] leading-7 prose-headings:font-serif prose-p:my-2 {clamped
											? 'max-h-60 overflow-hidden'
											: ''}"
									>
										<!-- eslint-disable-next-line svelte/no-at-html-tags -->
										{@html marked.parse(entry.body, { breaks: true, async: false })}
									</div>
									{#if clamped}
										<div
											class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-surface to-transparent"
										></div>
									{/if}
								</div>
								{#if long}
									<button
										type="button"
										onclick={() => (expanded[entry.id] = !expanded[entry.id])}
										class="self-start text-xs font-medium text-accent hover:underline"
									>
										{expanded[entry.id] ? 'Show less' : 'Show more'}
									</button>
								{/if}
							{:else}
								<p class="text-sm text-ink-3 italic">Empty entry</p>
							{/if}

							{#if entry.tags.length || entry.related.length}
								<footer class="flex flex-col gap-2 border-t border-line pt-3">
									{#if entry.tags.length}
										<div class="flex flex-wrap gap-1.5">
											{#each entry.tags as tag (tag)}
												<button
													type="button"
													onclick={() => (activeTag = tag)}
													class="chip transition-opacity hover:opacity-80 {getPillColor(tag)}"
													>#{tag}</button
												>
											{/each}
										</div>
									{/if}
									{#each entry.related as id (id)}
										<a
											href="{resolve('/logs')}#e-{id}"
											class="flex items-center gap-1.5 truncate text-xs text-ink-3 transition-colors hover:text-accent"
										>
											<ArrowLeftRight size={12} class="shrink-0" />
											<span class="truncate"
												>{localDay(byId[id].created)} · {preview(byId[id].body)}</span
											>
										</a>
									{/each}
								</footer>
							{/if}
						</article>
					{/each}
				</div>
			</section>
		{:else}
			<div class="card flex flex-col items-center gap-2 px-6 py-14 text-center">
				<BookOpen size={28} class="text-ink-3" />
				<p class="font-medium">{data.entries.length ? 'No entries match' : 'No entries yet'}</p>
				{#if data.entries.length}
					<p class="text-sm text-ink-3">Try different words, or clear the tag filter.</p>
				{/if}
			</div>
		{/each}
	</div>
{/if}
