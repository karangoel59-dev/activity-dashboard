/**
 * Which repositories the dashboard covers: the ones found for the configured GitHub accounts, minus
 * the ones you switched off. Both live in the shared state, so a deployed copy shows (and can
 * change) the same selection as your machine.
 */
import fs from 'fs';
import { graphql, tokenForRepo, tokens } from './github';
import {
	isReadOnly,
	stateJson,
	stateRaw,
	stateRepo,
	stateText,
	updateState,
	type StateFiles
} from './state';

export interface RepoEntry {
	name: string;
	private: boolean;
	archived: boolean;
	fork: boolean;
	pushedAt: string;
	enabled: boolean;
}

type Discovered = Omit<RepoEntry, 'enabled'>;

interface DiscoveryFile {
	at: number;
	repos: Discovered[];
}

const SETTINGS = 'settings.json';
const DISCOVERED = 'discovered.json';
// Where these lived before the shared state existed; read once so nothing has to be redone
const LEGACY_SETTINGS = 'data/repos.json';
const LEGACY_DISCOVERED = 'data/discovered-repos.json';
const DISCOVERY_TTL = 1000 * 60 * 60;

let lastDiscovery: { at: number; error?: string } = { at: 0 };

function legacy<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8'));
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------- reading

const parse = <T>(text: string | undefined): T | undefined => {
	try {
		return text === undefined ? undefined : (JSON.parse(text) as T);
	} catch {
		return undefined;
	}
};

const discoveredFrom = (files: StateFiles): DiscoveryFile =>
	parse<DiscoveryFile>(files[DISCOVERED]) ??
	legacy<DiscoveryFile>(LEGACY_DISCOVERED, { at: 0, repos: [] });

/** The switched-off repositories, understanding the older settings formats too. */
function disabledFrom(text: string | undefined, discovered: Discovered[]): string[] {
	const raw =
		parse<string[] | { disabled?: string[]; autoDiscover?: boolean; manual?: string[] }>(text) ??
		legacy<string[] | { disabled?: string[]; autoDiscover?: boolean; manual?: string[] }>(
			LEGACY_SETTINGS,
			{}
		);
	if (Array.isArray(raw)) return []; // oldest format: a plain list of repos, all shown
	// Previous format: with auto-discovery off only the hand-picked repos were shown
	if (raw.autoDiscover === false) {
		const manual = new Set(raw.manual ?? []);
		return discovered.map((r) => r.name).filter((name) => !manual.has(name));
	}
	return raw.disabled ?? [];
}

/** Every discovered repo with its on/off state, for the checkbox list. */
export function listRepos(): { repos: RepoEntry[]; discoveredAt: number; discoveryError?: string } {
	const discovered =
		stateJson<DiscoveryFile | null>(DISCOVERED, null) ??
		legacy<DiscoveryFile>(LEGACY_DISCOVERED, { at: 0, repos: [] });
	const disabled = new Set(disabledFrom(stateRaw(SETTINGS), discovered.repos));
	return {
		repos: discovered.repos
			.filter((r) => r.name !== stateRepo())
			.map((r) => ({ ...r, enabled: !disabled.has(r.name) }))
			.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt)),
		discoveredAt: Math.max(discovered.at, lastDiscovery.at),
		discoveryError: lastDiscovery.error
	};
}

/** Repos to read: everything discovered that has not been unchecked. */
export function getRepos(): string[] {
	return listRepos()
		.repos.filter((r) => r.enabled)
		.map((r) => r.name);
}

// ---------------------------------------------------------------- changing the selection

function saveDisabled(change: (disabled: string[], all: string[]) => string[]) {
	return updateState(
		(files) => {
			const discovered = discoveredFrom(files).repos;
			const next = change(
				disabledFrom(files[SETTINGS], discovered),
				discovered.map((r) => r.name)
			);
			return { [SETTINGS]: stateText({ disabled: [...new Set(next)].sort() }, true) };
		},
		'Update repository selection',
		{ optimistic: true }
	);
}

/** Turn every repo of one owner (a user or an organisation) on or off at once. */
export async function setOwnerEnabled(owner: string, enabled: boolean) {
	await saveDisabled((disabled, all) => {
		const group = new Set(all.filter((name) => name.split('/')[0] === owner));
		const rest = disabled.filter((name) => !group.has(name));
		return enabled ? rest : [...rest, ...group];
	});
}

export async function setRepoEnabled(repo: string, enabled: boolean) {
	await saveDisabled((disabled) => {
		const rest = disabled.filter((name) => name !== repo);
		return enabled ? rest : [...rest, repo];
	});
}

// ---------------------------------------------------------------- discovery

const DISCOVER_QUERY = `query($after: String) {
	viewer {
		repositoriesContributedTo(
			first: 100
			after: $after
			includeUserRepositories: true
			contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY]
			orderBy: { field: PUSHED_AT, direction: DESC }
		) {
			pageInfo { hasNextPage endCursor }
			nodes { nameWithOwner isPrivate isArchived isFork pushedAt }
		}
	}
}`;

interface DiscoverResult {
	viewer: {
		repositoriesContributedTo: {
			pageInfo: { hasNextPage: boolean; endCursor: string };
			nodes: {
				nameWithOwner: string;
				isPrivate: boolean;
				isArchived: boolean;
				isFork: boolean;
				pushedAt: string;
			}[];
		};
	};
}

let discovering: Promise<void> | null = null;

const sameRepos = (a: Discovered[], b: Discovered[]) =>
	a.length === b.length &&
	a.every(
		(r) =>
			b.find((o) => o.name === r.name)?.private === r.private &&
			b.find((o) => o.name === r.name)?.archived === r.archived
	);

/**
 * Refresh the list of repos each configured account has committed to or opened PRs in.
 * Cheap enough to call on every page load: it does nothing until the last look is an hour old.
 * A failure keeps the previous list, so a bad token never empties the dashboard. A deployed copy
 * (read mode) never does this: it shows the list your machine published.
 */
export function refreshDiscovered({ force = false } = {}): Promise<void> {
	if (isReadOnly() || !tokens().length) return Promise.resolve();
	const known = stateJson<DiscoveryFile | null>(DISCOVERED, null);
	const last = Math.max(known?.at ?? 0, lastDiscovery.at);
	if (!force && Date.now() - last < DISCOVERY_TTL) return Promise.resolve();

	return (discovering ??= (async () => {
		try {
			const found = new Map<string, Discovered>();
			for (const token of tokens()) {
				let after: string | null = null;
				for (let page = 0; page < 10; page++) {
					const data: DiscoverResult = await graphql<DiscoverResult>(token, DISCOVER_QUERY, {
						after
					});
					const { nodes, pageInfo } = data.viewer.repositoriesContributedTo;
					for (const n of nodes) {
						// The state repository receives a commit for every publish; reporting on it would loop
						if (n.nameWithOwner === stateRepo()) continue;
						found.set(n.nameWithOwner, {
							name: n.nameWithOwner,
							private: n.isPrivate,
							archived: n.isArchived,
							fork: n.isFork,
							pushedAt: n.pushedAt
						});
						// Remember which account can see it so later calls skip the token guessing
						if (!tokenForRepo.has(n.nameWithOwner)) tokenForRepo.set(n.nameWithOwner, token);
					}
					if (!pageInfo.hasNextPage) break;
					after = pageInfo.endCursor;
				}
			}
			const repos = [...found.values()];
			lastDiscovery = { at: Date.now() };
			// Only publish a change in which repositories exist; a repo's last-push time moves hourly
			await updateState((files): Record<string, string | null> => {
				const old = discoveredFrom(files);
				return old.repos.length && sameRepos(old.repos, repos) && files[DISCOVERED]
					? {}
					: { [DISCOVERED]: stateText({ at: Date.now(), repos }, true) };
			}, 'Update discovered repositories');
		} catch (e) {
			console.error('Repo discovery failed:', e);
			lastDiscovery = { at: lastDiscovery.at, error: (e as Error).message };
		} finally {
			discovering = null;
		}
	})());
}
