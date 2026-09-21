<script lang="ts">
	import { Sparkles } from '@lucide/svelte';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';

	// `row` is a labelled switch for the sidebar; `icon` is a bare button for the phone top bar
	let { variant = 'icon' }: { variant?: 'icon' | 'row' } = $props();

	let enabled = $state(false);

	onMount(() => {
		enabled = document.cookie.includes('ai_insights_enabled=true');
	});

	function toggle() {
		enabled = !enabled;
		const maxAge = 60 * 60 * 24 * 365;
		document.cookie = `ai_insights_enabled=${enabled}; path=/; max-age=${maxAge}; samesite=strict`;
		// Re-run every page's load so summaries appear or disappear right away
		invalidateAll();
	}
</script>

{#if variant === 'row'}
	<button
		onclick={toggle}
		role="switch"
		aria-checked={enabled}
		title="Summarise and classify your work with the language model"
		class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-raised hover:text-ink"
	>
		<Sparkles size={18} class={enabled ? 'text-accent' : ''} />
		<span class="flex-1 text-left">AI insights</span>
		<span
			class="relative h-5 w-9 shrink-0 rounded-full transition-colors {enabled
				? 'bg-accent'
				: 'bg-line-strong'}"
		>
			<span
				class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform {enabled
					? 'translate-x-4'
					: ''}"
			></span>
		</span>
	</button>
{:else}
	<button
		onclick={toggle}
		aria-label="Toggle AI insights"
		aria-pressed={enabled}
		title={enabled ? 'Disable AI insights' : 'Enable AI insights'}
		class="rounded-lg p-2 text-ink-2 transition-colors hover:bg-raised hover:text-ink"
	>
		<Sparkles size={18} class={enabled ? 'text-accent' : 'opacity-60'} />
	</button>
{/if}
