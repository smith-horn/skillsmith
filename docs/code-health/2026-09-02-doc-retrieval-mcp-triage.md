# Wave 5 Triage — packages/doc-retrieval-mcp

**Date:** 2026-09-02
**Branch:** cleanup/code-health-wave-5-doc-retrieval-mcp
**Machine:** Windows 11, wrsmith108

## Scan artifacts

| File | Path |
|------|------|
| Scan JSON | `docs/code-health/2026-09-02-031527-doc-retrieval-mcp-scan-repo.json` |
| Scan MD | `docs/code-health/2026-09-02-031527-doc-retrieval-mcp-scan-repo.md` |
| Verify MD | `docs/code-health/2026-09-02-031542-packages-doc-retrieval-mcp-code-health.md` |

## Triage results

Note: Scan JSON reports 1 candidate (Knip static analysis). Verify report adds 3 name-repeat-detector
findings (not in scan JSON — detected by verify-candidates.sh pattern matching). Verify report is
authoritative for bucket counts.

Candidate partition (4 total — from verify report):

| Bucket | Count | Action |
|--------|-------|--------|
| B1 Safe-to-delete | 0 | EXPERIMENTAL workspace — no source deletions |
| B2 Consolidation candidate | 4 | Human review on Mac with Docker |
| B4 Needs-runtime-verification | 0 | None |

**Total candidates (verify):** 4 (B2=4)
**Scan JSON candidates:** 1 (Knip static only)
**FP tags:** 0 (none)

## Why no Bucket 1 items

EXPERIMENTAL workspace (`calibrated=false`). Source deletions not performed from Windows.
Bucket 1 requires calibration + Mac Docker re-run.

## Coverage run status

Not attempted — uncalibrated workspace.

## Consolidation candidates

### Retrieval-log state file pattern (highest signal)

All three name-repeat findings come from `packages/doc-retrieval-mcp/src/retrieval-log/` — four parallel
state files each implementing the same read/write interface under different names:

| Finding | Files | Count | Priority |
|---------|-------|-------|----------|
| `readState` | autoheal-state.ts, liveness-state.ts, mcp-disconnect-state.ts, reindex-state.ts | 4 | **HIGH** — same function name in 4 parallel state modules; strong interface-extraction candidate |
| `writeEntry` | autoheal-state.ts, liveness-state.ts, reindex-state.ts | 3 | **HIGH** — same function name in 3 state modules |
| `readEntry` | autoheal-state.ts, liveness-state.ts, reindex-state.ts | 3 | **HIGH** — same function name in 3 state modules |

These three findings together suggest the four retrieval-log state files
(`autoheal-state`, `liveness-state`, `mcp-disconnect-state`, `reindex-state`) implement a
common state-management interface (`readState`/`writeEntry`/`readEntry`) that could be
extracted into a shared abstraction. This is the highest-value consolidation opportunity
in the package — Mac review should assess whether a shared `StateManager<T>` or similar
base could replace the four parallel implementations.

### Dependency finding

| Finding | File | Priority |
|---------|------|----------|
| `glob` — unused dependency | `package.json` line 27 | **MEDIUM** — Knip cannot see dynamic `require()` or shell-style glob usage; human runtime check needed before removal |

## Stale suppression markers

0 found. No `audit:code-health-ok` markers in `packages/doc-retrieval-mcp/src/`.

## Wave objective and success criteria

This wave establishes a baseline scan of `packages/doc-retrieval-mcp`. 4 candidates in Bucket 2
for human review (0 in Bucket 1 — EXPERIMENTAL). No source deletions. MacBook Docker re-run
required for Bucket 1 promotion.

**Top opportunity:** The `readState`/`writeEntry`/`readEntry` pattern repeated across four state files
in `retrieval-log/` is the most compelling consolidation candidate — a shared state-management
interface could eliminate the duplication. Mac reviewer should read the four state files together.

## Post-merge obligations (Mac)

- [ ] Create/update SMI issue; comment with squash SHA
- [ ] Post project update using PR Business Summary
- [ ] Update `docs/code-health/index.md` with wave-5 row
- [ ] Read `src/retrieval-log/{autoheal,liveness,mcp-disconnect,reindex}-state.ts` together — assess shared abstraction
- [ ] Check `glob` usage: `grep -r "glob" packages/doc-retrieval-mcp/src/` before removal
