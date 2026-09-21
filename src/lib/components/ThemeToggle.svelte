<script lang="ts">
	import { onMount } from 'svelte';
	import { Moon, Sun } from '@lucide/svelte';

	// `row` fills a sidebar row with a label; `icon` is a bare button for tight spaces
	let { variant = 'icon' }: { variant?: 'icon' | 'row' } = $props();

	let isDark = $state(false);

	onMount(() => {
		isDark = document.documentElement.classList.contains('dark');
	});

	function toggleTheme() {
		isDark = !isDark;
		document.documentElement.classList.toggle('dark', isDark);
		try {
			localStorage.theme = isDark ? 'dark' : 'light';
		} catch {
			/* private mode: the choice just will not persist */
		}
	}
</script>

<button
	onclick={toggleTheme}
	class={variant === 'row'
		? 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-raised hover:text-ink'
		: 'rounded-lg p-2 text-ink-2 transition-colors hover:bg-raised hover:text-ink'}
	aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
>
	{#if isDark}
		<Sun size={18} />
	{:else}
		<Moon size={18} />
	{/if}
	{#if variant === 'row'}{isDark ? 'Light theme' : 'Dark theme'}{/if}
</button>
