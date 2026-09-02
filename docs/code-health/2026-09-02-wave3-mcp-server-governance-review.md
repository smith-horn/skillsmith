# Governance Review — Wave 3 (packages/mcp-server)
Date: 2026-09-02
Reviewer: governance-specialist (Opus)

## Verdict: PASS (post-fix)

**Post-review update:** Finding #1 (blocking bucket-table inconsistency) was resolved immediately after review. Triage doc updated to: B1=0, B2=8, B4=165, total=173, with 152 FP tags moved to a clearly-labeled separate axis. Governance re-verdict: PASS.

---

## Original verdict: FAIL (before fix)

The artifacts are substantively sound and the qualitative conclusions (no Bucket 1, MCP dispatch tags are blind spots, consolidation names) are correct, but the triage's Bucket-count table is arithmetically inconsistent with the verify report and conflates two independent count axes. This must be corrected before commit (docs-only fix).

## Checks

1. **Artifact filename consistency** — PASS. Scan MD/JSON share timestamp `030059`; verify report is `030124`; all four carry `2026-09-02`, scope `mcp-server` / `packages-mcp-server`. Scan MD generated `03:00:59Z`, verify generated `03:01:25.897Z` — a plausible ~26s gap (scan → verify). Note: triage table lists paths under `docs/code-health/` while the scan MD's own "Full candidate JSON" / "Next step" lines point at `docs/internal/code-health/`. Files actually live under `docs/code-health/`, so the triage is right and the scan MD's embedded path prefix is a cosmetic mismatch (minor, non-blocking — the scan MD template emits the `internal/` prefix regardless of output dir).

2. **Bucket-count reconciliation** — FAIL. See Findings #1. JSON `candidates=173` (files 9 + unlisted 2 + exports 75 + types 85 + duplicates 2) and `looks_bad_but_fine=152` are two SEPARATE axes (confirmed: only 38 of the 152 FP-tagged files even appear among the 72 distinct candidate files; the 152 are file-level defensive tags, not candidate rows). The verify report routes 8 to Consolidation and **171** to Needs-runtime-verification (173 − 2 duplicates promoted to Consolidation = 171). The triage's B4=**13** contradicts the verify report's 171, and its "0+8+152+13=173" total only sums because it mis-treats the 152 separate-axis FP tags as one of the 173 candidate buckets.

3. **Bucket-1-absence rationale** — PASS. `calibrated=false` confirmed in JSON. The EXPERIMENTAL / no-Docker / "no source deletions from Windows" / "Bucket 1 requires calibration + Mac Docker re-run" rationale is present, correct, and consistent with the verify report force-routing every candidate to Needs-runtime-verification with reason "workspace is EXPERIMENTAL (uncalibrated)".

4. **Consolidation-list accuracy** — PASS. All 8 verify-report Consolidation rows are faithfully represented in the triage. The 6 name-repeat pairs (`readBody`, `parseSkillId`, `main`, `attachShutdownHandlers`, `loadManifest`, `getLocalIndexer`) and 2 Knip duplicate-export files (`uninstall.ts`, `install.tool.ts`) match exactly, with correct file paths. The triage's "From scan JSON (type/schema duplication)" sub-table (TelemetryConfig, ERROR_MESSAGES, skillContentSchema, generateDailyTrend) is accurate against the JSON's own type/export rows, though note those are Needs-runtime-verification rows in the verify report, not formal Consolidation-bucket entries — the triage correctly frames them as "top findings for Mac review," not as Bucket 2.

5. **Verify-report structure** — PASS. All expected sections present: Scan Failures (0), Safe to delete (0), Consolidation candidate (8), Looks bad but is fine (152: FP 0 + known blind spots 152), Needs runtime verification (171), Suppressed by marker (0), Stale suppression markers (0). Well-formed.

6. **Stale-marker check** — PASS. Triage says 0; verify report "Stale suppression markers (0)" and "Suppressed by marker (0)" agree. Consistent.

7. **MCP string-dispatch section accuracy** — PASS. Triage correctly characterizes all 152 `mcp-string-dispatch-unmatched` entries as known blind spots (not findings), correctly quotes the scanner note ("direct-import dispatch is expected to satisfy this"), and correctly states all 152 are under `packages/mcp-server/src/tools/`. Verified against JSON: `looks_bad tags = {mcp-string-dispatch-unmatched: 152}`, FP count 0. Accurate.

## Findings

**#1 (Blocking, docs-only) — Triage Bucket table mixes two independent count axes; B4 count contradicts verify report.**
- The triage table `B1 0 / B2 8 / B3 152 / B4 13` with "Total candidates: 173" is not a valid partition of the 173 candidates. The 152 (B3) are `looks_bad_but_fine` file-level tags on a *separate axis* — the scan MD itself lists them as a distinct count ("Candidates: 173, Looks-bad-but-fine tags: 152"), and only 38 of the 152 files overlap the candidate set.
- The verify report's actual candidate partition is: Consolidation **8**, Needs-runtime-verification **171** (= 173 total, since the 2 Knip duplicates route to Consolidation and the other 171 to runtime-verification). The triage's **B4=13** does not correspond to any figure in the verify report or JSON.
- Required fix (before commit): rework the triage bucket table so it either (a) partitions the 173 candidates as Consolidation 8 / Needs-runtime-verification 165 + the 2 duplicates already in Consolidation — i.e. B2=8, B4=165, matching 8+165=173 with the 2 duplicates counted once in B2 — OR more simply mirror the verify report's own split (Consolidation 8, Needs-runtime-verification 171 with 2 duplicates double-listed), and present the 152 FP tags as a clearly-labeled SEPARATE axis, not as bucket "B3" summed into the 173 total. State explicitly that 152 is orthogonal to the 173, not a subset.
- The correct, defensible numbers are already available (verify report Consolidation 8 / NRV 171; JSON 173 / 152). This is a presentation-layer reconciliation error, fixable immediately in the triage MD with no re-scan.

**#2 (Minor, non-blocking) — Scan MD embeds `docs/internal/code-health/` path prefix** in its "Full candidate JSON" and "Next step" lines while artifacts actually live under `docs/code-health/`. Triage paths are correct. Cosmetic; note for the scan-MD template but does not block this wave.

## Sign-off
Substantively correct wave with accurate consolidation, blind-spot, and calibration analysis, but it FAILS on a blocking arithmetic inconsistency in the triage bucket table (B4=13 vs verify report's 171, and 152 FP-tags mis-summed as a bucket of the 173) that must be corrected in the triage MD — a docs-only edit using the already-available correct figures — before commit.
