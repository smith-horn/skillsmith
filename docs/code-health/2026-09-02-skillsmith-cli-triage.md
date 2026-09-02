# Wave 4 Triage — packages/skillsmith-cli

**Date:** 2026-09-02
**Branch:** cleanup/code-health-wave-4-skillsmith-cli
**Machine:** Windows 11, wrsmith108

## Scan artifacts

| File | Path |
|------|------|
| Scan JSON | `docs/code-health/2026-09-02-030947-skillsmith-cli-scan-repo.json` |
| Scan MD | `docs/code-health/2026-09-02-030947-skillsmith-cli-scan-repo.md` |
| Verify MD | `docs/code-health/2026-09-02-031006-packages-skillsmith-cli-code-health.md` |

## Triage results

Candidate partition (1 total — from verify report):

| Bucket | Count | Action |
|--------|-------|--------|
| B1 Safe-to-delete | 0 | EXPERIMENTAL workspace — no source deletions |
| B2 Consolidation candidate | 1 | Human review on Mac with Docker |
| B4 Needs-runtime-verification | 0 | No remaining candidates |

**Total candidates:** 1 (B1 0 + B2 1 + B4 0 = 1)
**FP tags:** 0 (none)

## Why no Bucket 1 items

EXPERIMENTAL workspace (`calibrated=false`). Source deletions not performed from Windows.
Bucket 1 requires calibration + Mac Docker re-run.

## Coverage run status

Not attempted — uncalibrated workspace.

## Consolidation candidates

| Signal | Finding | File | Priority |
|--------|---------|------|----------|
| HIGH | `@skillsmith/cli` — flagged as unused dependency | `packages/skillsmith-cli/package.json` line 14 | Dependency on the published `@skillsmith/cli` package. Governance review confirms this dep is **runtime-live**: `bin.js` uses `require.resolve('@skillsmith/cli/package.json')` via dynamic `createRequire` — invisible to Knip's static analysis. `packages/skillsmith-cli` is a wrapper/shim that delegates to the published `@skillsmith/cli`. Deleting this dep would break the wrapper. Correctly B2 (human review), NOT B1. |

### Overlap with Wave 1 (packages/cli)

Wave 1 scanned `packages/cli`. This wave scans `packages/skillsmith-cli`, a second CLI
package. The finding here is a dependency (`@skillsmith/cli`) that may point to `packages/cli`'s
published artifact. If `packages/skillsmith-cli` wraps or re-exports `@skillsmith/cli`, this
dependency is intentional — the static analysis can't see dynamic requires or peer-dependency
patterns. Mac reviewer should check `packages/skillsmith-cli/package.json` line 14 and grep
for `require('@skillsmith/cli')` or `from '@skillsmith/cli'` across the package source.

## Stale suppression markers

0 found. No `audit:code-health-ok` markers.

## Wave objective and success criteria

This wave establishes a baseline scan of `packages/skillsmith-cli`. 1 candidate found
(dependencies category), all in Bucket 2 for human review. No source deletions.
MacBook Docker re-run required for Bucket 1 promotion.

The single finding is notable: `@skillsmith/cli` listed as a dependency of `packages/skillsmith-cli`
may indicate a cross-package dependency on the published CLI, or a stale/incorrect dep entry.

## Post-merge obligations (Mac)

- [ ] Create/update SMI issue; comment with squash SHA
- [ ] Post project update using PR Business Summary
- [ ] Update `docs/code-health/index.md` with wave-4 row
- [ ] Check `packages/skillsmith-cli/package.json` line 14: is `@skillsmith/cli` intentional?
- [ ] `grep -r "@skillsmith/cli" packages/skillsmith-cli/src/` to confirm usage or confirm it's stale
