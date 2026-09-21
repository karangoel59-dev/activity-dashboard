<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import AIToggle from '$lib/components/AIToggle.svelte';
	import { ScrollText, Code2, GitCommitHorizontal, ChartColumnBig } from '@lucide/svelte';

	let { children } = $props();

	const navItems = [
		{ name: 'Activity', path: '/activity', icon: GitCommitHorizontal, hint: 'What you shipped' },
		{ name: 'Metrics', path: '/metrics', icon: ChartColumnBig, hint: 'Numbers and trends' },
		{ name: 'Journal', path: '/logs', icon: ScrollText, hint: 'Your writing' }
	] as const;

	const isActive = (path: string) => page.url.pathname.startsWith(path);
</script>

<div class="min-h-screen">
	<!-- Sidebar: desktop -->
	<aside
		class="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-surface px-3 py-5 md:flex"
	>
		<a href={resolve('/activity')} class="mb-7 flex items-center gap-2.5 px-2.5">
			<span
				class="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink shadow-sm"
			>
				<Code2 size={18} />
			</span>
			<span class="leading-tight">
				<span class="block text-sm font-semibold tracking-tight">karangoel59-dev</span>
				<span class="block text-[11px] text-ink-3">Work dashboard</span>
			</span>
		</a>

		<nav class="flex flex-col gap-0.5" aria-label="Main">
			{#each navItems as item (item.path)}
				{@const Icon = item.icon}
				<a
					href={resolve(item.path)}
					aria-current={isActive(item.path) ? 'page' : undefined}
					class="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors {isActive(
						item.path
					)
						? 'bg-accent/10 text-accent'
						: 'text-ink-2 hover:bg-raised hover:text-ink'}"
				>
					<Icon size={18} />
					<span class="flex-1">{item.name}</span>
					<span
						class="text-[11px] font-normal text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
						>{item.hint}</span
					>
				</a>
			{/each}
		</nav>

		<div class="mt-auto flex flex-col gap-0.5 border-t border-line pt-3">
			<AIToggle variant="row" />
			<ThemeToggle variant="row" />
		</div>
	</aside>

	<!-- Top bar: phones -->
	<header
		class="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-bg/85 px-4 py-2.5 backdrop-blur md:hidden"
	>
		<a href={resolve('/activity')} class="flex items-center gap-2">
			<span class="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-ink">
				<Code2 size={16} />
			</span>
			<span class="text-sm font-semibold tracking-tight">karangoel59-dev</span>
		</a>
		<div class="flex items-center gap-1">
			<AIToggle />
			<ThemeToggle />
		</div>
	</header>

	<main class="md:pl-60">
		<div class="mx-auto w-full max-w-6xl px-4 pt-6 pb-28 sm:px-8 md:pt-10 md:pb-16">
			{@render children()}
		</div>
	</main>

	<!-- Tab bar: phones -->
	<nav
		class="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur md:hidden"
		style="padding-bottom: env(safe-area-inset-bottom, 0px);"
		aria-label="Main"
	>
		<div class="flex h-16 items-stretch justify-around">
			{#each navItems as item (item.path)}
				{@const Icon = item.icon}
				<a
					href={resolve(item.path)}
					aria-current={isActive(item.path) ? 'page' : undefined}
					class="flex flex-1 flex-col items-center justify-center gap-1 transition-colors {isActive(
						item.path
					)
						? 'text-accent'
						: 'text-ink-3 hover:text-ink'}"
				>
					<Icon size={20} />
					<span class="text-[10px] font-medium">{item.name}</span>
				</a>
			{/each}
		</div>
	</nav>
</div>
