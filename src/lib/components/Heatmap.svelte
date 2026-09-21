<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * Contribution calendar: one cell per day, weeks as columns, Monday first. One hue, darker for
	 * more. Values are also in each cell's accessible name and the tooltip.
	 */
	let {
		counts,
		from,
		to,
		unit = 'commit',
		cell: CELL = 14,
		gap: GAP = 4
	}: {
		counts: Record<string, number>;
		from: string;
		to: string;
		unit?: string;
		cell?: number;
		gap?: number;
	} = $props();

	const at = (s: string) => new Date(s + 'T12:00:00');
	/** YYYY-MM-DD plus n days, computed in UTC so daylight-saving shifts cannot skip a day. */
	const addDays = (date: string, n: number) => {
		const [y, m, d] = date.split('-').map(Number);
		return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
	};

	const weeks = $derived.by(() => {
		const start = addDays(from, -((at(from).getDay() + 6) % 7)); // back to Monday
		const out: { date: string; n: number; inRange: boolean }[][] = [];
		for (let first = start; first <= to; first = addDays(first, 7)) {
			out.push(
				Array.from({ length: 7 }, (_, i) => {
					const date = addDays(first, i);
					return { date, n: counts[date] ?? 0, inRange: date >= from && date <= to };
				})
			);
		}
		return out;
	});

	const max = $derived(Math.max(1, ...Object.values(counts)));
	const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));

	// Label a column when a new month starts in it
	const months = $derived(
		weeks.map((week, i) => {
			const m = at(week.find((c) => c.inRange)?.date ?? week[0].date).getMonth();
			const prev =
				i === 0
					? -1
					: at(weeks[i - 1].find((c) => c.inRange)?.date ?? weeks[i - 1][0].date).getMonth();
			return m !== prev
				? at(week.find((c) => c.inRange)?.date ?? week[0].date).toLocaleDateString('en-US', {
						month: 'short'
					})
				: '';
		})
	);

	let box: HTMLDivElement;
	let scroller: HTMLDivElement;
	let tip = $state<{ text: string; x: number; y: number } | null>(null);

	onMount(() => {
		scroller.scrollLeft = scroller.scrollWidth; // narrow screens: show the latest weeks first
	});

	function show(event: PointerEvent | FocusEvent, cell: { date: string; n: number }) {
		const target = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const host = box.getBoundingClientRect();
		const when = at(cell.date).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric'
		});
		tip = {
			text: `${cell.n} ${unit}${cell.n === 1 ? '' : 's'} · ${when}`,
			x: target.left - host.left + target.width / 2,
			y: target.top - host.top
		};
	}
</script>

<div class="relative" bind:this={box}>
	<div class="overflow-x-auto pb-1" bind:this={scroller}>
		<div class="flex w-max gap-2.5">
			<div
				class="flex flex-col pt-[18px] text-[10px] text-ink-3"
				style="gap:{GAP}px"
				aria-hidden="true"
			>
				{#each ['Mon', '', 'Wed', '', 'Fri', '', ''] as label, i (i)}
					<span style="height:{CELL}px; line-height:{CELL}px">{label}</span>
				{/each}
			</div>
			<div>
				<div
					class="flex text-[10px] text-ink-3"
					style="gap:{GAP}px; height:18px"
					aria-hidden="true"
				>
					{#each months as m, i (i)}
						<span class="overflow-visible whitespace-nowrap" style="width:{CELL}px">{m}</span>
					{/each}
				</div>
				<div
					class="grid"
					style="grid-template-rows:repeat(7,{CELL}px); grid-auto-flow:column; grid-auto-columns:{CELL}px; gap:{GAP}px"
				>
					{#each weeks as week, w (w)}
						{#each week as cell (cell.date)}
							{#if cell.inRange}
								<div
									class="rounded-[3px] transition-transform hover:scale-125"
									style="background:var(--heat-{level(cell.n)})"
									role="img"
									tabindex="-1"
									aria-label="{cell.date}: {cell.n} {unit}{cell.n === 1 ? '' : 's'}"
									onpointerenter={(e) => show(e, cell)}
									onpointerleave={() => (tip = null)}
								></div>
							{:else}
								<div></div>
							{/if}
						{/each}
					{/each}
				</div>
			</div>
		</div>
	</div>

	<div class="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-ink-3" aria-hidden="true">
		Less
		{#each [0, 1, 2, 3, 4] as l (l)}
			<span class="h-3 w-3 rounded-[3px]" style="background:var(--heat-{l})"></span>
		{/each}
		More
	</div>

	{#if tip}
		<div
			class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap text-ink shadow-lg"
			style="left:{tip.x}px; top:{tip.y - 6}px"
		>
			{tip.text}
		</div>
	{/if}
</div>
