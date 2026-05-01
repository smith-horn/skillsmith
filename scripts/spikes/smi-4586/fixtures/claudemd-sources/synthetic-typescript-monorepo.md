# CLAUDE.md - TypeScript Monorepo

This is a synthetic CLAUDE.md modeled on common open-source TypeScript monorepo
patterns. **SYNTHETIC** — provenance recorded in MANIFEST.json.

## Project layout

```
packages/
  api/        - Express HTTP API
  worker/     - Background job runner
  shared/     - Cross-package types and utilities
```

## Skills

This project uses the following Claude Code skills:

- **monorepo-builder** — Use when adding a new package, wiring up tsconfig
  references, or splitting code across packages.
- **db-migrator** — Use when authoring or reviewing Prisma migrations.
- **release-orchestrator** — Use when cutting a new release across packages.

## Trigger phrases

The following phrases activate this project's automation:

- "ship a release" — runs the release-orchestrator skill
- "add a package" — runs the monorepo-builder skill
- "create a migration" — runs the db-migrator skill
- "run preflight" — executes lint + typecheck + test in parallel
- "deploy to staging" — pushes the staging branch and triggers the deploy workflow
- "rollback the last deploy" — reverts the most recent deploy via the rollback workflow

## Use when

- **Use when** the user asks to bump versions across all packages.
- **Use when** the user wants to test a single package in isolation.
- **Use when** the user reports a flaky CI run.

## Commands

- `npm run preflight` — full local CI parity check
- `npm run test:single -- <package>` — run one package's tests
- `npm run release:dry-run` — preview the next release plan

## Standards

- Strict TypeScript only — no implicit `any`.
- All packages export ESM; CJS is generated via `tsup`.
- Every PR must include a changeset.
