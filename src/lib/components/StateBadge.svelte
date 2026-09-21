<script lang="ts">
	// Where the numbers on this page came from, and how fresh they are
	let {
		asOf = null,
		readOnly = false,
		state
	}: {
		asOf?: string | null;
		readOnly?: boolean;
		state: { backend: 'github' | 'local'; repo: string; commit: string | null; stale?: string };
	} = $props();

	function ago(iso: string) {
		const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} min ago`;
		if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
		return `${Math.round(minutes / 60 / 24)} d ago`;
	}
</script>

<p class="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
	<span class="h-1.5 w-1.5 rounded-full {state.stale ? 'bg-warn' : 'bg-good'}"></span>
	{#if asOf}
		Data as of {ago(asOf)}
	{:else}
		No data yet
	{/if}
	<span>· {readOnly ? 'read-only copy' : 'updated live from this machine'}</span>
	{#if state.backend === 'github'}
		<span>
			· shared state <span class="text-ink-2">{state.repo}</span>
			{#if state.commit}<code class="font-mono">{state.commit}</code>{/if}
		</span>
	{/if}
	{#if state.stale}
		<span class="text-warn">· GitHub could not be reached, showing the last copy</span>
	{/if}
</p>
