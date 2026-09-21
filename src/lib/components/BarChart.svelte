<script lang="ts">
	/**
	 * Column chart for one series. Thin capped columns with a 4px rounded top, hairline grid, a
	 * tooltip on hover or keyboard focus, and a hidden table so the values never depend on hover.
	 */
	type Datum = { label: string; short?: string; value: number; note?: string };

	let {
		data,
		height = 176,
		unit = '',
		format = (n: number) => n.toLocaleString('en-US')
	}: { data: Datum[]; height?: number; unit?: string; format?: (n: number) => string } = $props();

	let active = $state<number | null>(null);

	// Round the top of the axis up to a clean number (1, 2, 2.5, 5, 10 × a power of ten)
	const top = $derived.by(() => {
		const max = Math.max(...data.map((d) => d.value), 1);
		const pow = 10 ** Math.floor(Math.log10(max));
		const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= max) ?? 10;
		return step * pow;
	});
	const ticks = $derived([0, top / 2, top]);
</script>

<div class="select-none">
	<div class="relative" style="height:{height}px">
		{#each ticks as tick (tick)}
			<div class="absolute inset-x-0 border-t border-line" style="bottom:{(tick / top) * 100}%">
				<span class="absolute -top-2 left-0 bg-surface pr-1.5 text-[10px] text-ink-3 tabular-nums"
					>{format(tick)}</span
				>
			</div>
		{/each}

		<div class="absolute inset-0 flex items-end gap-1.5 pl-9 sm:gap-3">
			{#each data as d, i (d.label)}
				<!-- Focusable on purpose: the tooltip must be reachable without a mouse -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					class="relative flex h-full flex-1 items-end justify-center"
					role="img"
					tabindex="0"
					aria-label="{d.label}: {format(d.value)} {unit}"
					onpointerenter={() => (active = i)}
					onpointerleave={() => (active = null)}
					onfocus={() => (active = i)}
					onblur={() => (active = null)}
				>
					<div
						class="w-full max-w-6 rounded-t-[4px] bg-accent transition-opacity"
						style="height:{(d.value / top) * 100}%; opacity:{active === null || active === i
							? 1
							: 0.4}"
					></div>
					{#if active === i}
						<div
							class="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 whitespace-nowrap shadow-lg"
							style="bottom: calc({(d.value / top) * 100}% + 8px)"
						>
							<p class="text-sm leading-tight font-semibold text-ink">
								{format(d.value)}
								<span class="font-normal text-ink-3">{unit}</span>
							</p>
							<p class="text-xs text-ink-2">{d.label}</p>
							{#if d.note}<p class="mt-0.5 max-w-52 text-[11px] whitespace-normal text-ink-3">
									{d.note}
								</p>{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<div class="mt-2 flex gap-1.5 pl-9 sm:gap-3" aria-hidden="true">
		{#each data as d (d.label)}
			<span class="flex-1 text-center text-[11px] text-ink-3">{d.short ?? d.label}</span>
		{/each}
	</div>

	<table class="sr-only">
		<caption>{unit}</caption>
		<tbody>
			{#each data as d (d.label)}
				<tr><th scope="row">{d.label}</th><td>{format(d.value)}</td></tr>
			{/each}
		</tbody>
	</table>
</div>
