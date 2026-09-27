# Work dashboard

A personal dashboard built from your git history: what you shipped each day, the numbers behind a
quarter of work, and your writing from [Forward Flow](https://github.com/karangoel59-dev/forward-flow).
SvelteKit (Svelte 5), Tailwind 4.

| Page         | What it shows                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Activity** | Your commits from every branch of every repository, by day: a calendar, a per-repository breakdown, a branch filter (`prod-v1.1.0`, `stage-…`, `uat`…), and an optional AI summary of each day. |
| **Metrics**  | Pull requests, commits, lines touched, cadence, month-over-month charts, contribution share of each repository, and (with AI) where the effort went by domain and work type. Any date range.    |
| **Journal**  | Your Forward Flow entries as cards, read from their GitHub repository.                                                                                                                          |

## How it works

```
 your machine                    GitHub (private)                     hosted copy
┌──────────────────┐  publish   ┌───────────────────────┐   read     ┌────────────────────┐
│ git clones       │ ─────────▶ │ <you>/dashboard-state │ ─────────▶ │ Railway            │
│ full mode        │ ◀───────── │  facts/, settings, …  │ ◀───────── │ read mode          │
└──────────────────┘   read     └───────────────────────┘  small     └────────────────────┘
                                                            updates
```

- **Facts.** For each repository the dashboard keeps _facts_: your commits with their branches and
  file changes, your pull requests, and daily totals. They are independent of any date range, so
  every page computes its view from them, and a copy with no clones shows the same numbers as your
  machine.
- **The state repository** (`STATE_REPO`) is the one place facts, AI summaries, classifications and
  your repository selection are kept. It is read in one request, cached by its latest commit, and
  written as one atomic commit that refuses to overwrite a newer update from elsewhere.
  **It contains work commit messages and file paths: keep it private.**
- **Full mode** (default) runs where the git clones are. It keeps the clones fresh, rebuilds the
  facts (within a minute of a new commit) and publishes them. Repository selection is saved
  optimistically, so ticking a box is instant.
- **Read mode** (`DASHBOARD_MODE=read`) needs no clones, no git and no AI keys: it only displays the
  published state, and can still change your repository selection.

Without `STATE_REPO` everything is kept in `data/state/` and the dashboard works fully on one
machine.

## Setup

```sh
npm install
cp .env.example .env    # then fill in the values below
npm run dev
```

### Running with Docker (Local)

To run the application locally inside Docker:

```sh
# Start the container (builds automatically on first run)
docker compose up -d --build

# View logs
docker compose logs -f

# Stop the container
docker compose down
```

The app will be running at `http://localhost:8080`. Your git mirrors and cached state are persisted in `./data` via a mounted volume.

### Configuration

| Variable                                        | Needed for  | Meaning                                                                                                                                         |
| ----------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                                  | everything  | A token, or several separated by commas (one per GitHub account). Needs read access to your repositories; write access to the state repository. |
| `STATE_REPO`                                    | sharing     | `owner/name` of the private state repository. Create it empty (with a README) first.                                                            |
| `DASHBOARD_MODE`                                | hosting     | `read` for a hosted copy; leave unset on your machine.                                                                                          |
| `DASHBOARD_PASSWORD`                            | hosting     | When set, every request needs it (HTTP Basic: any username, this password). **Set this on anything reachable from the internet.**               |
| `GIT_AUTHOR_EMAILS`                             | full mode   | Commit emails GitHub cannot tie to an account, e.g. `me@gmail.com`. Comma separated.                                                            |
| `FFLOW_REPO`                                    | Journal     | `owner/name` of the repository Forward Flow syncs entries to.                                                                                   |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` | AI insights | Optional. Only your machine needs them; a hosted copy shows what it already produced.                                                           |
| `JIRA_PROJECTS`                                 | Metrics     | Optional, e.g. `AA,CPD`: count only these ticket prefixes.                                                                                      |

Timezones need no setting: days are grouped in the timezone of the machine that collected the
facts, and every copy follows it.

## Deploying to Railway

1. Create the state repository once and run the dashboard locally with `STATE_REPO` set; open
   Activity and Metrics so the facts are collected and published.
2. Create a Railway service from this repository (the `Dockerfile` is used) and set:

   ```
   DASHBOARD_MODE=read
   DASHBOARD_PASSWORD=<something long>
   STATE_REPO=<you>/dashboard-state
   FFLOW_REPO=<you>/fflow
   GITHUB_TOKEN=<token: contents read+write on the state repo, read on the Forward Flow repo>
   ```

3. No volume is needed: the state repository is the storage.

The hosted copy updates within about 15 seconds of your machine publishing.

## Project layout

```
src/lib/server/
  state.ts     shared state: GitHub-backed store, atomic writes, optimistic changes
  facts.ts     collects facts from the clones and GitHub; keeps them fresh; publishes
  activity.ts  Activity view and AI day summaries
  metrics.ts   Metrics view over the facts
  classify.ts  LLM domain / work-type classification
  repos.ts     which repositories are covered, and your selection
  github.ts    GitHub client with retries; who you are
  mirror.ts    local bare clones used by the collector
  authors.ts   which commit emails belong to your accounts
  flow.ts      Forward Flow entries for the Journal
src/hooks.server.ts   password check, state refresh, timezone
```

## Scripts

`npm run dev` · `npm run build` · `npm run check` (types) · `npm run lint`
