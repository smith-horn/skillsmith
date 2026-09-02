# Wave 6 Enterprise — Governance Review

**Date:** 2026-09-02
**Reviewer:** governance-specialist (docs-only artifact review)
**Scope:** `packages/enterprise` code-health audit artifacts (Wave 6)
**Verdict:** **PASS** (1 MINOR observation, non-blocking, tracked below)

## Artifacts reviewed

| Artifact | File |
|----------|------|
| Scan JSON | `2026-09-02-032044-enterprise-scan-repo.json` |
| Scan MD | `2026-09-02-032044-enterprise-scan-repo.md` |
| Verify MD | `2026-09-02-032100-packages-enterprise-code-health.md` |
| Triage MD | `2026-09-02-enterprise-triage.md` |

## Check results

### 1. Artifact filename consistency — PASS
Scan pair shares timestamp `032044` (both `.md` and `.json`); verify report is `032100`, 16s later. Ordering and pairing are internally consistent. Triage's artifact table (lines 11-13) references all three by their correct on-disk paths.

### 2. Bucket-count reconciliation — PASS
- Scan JSON `candidates[]`: 20 entries (2 `files` + 1 `dependencies` + 7 `devDependencies` + 8 `exports` + 2 `types`).
- Scan MD header: "Candidates: 20, Looks-bad-but-fine tags: 0" — matches.
- Verify MD: Consolidation candidate (8) + Needs runtime verification (12) = 20 — matches.
- Triage: B1 0 + B2 8 + B4 12 = 20 — matches.
All four artifacts reconcile to 20. No candidate lost or double-counted.

### 3. Bucket-1-absence rationale — PASS
Workspace is `calibrated: false` (JSON line 7), i.e. EXPERIMENTAL. Verify report force-routes every candidate to B4 with reason "workspace is EXPERIMENTAL (uncalibrated)". Triage's B1=0 justification (lines 28-31) is correct: Bucket 1 (Safe-to-delete) requires calibration + coverage, which an uncalibrated workspace cannot supply. Consistent with the report's own Bucket-1 guardrail ("Zero static references + zero coverage on the exact flagged range").

### 4. Consolidation (B2) accuracy — PASS
Verify report's 8 consolidation items match triage's B2 list **exactly**, member-for-member:
`@opentelemetry/instrumentation-aws-sdk`, `@smithy/config-resolver`, `@smithy/core`, `@smithy/middleware-endpoint`, `@smithy/middleware-retry`, `@smithy/protocol-http`, `@smithy/smithy-client`, `@smithy/util-retry`.
Triage correctly separates the single OpenTelemetry `dependencies` entry from the 7 `@smithy/*` `devDependencies` entries into distinct sub-tables, matching the JSON `category` field for each (JSON: `@opentelemetry/...` = `dependencies` line 31; all `@smithy/*` = `devDependencies`). No mismatch.

### 5. Verify-report structure — PASS
All expected sections present and correctly populated: SCAN FAILURES (0), Safe to delete (0), Consolidation candidate (8), Looks bad but is fine → False positives (0) / Known blind spots (0), Needs runtime verification (12), Suppressed by marker (0), Stale suppression markers (0). No section missing or malformed. SCAN FAILURES=0 confirms both Knip passes (`comprehensive=has_issues`, `production=has_issues`) returned well-formed data — "has_issues" means findings were produced, not that the scan failed.

### 6. Stale-marker check — PASS
Verify report "Stale suppression markers (0)" and "Suppressed by marker (0)" both empty. Triage line 95 asserts 0 with the scope statement "No `audit:code-health-ok` markers in `packages/enterprise/src/`". Consistent.

### 7. Conservative treatment / @smithy transitive-dep justification — PASS
The conservative posture is well-founded and correctly reasoned:
- **Directive followed.** Wave plan directs conservative treatment; triage places 0 items in B1, 0 FP tags, and routes all 20 to human-review buckets (B2/B4). No source or dependency deletion performed from Windows.
- **Hypothesis is sound.** `@smithy/*` is the Smithy TypeScript runtime that AWS SDK v3 clients depend on transitively. Knip's static analysis cannot resolve transitive peer chains, so a "unused devDependency" verdict on these packages is exactly the class of finding that requires `npm ls` confirmation before removal. Triage flags this correctly (lines 42-45, 104-105) and defers the check to the Mac Docker environment (post-merge obligation line 112).
- **CloudWatchExporter.ts corroborates.** The four `CloudWatchExporter.ts` constants (`VALID_RETENTION_DAYS`, `MAX_BATCH_SIZE`, `MAX_BATCH_BYTES`, `EVENT_OVERHEAD_BYTES`, JSON lines 133-164) confirm a live CloudWatch audit-export source file exists in the workspace. A CloudWatch client pulls `@aws-sdk/client-cloudwatch-logs`, which in turn pulls the flagged `@smithy/*` runtime packages. The presence of this file materially supports the "almost certainly transitive" hypothesis rather than treating the `@smithy/*` flags as genuine dead deps. Reasoning chain is valid.
- **OpenTelemetry item handled correctly.** `@opentelemetry/instrumentation-aws-sdk` is separately flagged for an auto-instrumentation-bootstrap usage check (triage line 69, obligation line 113) rather than lumped with the Smithy transitive hypothesis — appropriate, since instrumentation packages are frequently loaded via a bootstrap register call invisible to static import analysis.

## Observations

### MINOR — scan-repo.md "Next step" path drift (non-blocking, no action required this wave)
`2026-09-02-032044-enterprise-scan-repo.md` (lines 12-13) references the JSON and verify-candidates path under `docs/internal/code-health/`, whereas the artifacts actually live at `docs/code-health/`. This is boilerplate emitted by the scan tool, not a triage error — the triage's own artifact table uses the correct `docs/code-health/` paths, so no reader is misdirected in practice. It does not affect any bucket count, classification, or conservative-treatment conclusion. Flagged for the scan-tool template owner; no artifact change needed for this wave's merge.

## Summary

- **Task:** Docs-only governance review of Wave 6 (`packages/enterprise`) code-health artifacts
- **Checks run:** 7/7 (filename consistency, bucket reconciliation, B1-absence rationale, consolidation accuracy, verify-report structure, stale-marker check, conservative-treatment justification)
- **Results:** All 7 checks PASS. 20 candidates reconcile across all four artifacts; B2 list exact-matches verify report; @smithy transitive-dep conservative treatment is justified and corroborated by CloudWatchExporter.ts; 0 B1, 0 FP, 0 stale markers — correct for an EXPERIMENTAL/uncalibrated workspace.
- **Issues fixed:** 0 (docs-only review; no source or artifact edits in scope)
- **Verdict:** **PASS**
