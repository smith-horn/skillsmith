# npm-view fixtures

Shared JSON snapshots of `npm view <pkg> versions --json` responses consumed
by both `check-publish-collision.test.ts` (SMI-4188) and
`prepare-release.test.ts` (SMI-4204).

## Fixture contract

- Each `.json` file is the raw stdout of `npm view <pkg> versions --json`.
- Each `.txt` file is a simulated stderr body for error-path cases.
- Tests import fixtures by filename; adding a new fixture requires updating
  consumers in both test files to keep the two collision implementations in
  lockstep.
- Drift between the two implementations is caught by identical-fixture
  assertions. Do not branch fixtures per-consumer — if a new shape is
  needed, add a new fixture used by both.

## Files

| File | Scenario |
|------|----------|
| `core-clean.json` | @skillsmith/core pre-release 0.5.x only; any target > 0.5.3 proceeds |
| `core-2x-overhang.json` | @skillsmith/core with 2.x published alongside 0.5.x (production reality) |
| `mcp-server-basic.json` | @skillsmith/mcp-server simple versions array |
| `enterprise-github-packages.json` | @smith-horn/enterprise GitHub Packages response shape |
| `404-stderr.txt` | Stderr body for `E404` (new package) path |
| `network-error.txt` | Stderr body for ENOTFOUND (fail-closed) path |
