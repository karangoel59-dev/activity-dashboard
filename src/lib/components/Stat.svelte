<script lang="ts">
	import type { Component } from 'svelte';

	let {
		label,
		value,
		sub = '',
		icon,
		spark
	}: {
		label: string;
		value: string;
		sub?: string;
		icon?: Component<{ size?: number; class?: string }>;
		spark?: number[];
	} = $props();

	const W = 96;
	const H = 32;
	const points = $derived.by(() => {
		if (!spark || spark.length < 2) return [];
		const max = Math.max(...spark, 1);
		return spark.map((v, i) => [
			(i / (spark.length - 1)) * (W - 8) + 4,
			H - 6 - (v / max) * (H - 12)
		]);
	});
	const line = $derived(points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
	const last = $derived(points.at(-1));
</script>

<div class="card flex flex-col gap-1 p-4">
	<div class="flex items-center gap-1.5 text-xs font-medium text-ink-3">
		{#if icon}
			{@const Icon = icon}
			<Icon size={14} />
		{/if}
		{label}
	</div>
	<div class="flex items-end justify-between gap-2">
		<!-- proportional figures: a big standalone number reads better than a tabular one -->
		<p class="text-[28px] leading-9 font-semibold tracking-tight text-ink">{value}</p>
		{#if points.length}
			<svg
				viewBox="0 0 {W} {H}"
				width={W}
				height={H}
				class="mb-1 shrink-0 overflow-visible"
				aria-hidden="true"
			>
				<polygon
					points="{points[0][0]},{H - 2} {line} {points.at(-1)![0]},{H - 2}"
					fill="var(--accent)"
					opacity="0.1"
				/>
				<polyline
					points={line}
					fill="none"
					stroke="var(--accent)"
					stroke-width="2"
					stroke-linejoin="round"
					stroke-linecap="round"
				/>
				{#if last}
					<circle
						cx={last[0]}
						cy={last[1]}
						r="4"
						fill="var(--accent)"
						stroke="var(--surface)"
						stroke-width="2"
					/>
				{/if}
			</svg>
		{/if}
	</div>
	{#if sub}<p class="text-xs text-ink-3">{sub}</p>{/if}
</div>
