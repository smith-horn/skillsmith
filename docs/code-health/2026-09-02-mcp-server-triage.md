# Wave 3 Triage — packages/mcp-server

**Date:** 2026-09-02
**Branch:** cleanup/code-health-wave-3-mcp-server
**Machine:** Windows 11, wrsmith108

## Scan artifacts

| File | Path |
|------|------|
| Scan JSON | `docs/code-health/2026-09-02-030059-mcp-server-scan-repo.json` |
| Scan MD | `docs/code-health/2026-09-02-030059-mcp-server-scan-repo.md` |
| Verify MD | `docs/code-health/2026-09-02-030124-packages-mcp-server-code-health.md` |

## Triage results

Candidate partition (173 total — from verify report):

| Bucket | Count | Action |
|--------|-------|--------|
| B1 Safe-to-delete | 0 | EXPERIMENTAL workspace — no source deletions |
| B2 Consolidation candidate | 8 | Human review on Mac with Docker |
| B4 Needs-runtime-verification | 165 | Remaining exports/types/files/unlisted candidates |

**Total candidates:** 173 (B1 0 + B2 8 + B4 165 = 173)

**Separate axis — FP tags (not a subset of the 173 candidates):**

| Tag type | Count | Meaning |
|----------|-------|---------|
| `mcp-string-dispatch-unmatched` | 152 | File-level defensive blind-spot tags; only 38 of 152 tagged files appear in the 173 candidate set — these are NOT bucket B3, they are a distinct annotation axis that cannot be summed into the 173 |

Note: `looks_bad_but_fine` tag counts (152) and candidate counts (173) are two
independent axes in the scan JSON. The verify report presents them separately:
"Candidates: 173" and "Looks-bad-but-fine tags: 152".

## Why no Bucket 1 items

EXPERIMENTAL workspace (`calibrated=false`). All candidates default to Bucket 4 or lower
without Docker coverage data. Source deletions are not performed from Windows — Bucket 1
requires calibration + Mac Docker re-run.

## Coverage run status

Not attempted — uncalibrated workspace. `verify-candidates.sh` ran with
`coverage_state=absent` for all candidates.

## MCP string-dispatch check (special to this package)

152 files tagged `mcp-string-dispatch-unmatched` — all in `packages/mcp-server/src/tools/`.
The check verified tool names in `tool-dispatch.ts` against every file under `tools/*.ts`.
Result: all 152 are **known blind spots**, not findings. The scanner note confirms
"direct-import dispatch is expected to satisfy this" — the dispatch mechanism uses direct
imports, not a string switch, so no unmatched entries are actual dead code.

## Consolidation candidates (top findings for Mac review)

### From verify report (name-repeat-detector + Knip duplicate-export)

| Signal | Name | Files | Priority |
|--------|------|-------|----------|
| HIGH | `readBody` | `utils/local-inventory.helpers.ts`, `webhooks/webhook-helpers.ts` | Utility duplication across subsystems |
| HIGH | `parseSkillId` | `tools/install.helpers.ts`, `utils/validation.ts` | Install helper vs general validation |
| HIGH | `main` | `webhooks/stripe-webhook-endpoint.ts`, `webhooks/webhook-endpoint.ts` | Two webhook entry points with same entrypoint name |
| HIGH | `attachShutdownHandlers` | `webhooks/stripe-webhook-endpoint.ts`, `webhooks/webhook-endpoint.ts` | Webhook startup/shutdown duplication |
| MEDIUM | `loadManifest` | `tools/install.helpers.manifest.ts`, `utils/local-inventory.helpers.ts` | Install vs inventory manifest loading |
| MEDIUM | `getLocalIndexer` | `indexer/LocalIndexer.ts`, `tools/LocalSkillSearch.ts` | Factory function defined in two places |

### From scan JSON (type/schema duplication)

| Signal | Name | Files | Priority |
|--------|------|-------|----------|
| MEDIUM | `TelemetryConfig`/`BackgroundSyncConfig` | `src/context.ts`, `src/context.types.ts` | Types defined in both module and types file |
| MEDIUM | `ERROR_MESSAGES`/`MCPErrorContent` | `middleware/errorFormatter.ts`, `middleware/errorFormatter.types.ts` | Error constants split across module and types |
| MEDIUM | `skillContentSchema` | `tools/registry-tools.ts`, `tools/registry-tools.schemas.ts` | Schema defined in both tool file and schemas file |
| LOW | `generateDailyTrend` | `tools/analytics.ts`, `tools/analytics.stub.ts` | Production vs stub co-define the same function |

### Knip duplicate-export findings

- `packages/mcp-server/src/tools/uninstall.ts` — duplicate export (no per-line coverage; human review)
- `packages/mcp-server/src/tools/install.tool.ts` — duplicate export (no per-line coverage; human review)

## Stale suppression markers

0 found. No `audit:code-health-ok` markers in `packages/mcp-server/src/`.

## Wave objective and success criteria

This wave establishes a baseline scan of `packages/mcp-server`. All 173 candidates are
in Bucket 4 or lower (EXPERIMENTAL). No source deletions. MacBook Docker re-run required
for Bucket 1 promotion.

**Top opportunities identified for Mac follow-up:**
1. Webhook duplication (`main` + `attachShutdownHandlers` in two endpoints) — consolidation candidate
2. `readBody` / `parseSkillId` cross-subsystem utility duplication — likely consolidation
3. Type/schema split between `.ts` and `.types.ts`/`.schemas.ts` files (TelemetryConfig, ERROR_MESSAGES, skillContentSchema)

## Post-merge obligations (Mac)

- [ ] Create/update SMI issue; comment with squash SHA
- [ ] Post project update using PR Business Summary
- [ ] Update `docs/code-health/index.md` with wave-3 row
- [ ] Consider calibrating `packages/mcp-server` before next wave
- [ ] Investigate `main`/`attachShutdownHandlers` duplication in webhook endpoints
- [ ] Investigate `readBody`/`parseSkillId` cross-subsystem utility duplication
