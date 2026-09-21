/**
 * LLM classification of commits and PRs into technical domains and work types.
 * Domains are proposed once from the work itself and saved, so every item is judged against
 * the same taxonomy; per-item results are cached against that taxonomy.
 */
import crypto from 'crypto';
import { chat } from './aiCommentator';
import { readJson } from './localjson';
import { isReadOnly, stateJson, stateRaw, stateText, updateState } from './state';

// Both live in the shared state, so a deployed copy shows what your machine classified
const INSIGHTS = 'insights.json';

interface InsightsFile {
	taxonomy: Domain[];
	classifications: Record<string, Classification>;
}

// What earlier versions kept in local files; imported into the state once
const earlier = (): InsightsFile => ({
	taxonomy: readJson<{ domains: Domain[] }>('data/taxonomy.json', { domains: [] }).domains,
	classifications: readJson<Record<string, Classification>>('data/classifications.json', {})
});

const insights = () => stateJson<InsightsFile | null>(INSIGHTS, null) ?? earlier();

/** Current file contents to build an update on: the state's, or the earlier local ones. */
const currentFile = (files: Record<string, string>): InsightsFile =>
	files[INSIGHTS] ? (JSON.parse(files[INSIGHTS]) as InsightsFile) : earlier();

async function importEarlier() {
	const old = earlier();
	if (stateRaw(INSIGHTS) !== undefined || isReadOnly()) return;
	if (!old.taxonomy.length && !Object.keys(old.classifications).length) return;
	await updateState(
		(files) => (files[INSIGHTS] ? {} : { [INSIGHTS]: stateText(old) }),
		'Import earlier classifications'
	);
}

export const WORK_TYPES = [
	{
		name: 'New Features & Enhancements',
		description: 'New APIs, pipelines, adapters, UI, schemas'
	},
	{ name: 'Bug Fixes & Hotfixes', description: 'Resolving errors, broken behaviour, regressions' },
	{ name: 'Governance, Billing & Security', description: 'Safety nets, metering, PII, auth' },
	{ name: 'Refactoring & Code Quality', description: 'Modularisation, cleanup, restructuring' },
	{ name: 'Performance & Concurrency', description: 'Speedups, async, query tuning, caching' },
	{ name: 'Infrastructure & Migration', description: 'Deploys, Docker, CI, data/store migrations' },
	{ name: 'Testing, Tooling & Docs', description: 'Tests, scripts, specs, documentation' }
];

export interface Domain {
	name: string;
	description: string;
}

export interface WorkItem {
	id: string; // commit sha or "repo#number" for PRs
	text: string; // what the LLM sees: message/title, branch, main files
}

export interface Classification {
	domain: string;
	type: string;
}

export const getTaxonomy = (): Domain[] => insights().taxonomy;

/** Forget the domains, so the next run proposes a fresh set. */
export async function resetTaxonomy() {
	await updateState(
		(files) => ({
			[INSIGHTS]: stateText({ ...currentFile(files), taxonomy: [] })
		}),
		'Reset classification domains'
	);
}

async function proposeTaxonomy(items: WorkItem[]): Promise<Domain[]> {
	// An even sample across the window keeps early and late work represented
	const step = Math.max(1, Math.floor(items.length / 300));
	const sample = items.filter((_, i) => i % step === 0).slice(0, 300);

	const response = await chat(
		`You categorise a software engineer's work into technical domains for a performance review.
Given commit and pull request descriptions, propose 6 to 10 domains that together cover the work.
Name domains after the product area or capability (e.g. "Vector Store & Qdrant Migration"), not the activity type
(bug fix / feature / refactor are tracked separately). Domains must not overlap.
Respond with JSON: {"domains":[{"name":"...","description":"one line on what belongs here"}]}`,
		sample.map((item) => `- ${item.text}`).join('\n'),
		1200,
		{ json: true, temperature: 0.2 }
	);
	const domains: Domain[] = JSON.parse(response).domains || [];
	if (!domains.length) throw new Error('LLM proposed no domains');
	return domains;
}

async function classifyBatch(
	items: WorkItem[],
	domains: Domain[]
): Promise<Record<string, Classification>> {
	const response = await chat(
		`Classify each work item into exactly one domain and one work type.
Domains:
${domains.map((d) => `- ${d.name}: ${d.description}`).join('\n')}
Work types:
${WORK_TYPES.map((t) => `- ${t.name}: ${t.description}`).join('\n')}
Use the names exactly as written. Respond with JSON: {"results":[{"n":0,"domain":"...","type":"..."}]}`,
		// Items are numbered by position: models tend to shorten ids like "owner/repo#123" to "123"
		items.map((item, n) => `[${n}] ${item.text}`).join('\n'),
		60 * items.length + 200,
		{ json: true, temperature: 0 }
	);

	const domainNames = new Set(domains.map((d) => d.name));
	const typeNames = new Set(WORK_TYPES.map((t) => t.name));
	const out: Record<string, Classification> = {};
	for (const r of JSON.parse(response).results || []) {
		const item = items[Number(r.n)];
		if (!item) continue;
		out[item.id] = {
			domain: domainNames.has(r.domain) ? r.domain : 'Other',
			type: typeNames.has(r.type) ? r.type : 'Other'
		};
	}
	return out;
}

/**
 * Domain and work type for every item, calling the LLM only for items not yet classified. A
 * deployed copy (read mode) never calls it: it uses what your machine already classified.
 */
export async function classify(items: WorkItem[]): Promise<{
	domains: Domain[];
	results: Record<string, Classification>;
}> {
	await importEarlier();
	let domains = getTaxonomy();
	if (!domains.length && !isReadOnly() && items.length) {
		domains = await proposeTaxonomy(items);
		await updateState(
			(files) => ({
				[INSIGHTS]: stateText({
					...currentFile(files),
					taxonomy: domains
				})
			}),
			'Set classification domains'
		);
	}

	const taxonomyKey = crypto
		.createHash('sha1')
		.update(JSON.stringify(domains))
		.digest('hex')
		.slice(0, 8);
	const cache = { ...insights().classifications };
	const key = (id: string) => `${taxonomyKey}:${id}`;

	const missing =
		isReadOnly() || !domains.length ? [] : items.filter((item) => !cache[key(item.id)]);
	const batches: WorkItem[][] = [];
	for (let i = 0; i < missing.length; i += 40) batches.push(missing.slice(i, i + 40));

	// A few batches in flight at once; a failed batch is retried on the next page load
	for (let i = 0; i < batches.length; i += 4) {
		const learned: Record<string, Classification> = {};
		await Promise.all(
			batches.slice(i, i + 4).map(async (batch) => {
				try {
					for (const [id, c] of Object.entries(await classifyBatch(batch, domains))) {
						learned[key(id)] = c;
					}
				} catch (e) {
					console.error('Classification batch failed:', e);
				}
			})
		);
		Object.assign(cache, learned);
		if (Object.keys(learned).length) {
			await updateState(
				(files) => {
					const current = currentFile(files);
					// Only the current domains' answers are worth keeping
					const kept = Object.fromEntries(
						Object.entries(current.classifications ?? {}).filter(([k]) =>
							k.startsWith(taxonomyKey + ':')
						)
					);
					return {
						[INSIGHTS]: stateText({
							taxonomy: current.taxonomy ?? domains,
							classifications: { ...kept, ...learned }
						})
					};
				},
				`Classify ${Object.keys(learned).length} item(s)`
			).catch((e) => console.error('Saving classifications failed:', e));
		}
	}

	return {
		domains,
		results: Object.fromEntries(
			items.filter((item) => cache[key(item.id)]).map((item) => [item.id, cache[key(item.id)]])
		)
	};
}
