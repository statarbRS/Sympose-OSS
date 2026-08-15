# Contributing

Thank you for helping improve Sympose.

## Development

1. Create a branch from `main`.
2. Install dependencies with `pnpm install --frozen-lockfile`.
3. Keep changes scoped and preserve workspace, event, role, publication, and artifact boundaries.
4. Run the focused tests for your change.
5. Before opening a pull request, run:

```bash
pnpm typecheck
pnpm test:unit
pnpm build
```

Run `pnpm e2e` when changing user journeys, authorization, uploads, scheduling, publication, or public
surfaces. Never commit `.env` files, databases, uploads, logs, provider credentials, or generated test
artifacts.

## Pull requests

Describe the user-visible outcome, changed trust boundaries, verification performed, and any known
limitations. Security-sensitive changes should include denial-path and cross-workspace evidence.
