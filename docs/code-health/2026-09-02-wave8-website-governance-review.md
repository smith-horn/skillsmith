# Governance Review — Wave 8 packages/website

**Date:** 2026-09-02
**Reviewer:** governance-specialist
**Branch:** cleanup/code-health-wave-8-website
**Artifacts reviewed:**
- Triage: `docs/code-health/2026-09-02-website-triage.md`
- Verify report (authoritative): `docs/code-health/2026-09-02-033340-packages-website-code-health.md`
- Scan JSON: `docs/code-health/2026-09-02-033322-website-scan-repo.json`

## Checks

| # | Check | Verdict | Notes |
|---|-------|---------|-------|
| 1 | Bucket math (total = B1+B2+B4) | PASS | Verify report: B1=0, B2=12 (rows 23–34), B4=68 (rows 52–119). 0+12+68=80. Triage states exactly this. Scan JSON candidate array = 77 (68 B4 + 9 deps; name-repeats not in JSON). 77+3=80. Consistent. |
| 2 | Scan vs verify discrepancy explained | PASS | Triage lines 17–18 correctly state Knip=77, verify adds 3 name-repeat-detector findings, and names verify as authoritative (80). |
| 3 | FP-tags axis kept separate | PASS | Triage line 30 reports "FP tags: 0" as a distinct line from candidate counts; scan JSON `looks_bad_but_fine: []` and verify "False positives (0)" both confirm 0. Not conflated with the 80/77 candidate counts. |
| 4 | B2 consolidation table complete (all 12) | PASS | All 9 deps present (tailwindcss, @tailwindcss/typography, prettier-plugin-astro, web-vitals, cookie, loupe, picomatch, strip-ansi, strip-literal) + all 3 name-repeats (formatRelativeTime, formatPrice, GET). Matches verify rows 23–34 exactly. |
| 5 | B4 coverage adequate | PASS | Triage lines 94–105 document key groupings (terminology.ts, status-client.ts, auth-callback-handler.ts, types/index.ts, 5 barrel files) with Astro FP rationale. Does not enumerate all 68 but documents groupings — acceptable. |
| 6 | Astro-specific FP context documented | PASS | Triage lines 41–61 document all four required categories: config-loaded plugins, script-tag imports, API route handlers, content collection types. |
| 7 | GET name-repeat classified as Astro FP | PASS | Triage line 85 classifies `GET` in the two RSS route files as an Astro-specific FP (each page exports its own GET handler for server-side routing), LOW priority, not a genuine consolidation candidate. Correct. |
| 8 | EXPERIMENTAL marker → B1=0, no deletions | PASS | Triage lines 32–34 attribute B1=0 to `calibrated=false` EXPERIMENTAL workspace; no source deletions suggested. Scan JSON confirms `"calibrated": false`. |
| 9 | Conservative dep treatment | PASS | No dep is labeled "safe to remove." Verify report notes each dep "requires a human runtime-import check before removal; never auto-classified as safe." Triage B2 table uses "Astro FP?" / priority framing, all in human-review B2. |
| 10 | Stale markers = 0 | PASS | Triage lines 107–109 report 0 stale markers. Verify report "Stale suppression markers (0)" and "Suppressed by marker (0)" confirm. |
| 11 | Post-merge obligations present | PASS | Triage lines 122–131 list Mac-side obligations: SMI issue + squash SHA comment, project update, `docs/code-health/index.md` wave-8 row, calibration, dep-FP confirmation, formatRelativeTime/formatPrice investigation. |
| — | B4 arithmetic phrasing | WARN | Triage line 96 reads "exports (28 minus 9 deps = ~19 code)". The 9 deps live in **B2**, not B4, so subtracting them *within* the B4 breakdown is imprecise phrasing. The B4 total of 68 is correct; only the intermediate explanation is muddled. Non-blocking. |

## Findings

- **All 11 required checks PASS.** Bucket math, scan/verify reconciliation, FP-axis separation, B2 completeness (12/12), B4 groupings, Astro FP context (4 categories), GET-as-FP, EXPERIMENTAL→B1=0, conservative deps, 0 stale markers, and post-merge obligations all verified against the actual verify report and scan JSON.
- **One WARN (non-blocking):** Triage line 96's "exports (28 minus 9 deps = ~19 code)" mixes the B2 dep count into a B4 sub-breakdown. The deps are B2 items; the B4 count (68) is nevertheless correct. Recommend rewording to avoid implying deps are inside B4, but this does not affect any bucket total or classification and does not block the verdict.
- **No fixes required before PASS.** No source deletions were performed (correct for an uncalibrated EXPERIMENTAL workspace); no dep was declared safe to remove; no FP conflation; no misclassification of the Astro route handlers.

## Verdict

**PASS**

The triage checkpoint is correct, internally consistent, and complete. Bucket totals reconcile against the authoritative verify report (0+12+68=80) and against the scan JSON (77 Knip + 3 name-repeat = 80). The Astro-specific false-positive context is fully documented, the `GET` name-repeat is correctly identified as an Astro route FP rather than a consolidation target, dependency treatment is appropriately conservative, EXPERIMENTAL status correctly yields B1=0 with no source deletions, and post-merge Mac obligations are enumerated. The single WARN (line 96's B4 sub-arithmetic phrasing) is cosmetic and does not affect any classification.
