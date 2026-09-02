# Wave 2 Triage — packages/core

**Date**: 2026-09-02  
**Branch**: cleanup/code-health-wave-2-core  
**Machine**: Windows 11 (wrsmith108)

## Scan artifacts

- JSON: `2026-09-02-023537-core-scan-repo.json`
- Scan summary: `2026-09-02-023537-core-scan-repo.md`
- Verify report: `2026-09-02-023616-packages-core-code-health.md`

## Triage results

| Bucket | Count | Action |
|--------|-------|--------|
| Safe to delete | 0 | — (EXPERIMENTAL workspace — Bucket 1 not reachable without calibration) |
| Consolidation candidate | 44 | Human judgment only — deferred to Mac review |
| Looks bad but is fine | 0 | — |
| Needs runtime verification | 531 | EXPERIMENTAL workspace — all hard-routed to Bucket 4 |

## Why no Bucket 1 items

`packages/core` is not listed in `CALIBRATED_WORKSPACES` in `scan-repo.sh` (only `packages/cli` is calibrated). The auditor contract hard-routes all findings from uncalibrated workspaces to Bucket 4 regardless of coverage result. No coverage run was attempted or needed.

**To enable Bucket 1 verdicts in a future wave**: add `packages/core` to `CALIBRATED_WORKSPACES` in `scan-repo.sh`, then re-run from a Mac with Docker for real per-line coverage.

## Coverage run status

Coverage run **not attempted** — `packages/core` is EXPERIMENTAL (uncalibrated). The verify report marks all 531 Bucket 4 entries as `workspace is EXPERIMENTAL (uncalibrated)`. No Vitest execution occurred; no Docker required.

## Consolidation candidates (44) — human review on Mac

The 44 consolidation candidates break into three sub-types:

### Unused dependencies (8) — from package.json
Knip flagged these as unused. Each requires a manual runtime-import check before removal — dynamic imports and native bindings are invisible to static analysis.

- `@opentelemetry/instrumentation-http`
- `@opentelemetry/instrumentation-runtime-node`
- `@opentelemetry/instrumentation-undici`
- `@opentelemetry/resources`
- `@opentelemetry/sdk-node`
- `@opentelemetry/sdk-trace-base`
- `@opentelemetry/semantic-conventions`
- `tree-sitter-wasms`

### Knip duplicate-export findings (25 files)
Knip detected duplicate exports within these files; no per-line resolution available — human review required before action.

Notable: `src/analysis/CodebaseAnalyzer.ts`, `src/security/SkillSandbox.ts`, `src/security/scanner/SecurityScanner.ts`, `src/matching/SkillMatcher.ts`, `src/matching/OverlapDetector.ts`, `src/webhooks/WebhookHandler.ts`, `src/webhooks/WebhookQueue.ts`, `src/cache/lru.ts`, `src/cache/sqlite.ts`, `src/api/client.ts`, `src/api/cache.ts`, `src/embeddings/index.ts`, `src/db/createDatabase.ts`, `src/security/scanner/regex-utils.ts`, `src/indexer/SkillParser.ts`, `src/install/agent-pack-installer.entry.ts`, `src/activation/ActivationManager.ts`, `src/activation/ZeroConfigActivator.ts`, `src/repositories/IndexerRepository.ts`, `src/search/hybrid.ts`, `src/services/TaskRunner.ts`, `src/services/TransformationService.ts`, `src/triggers/ContextScorer.ts`, `src/triggers/TriggerDetector.ts`, `tests/fixtures/api-responses/index.ts`

### Name-repeat-detector findings (11) — highest-signal for Mac review

| Name | Files | Notes |
|------|-------|-------|
| `createLogger` | `src/logging/logger.ts`, `src/utils/logger.ts` | Two separate logger factory implementations — strongest consolidation signal |
| `fetchWithRetry` | `src/scripts/github-import/github-client.ts`, `src/utils/retry.ts` | Generic retry utility vs script-local copy |
| `cosineSimilarity` | `src/embeddings/embedding-utils.ts`, `src/learning/PatternStore.helpers.ts` | Math utility duplicated across subsystems |
| `detectTools` | `src/services/SkillAnalyzer.helpers.ts`, `src/services/SubagentGenerator.helpers.ts` | Same tool-detection logic in two service helpers |
| `estimateMemoryUsage` | `src/analysis/file-streamer.ts`, `src/embeddings/hnsw-store.helpers.ts` | Memory estimation across subsystems |
| `formatBytes` | `src/benchmarks/formatters.ts`, `src/benchmarks/memory/utils.ts` | Also appears re-exported from benchmarks/index.ts |
| `dynamicImport` | `src/telemetry/metric-helpers.ts`, `src/telemetry/tracer-imports.ts` | Telemetry-subsystem utility split |
| `validatePath` | `src/analytics/metrics-exporter.ts`, `src/validation/path-validators.ts` | Path validation in two locations |
| `fetchData` | 3 test files (`__tests__/typescript.test.ts`, `__tests__/incremental.test.ts`, `__tests__/performance.test.ts`) | Test-local stub — low signal, likely intentional |
| `createDatabaseAsync` | `src/db/createDatabase.ts`, `src/db/schema.ts` | DB initialization split across files |
| `helper` | `src/analysis/__tests__/performance.test.ts` only | Single test file — false trigger, ignore |

**Priority for Mac review**: `createLogger` (two competing logger factories), `fetchWithRetry` (generic utility vs script copy), `cosineSimilarity` and `detectTools` (cross-subsystem duplication).

## Stale suppression markers

**0 stale markers.** `grep -rn "audit:code-health-ok" packages/core/src/` returned no results. Step 9 (cleanup) is a no-op.

## Wave objective and success criteria

This wave establishes a **baseline scan artifact** for `packages/core`. Zero source deletions occur. The value is:
1. A documented candidate list (564 scan candidates, 44 in Bucket 2) for human review on the Mac
2. Identification of `createLogger` / `fetchWithRetry` / `cosineSimilarity` as the highest-signal consolidation targets
3. 8 OpenTelemetry dependencies flagged as potentially unused (runtime check required)

To produce real Bucket 1 verdicts: calibrate `packages/core` (add to `CALIBRATED_WORKSPACES` in `scan-repo.sh`) and re-run from Mac with Docker.

## Post-merge obligations (for Mac session)

- [ ] Move Linear issue to Done with squash-merge SHA
- [ ] Post project update using the PR Business Summary
- [ ] Update `docs/code-health/index.md` to add the wave-2 row
- [ ] Consider calibrating packages/core before Wave 3 to enable Bucket 1 verdicts
