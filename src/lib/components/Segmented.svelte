<script lang="ts">
	import { resolve } from '$app/paths';

	/** A row of mutually exclusive links to one page with different query strings, e.g. a date range. */
	let {
		base,
		items,
		label
	}: {
		base: '/activity' | '/metrics';
		items: { label: string; query: string; active: boolean }[];
		label: string;
	} = $props();
</script>

<div
	class="inline-flex rounded-lg border border-line bg-raised p-0.5 text-sm"
	role="group"
	aria-label={label}
>
	{#each items as item (item.label)}
		<a
			href="{resolve(base)}{item.query}"
			aria-current={item.active ? 'true' : undefined}
			class="rounded-md px-3 py-1 font-medium transition-colors {item.active
				? 'bg-surface text-ink shadow-sm'
				: 'text-ink-2 hover:text-ink'}">{item.label}</a
		>
	{/each}
</div>
