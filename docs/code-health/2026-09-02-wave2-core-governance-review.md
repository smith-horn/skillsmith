# Governance Review — Wave 2 (packages/core code-health scan)

**Date**: 2026-09-02
**Branch**: cleanup/code-health-wave-2-core
**Reviewer**: governance-specialist
**Scope**: docs-only diff (code-health scan artifacts for `packages/core`)

## Diff under review

| File | Kind |
|------|------|
| `docs/code-health/2026-09-02-023537-core-scan-repo.json` | scan JSON artifact (564 candidates) |
| `docs/code-health/2026-09-02-023537-core-scan-repo.md` | scan summary |
| `docs/code-health/2026-09-02-023616-packages-core-code-health.md` | verify report |
| `docs/code-health/2026-09-02-core-triage.md` | triage checkpoint |

No source, config, CI, or infra files changed. TypeScript / lint / format / test / `audit:standards` checks are not applicable to a docs-only wave and were not run.

## Checks performed

1. **Artifact filename consistency** — the "Scan artifacts" section of the triage checkpoint names all three companion artifacts (`...-core-scan-repo.json`, `...-core-scan-repo.md`, `...-packages-core-code-health.md`). All three match the staged filenames exactly. PASS.

2. **Bucket count reconciliation** — cross-checked triage table vs. verify report headers vs. verify report row counts vs. raw JSON:
   - Bucket 1 (Safe to delete): **0** — matches everywhere.
   - Bucket 2 (Consolidation): **44** — verify report header says 44; counted **44** actual data rows (lines 22–67); triage table says 44.
   - Bucket 3 (Looks bad but fine): **0** — matches.
   - Bucket 4 (Needs runtime verification): **531** — verify report header says 531; counted **531** actual data rows (lines 84–615); triage table says 531.
   - Total math: JSON holds **564** Knip candidates by category (`files 11, dependencies 8, unlisted 10, exports 281, duplicates 25, types 229`). Bucket 2 Knip contribution = 8 deps + 25 duplicates = 33; Bucket 4 = 11 + 10 + 281 + 229 = 531; 33 + 531 = 564. The 11 name-repeat-detector findings are a separate detector added on top of the 33 Knip Bucket-2 items → 33 + 11 = **44**. Fully internally consistent. PASS.

3. **"Why no Bucket 1 items" explanation** — the triage correctly states `packages/core` is not in `CALIBRATED_WORKSPACES` (only `packages/cli` is calibrated), that the auditor contract hard-routes all findings from uncalibrated workspaces to Bucket 4, and that no coverage run was attempted or needed. The JSON confirms `calibrated: false` and every Bucket 4 row carries the reason `workspace is EXPERIMENTAL (uncalibrated)`. Accurate. PASS.

4. **Consolidation-candidate list accuracy** —
   - 8 unused OpenTelemetry/`tree-sitter-wasms` dependencies: match the JSON `dependencies` category and the verify report `package.json` rows exactly.
   - 25 duplicate-export files: the triage "Notable" list enumerates all 25; verified 1:1 against the JSON `duplicates` category. (Note: the list is exhaustive, not a subset — "Notable" is technically the complete set.)
   - 11 name-repeat-detector findings: names match the verify report's 11 name-repeat rows exactly (`createLogger`, `fetchWithRetry`, `cosineSimilarity`, `detectTools`, `estimateMemoryUsage`, `formatBytes`, `dynamicImport`, `validatePath`, `fetchData`, `createDatabaseAsync`, `helper`). Priority calls (`createLogger`, `fetchWithRetry`, `cosineSimilarity`, `detectTools`) are reasonable and internally consistent. PASS.

5. **Verify report structure** — all standard sections present: SCAN FAILURES (0), Safe to delete (0), Consolidation candidate (44), Looks bad but is fine (0), Needs runtime verification (531), Suppressed by marker (0), Stale suppression markers (0). PASS.

6. **Scan summary validity** — reports `packages/core (EXPERIMENTAL — uncalibrated)`, `scan_status: comprehensive=has_issues, production=has_issues`, `Candidates: 564`, `Looks-bad-but-fine tags: 0`. Candidate count matches the JSON. Valid summary. PASS (after fix below).

7. **Post-merge obligations** — present in the triage checkpoint (Linear → Done, project update, `index.md` wave-2 row, calibration consideration). PASS.

8. **Stale suppression markers** — triage and verify report both report 0; no `audit:code-health-ok` markers in `packages/core/src/`. Consistent. PASS.

## Issues found and fixed

| # | Severity | File | Issue | Resolution |
|---|----------|------|-------|------------|
| 1 | Minor | `2026-09-02-023537-core-scan-repo.md` | The "Full candidate JSON" and "Next step" lines pointed at `docs/internal/code-health/...`, but the artifacts are actually staged under `docs/code-health/...`. A reader following those paths would look in the wrong directory. | Fixed inline — both path references corrected to `docs/code-health/...` to match the actual staged location. |

No other issues. The triage checkpoint is accurate and internally consistent with both the verify report and the raw JSON.

## Verdict

**PASS** — docs-only wave, artifacts are mutually consistent, triage checkpoint is accurate, one minor stale-path reference found and fixed inline. Ready to commit.
