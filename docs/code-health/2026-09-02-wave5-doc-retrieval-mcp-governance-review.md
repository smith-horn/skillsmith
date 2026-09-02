# Wave 5 Governance Review — packages/doc-retrieval-mcp

**Date:** 2026-09-02
**Reviewer:** governance-specialist (docs-only)
**Scope:** Code-health audit artifacts for `packages/doc-retrieval-mcp` (Wave 5)
**Verdict:** **PASS**

## Artifacts reviewed

| File | Type |
|------|------|
| `2026-09-02-031527-doc-retrieval-mcp-scan-repo.json` | Scan JSON |
| `2026-09-02-031527-doc-retrieval-mcp-scan-repo.md` | Scan MD |
| `2026-09-02-031542-packages-doc-retrieval-mcp-code-health.md` | Verify MD |
| `2026-09-02-doc-retrieval-mcp-triage.md` | Triage |

## Check results

### 1. Artifact filename consistency — PASS
- Scan JSON/MD share timestamp `031527`; verify MD is `031542` (15s later). Ordering is correct (scan precedes verify).
- Date prefix `2026-09-02` consistent across all four files.
- Package slug `doc-retrieval-mcp` consistent. Verify MD uses the fuller `packages-doc-retrieval-mcp-code-health` form, matching prior-wave convention.

### 2. Bucket-count reconciliation (scan=1 vs verify=4) — PASS
- Scan JSON `candidates[]` contains exactly 1 entry (`glob`, `category: dependencies`, `reachability: both`). Confirmed.
- Verify MD "Consolidation candidate (4)" lists 4 rows: `glob` + 3 name-repeat findings.
- The discrepancy is real and correctly explained. Triage lines 17-19 state the 3 name-repeat findings come from `verify-candidates.sh` pattern matching (name-repeat-detector), not Knip static analysis — hence absent from the scan JSON. This is accurate: the verify MD tags each of the 3 extra rows `source: name-repeat-detector`, and the scan JSON is Knip-only.
- Triage explicitly and correctly designates the **verify report as authoritative** for bucket counts (line 19, line 29). Consistent with prior-wave treatment.

### 3. Bucket-1-absence rationale (EXPERIMENTAL) — PASS
- Scan JSON `calibrated: false`; scan MD labels workspace "EXPERIMENTAL — uncalibrated". Consistent.
- Triage B1=0 with rationale "EXPERIMENTAL workspace — no source deletions … requires calibration + Mac Docker re-run" (lines 25, 33-35). Verify MD "Safe to delete (0)" corroborates. Rationale is sound and matches uncalibrated-workspace policy.

### 4. Consolidation accuracy (4 verify findings) — PASS
All 4 verify-MD rows are faithfully carried into the triage:
- `glob` (package.json line 27, MEDIUM) — matches.
- `readState` (4 files, HIGH) — matches.
- `writeEntry` (3 files, HIGH) — matches.
- `readEntry` (3 files, HIGH) — matches.
No inflation, no omission, no misclassification. Priorities are triage-added editorial and reasonable.

### 5. Verify-report structure — PASS
All expected sections present: Scan Failures (0), Safe to delete (0), Consolidation candidate (4), Looks bad but is fine (0) with False positives (0) + Known blind spots (0), Needs runtime verification (0), Suppressed by marker (0), Stale suppression markers (0). Section boilerplate/Decision-Log references intact.

### 6. Stale-marker check — PASS
- Verify MD "Stale suppression markers (0): _None._". Triage line 70 reports "0 found. No `audit:code-health-ok` markers". Consistent.

### 7. Name-repeat finding accuracy — PASS (independently verified against source)
Ground-truth `grep` of `src/retrieval-log/*-state.ts` exports:

| Function | Triage/verify file list | Source grep confirms |
|----------|-------------------------|----------------------|
| `readState` | autoheal, liveness, mcp-disconnect, reindex (4) | autoheal:105, liveness:99, mcp-disconnect:245, reindex:110 — **4 ✓** |
| `writeEntry` | autoheal, liveness, reindex (3) | autoheal:125, liveness:119, reindex:130 — **3 ✓** (mcp-disconnect has none) |
| `readEntry` | autoheal, liveness, reindex (3) | autoheal:117, liveness:111, reindex:122 — **3 ✓** (mcp-disconnect has none) |

The asymmetry (mcp-disconnect exports `readState` but not `writeEntry`/`readEntry`) is correctly reflected in the counts. `glob` confirmed at `package.json` line 27 (`"glob": "11.1.0"`).

## Findings

None. No corrections required. Every artifact claim reconciles against its source data and against the actual package source. The scan-vs-verify discrepancy is correctly explained with verify as authoritative; the EXPERIMENTAL/no-B1 posture is appropriate for an uncalibrated Windows run.

## Verdict

**PASS** — Wave 5 artifacts are internally consistent, accurately reconciled, and independently verified against source. Cleared for the Mac-side review obligations enumerated in the triage (SMI issue, project update, `index.md` wave-5 row, shared-abstraction assessment of the four state files, `glob` runtime check).
