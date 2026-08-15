# Sympose

Sympose is an open-source event operating system for calls for proposals, review, speaker operations,
content readiness, program scheduling, publication, and public event experiences.

Its distinguishing idea is simple: proposals, people, decisions, commitments, artifacts, schedules,
and releases remain durable relational objects throughout the event lifecycle. Organizers can work
through task-specific views without duplicating or silently rewriting the underlying records.

## Live demo

- Application: <https://ethical-opera-murphy-somewhere.trycloudflare.com>
- Guided walkthrough: <https://ethical-opera-murphy-somewhere.trycloudflare.com/walkthrough>
- Exact build identity: <https://ethical-opera-murphy-somewhere.trycloudflare.com/health>

The hosted demo contains synthetic evaluator data only. It runs behind a supervised Cloudflare Quick
Tunnel, so the hostname is suitable for evaluation but is not an uptime-backed production domain.

## Product journey

The demo covers:

1. Configure and publish a call for proposals.
2. Submit, revise, and track proposals.
3. Provision reviewers, collect scorecards, handle conflicts, and compare decisions.
4. Convert accepted work into speaker and session operations.
5. Track speaker tasks, messages, headshots, slides, versions, comments, and approvals.
6. Build and validate a room/track schedule.
7. Seal an immutable publication release and expose agenda, session, speaker, gallery, itinerary,
   JSON, and ICS surfaces.
8. Inspect cross-event people history, readiness, delivery evidence, and release drift.

## Run locally

Requirements:

- Node.js 22.13 or newer
- pnpm 9

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:3000>. The local evaluator uses repository-owned synthetic fixtures and a
SQLite database ignored by Git.

## Verify

```bash
pnpm typecheck
pnpm test:unit
pnpm build
```

Browser verification uses an isolated database and browser cache:

```bash
pnpm e2e:install
pnpm e2e
```

## Data and connector boundaries

The default evaluator is deliberately synthetic and makes no provider calls. Local SQLite and
filesystem storage keep the demo self-contained and reproducible.

The connector layer contains bounded Airtable, HubSpot, and Salesforce adapters behind explicit,
fail-closed production-network configuration. Provider tests use injected transports and do not call
external services. A real deployment still requires owner-supplied provider credentials and a
separately authorized provider smoke test before live interoperability should be claimed.

## Architecture

Sympose is a modular Next.js and TypeScript application with explicit workspace and event boundaries,
append-only decision and publication evidence, immutable artifact versions, and server-derived role
authorization. See [Architecture](docs/ARCHITECTURE.md) for the domain and runtime model and
[Demo guide](docs/DEMO.md) for the recommended evaluation path.

## Security and privacy

- The repository contains no production credentials or participant data.
- Synthetic identities use reserved example domains.
- Connector secrets are intended to be encrypted at rest and are never rendered back to the browser.
- Provider execution is fail-closed unless the server explicitly enables the production network mode.
- Uploaded artifacts remain scoped by workspace, event, person, task, and exact version.
- Public views read sealed release projections rather than organizer drafts.

The hosted demo is an evaluation environment, not a shared production service. Do not enter real
participant data or production credentials into it.

## License

Apache-2.0. See [LICENSE](LICENSE).
