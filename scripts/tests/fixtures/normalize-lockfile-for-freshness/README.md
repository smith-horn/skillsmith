# normalize-lockfile-for-freshness fixtures

Committed slices of real `package-lock.json` content, consumed by
`scripts/tests/normalize-lockfile-for-freshness.test.ts` (SMI-6496 Fix 2).

## Why these are files, not live `git show`

The test originally read three real commits (`0d4f294bc`, `08d8cacb0`,
`c51db0a83`) directly via `git show <rev>:package-lock.json`. That passed on
the host but failed under `./scripts/worktree-docker.sh exec` — pre-push runs
tests inside the container, where `/app`'s `.git` is a worktree gitdir file
pointing at an **absolute host path** (`git worktree add` always writes one;
there is no flag to make it relative). That host path does not exist inside
the container, so `git -C /app show <rev>:<path>` fails with `fatal: not a
git repository` for every worktree container, unconditionally. Not a fixable
test bug — a structural property of how this repo's worktree containers see
git. The fix is to not depend on live git history in-container at all.

## Fixture contract

- Each `.package-lock.json` file is a **trimmed** slice of the real lockfile
  at the named commit — only the `packages[]` entries that actually changed
  between parent and child are kept, with values copied verbatim (never
  invented). Commit SHAs and PR context live in the table below, not inside
  the JSON — an earlier draft embedded a `_fixtureProvenance` string as a
  top-level key and it broke Case 1's own assertion: `computeShadowHash`
  hashes the WHOLE parsed object, not just `packages`, so two fixture files
  whose only "real" difference is inside `packages` (which the algorithm
  correctly neutralizes to identical) still hashed differently, because the
  provenance text itself differed between the parent and child file. Caught
  by actually running the comparison before trusting it, not by inspection —
  keep it that way: never add a metadata field to these files that isn't
  present in a real npm-generated lockfile.
- `package.json` (`{"workspaces": ["packages/*"]}`) is shared by all three
  pairs — confirmed identical across all six parent/child revisions before
  trimming (`git show <rev>:package.json`), so one copy is enough.
- Regenerating a fixture if this repo's real history is ever rewritten:
  `git show <rev>^:package-lock.json` / `git show <rev>:package-lock.json`,
  then keep only the entries the corresponding `git diff <rev>^ <rev> --
  package-lock.json` actually touches.

## Files

| Pair | Commit | Scenario | Shadow hash |
|------|--------|----------|-------------|
| `case1-release-bump.{parent,child}` | `0d4f294bc99564fa15b8800f8a10bea9e11a43b0` | Weekly release-cadence bump (ADR-114) — workspace-self `version` fields plus the internal `@skillsmith/*`/`@smith-horn/*` dependency-edge ranges that reference them. No real `node_modules/*` change. | EQUAL |
| `case2a-chalk-bump.{parent,child}` | `08d8cacb045062ad225fac012a325ea94f0560ac` | `chore(deps): bump chalk 5.6.2 -> 6.0.0` (#2413) — pure external-dependency change, zero workspace-self version movement. | DIFFERS |
| `case2b-stripe-bump.{parent,child}` | `c51db0a83bbdc969f3c36a2bf106780a5dc0a806` | `chore(deps): bump stripe 20.2.0 -> 22.6.1` (#2661) — same shape as chalk. | DIFFERS |
