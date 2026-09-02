# PR Review — Wave 8 packages/website

**Date:** 2026-09-02
**Reviewer:** governance-specialist (pre-merge, 14-check)
**Branch:** cleanup/code-health-wave-8-website
**PR type:** Documentation-only (all files under `docs/code-health/`; no source modified)
**Artifacts reviewed:**
- Triage: `docs/code-health/2026-09-02-website-triage.md`
- Verify report (authoritative): `docs/code-health/2026-09-02-033340-packages-website-code-health.md`
- Governance review: `docs/code-health/2026-09-02-wave8-website-governance-review.md`
- Scan JSON: `docs/code-health/2026-09-02-033322-website-scan-repo.json`

## Checklist (14 checks)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Scan JSON valid structure (calibrated field, candidates array, FP tags) | PASS | `calibrated: false`, `mode: package`, `scan_status.{comprehensive,production}: has_issues`. `candidates` array present (77 entries: 5 files + 9 deps + 63 exports/types). `looks_bad_but_fine: []` FP axis present and empty. Well-formed JSON. |
| 2 | Verify report bucket partition sums (B1+B2+B4 = total) | PASS | B1=0 (rows 11–14), B2=12 (rows 23–34), B4=68 (rows 52–119, counted: 5 files + 63 exports/types). 0+12+68=80. Matches triage line 28. |
| 3 | Triage explains scan-vs-verify discrepancy (77 Knip + 3 name-repeat = 80) | PASS | Triage lines 17–18 and 28–30 state Knip scan JSON = 77, verify adds 3 name-repeat-detector findings (formatRelativeTime, formatPrice, GET) not in JSON, verify authoritative at 80. Correct and explicit. |
| 4 | All B2 items from verify documented in triage | PASS | Verify B2 (12): 9 deps + 3 name-repeats. Triage B2 dep table (lines 67–77) lists all 9 (tailwindcss, @tailwindcss/typography, prettier-plugin-astro, web-vitals, cookie, loupe, picomatch, strip-ansi, strip-literal); name-repeat table (lines 82–85) lists all 3. 12/12 documented. |
| 5 | EXPERIMENTAL marker correctly applied (B1=0, no source deletions) | PASS | Scan JSON `calibrated: false`. Triage lines 24, 32–34, 39 attribute B1=0 to uncalibrated EXPERIMENTAL workspace; no source deletions; coverage run correctly skipped. Verify "Safe to delete (0)". |
| 6 | Astro FP context adequate (config plugins, script-tag imports, API route handlers, content collections) | PASS | Triage lines 46–61 document all four required categories with concrete examples (PostCSS/tailwind.config/.prettierrc; web-vitals via `<script>`; GET/POST SSR handlers; content collection types). |
| 7 | GET name-repeat correctly classified as Astro route FP | PASS | Triage line 85 classifies `GET` (rss.xml.ts, status.rss.xml.ts) as Astro-specific FP — independent RSS endpoints each exporting their own GET handler, LOW priority, not a duplication. Correct. |
| 8 | Genuine consolidation candidates (formatRelativeTime, formatPrice) identified | PASS | Triage lines 83–84 flag both HIGH priority as genuine consolidation candidates across two lib files each. Post-merge obligation (line 129) reinforces investigation. |
| 9 | Conservative dep treatment (no dep marked safe-to-remove without runtime check) | PASS | All 9 deps routed to B2 human-review; none in B1. Verify report notes each "requires a human runtime-import check before removal; never auto-classified as safe." Triage uses "Astro FP?"/priority framing, no removal directive. |
| 10 | Governance review verdict PASS | PASS | Governance review line 36 verdict = **PASS**; all 11 of its checks PASS with one non-blocking WARN (line 96 B4 sub-arithmetic phrasing). |
| 11 | Stale markers reported as 0 | PASS | Triage lines 107–109 report 0. Verify report "Stale suppression markers (0)" and "Suppressed by marker (0)" confirm. |
| 12 | Post-merge obligations cover Linear/SMI, index.md, Mac calibration | PASS | Triage lines 124–131: SMI issue + squash SHA comment, project update, `docs/code-health/index.md` wave-8 row, calibration cross-ref against `.astro`, dep-FP confirmation, formatRelativeTime/formatPrice investigation, GET-FP confirmation, isRovingNavKey/IncidentUpdateContent check. |
| 13 | B4 summary gives adequate groupings without enumerating all 68 | PASS | Triage lines 94–105 group by file (terminology.ts ×6, status-client.ts ×11, auth-callback-handler.ts ×5, types/index.ts ×8, 5 barrel files) with Astro FP rationale. Adequate without full enumeration. |
| 14 | Large B4 count (68) contextualized as expected Astro noise | PASS | Triage lines 26, 43–44, 111–118 frame 68 as expected per wave-plan (Astro bundler-external architecture generates Knip noise); calibration must cross-reference `.astro` before any B4→B1 promotion. |

## Findings

- **(Check 3, cross-verified)** Independent recount confirms reconciliation: scan JSON candidates = 5 files + 9 deps + 63 exports/types = **77**; verify adds 3 name-repeat findings = **80**; bucket partition 0+12+68 = **80**. All three artifacts agree.
- **(Check 13, minor — non-blocking, already caught upstream)** Triage line 96 reads "exports (28 minus 9 deps = ~19 code)". The 9 deps are B2 items, not B4, so subtracting them *inside* the B4 breakdown is imprecise phrasing. The B4 total (68) is nevertheless correct and every other count reconciles. The governance review already flagged this as its sole WARN (line 26). Cosmetic; does not affect any bucket total, classification, or the Mac-side calibration inputs. Not a merge blocker for a docs-only PR, but recommend rewording on the next edit to avoid implying deps live in B4.
- No source code touched; no deletions performed (correct for an uncalibrated EXPERIMENTAL workspace); no FP conflation; no dep declared safe-to-remove; Astro route handlers correctly classified as FPs. All P-5 concurrency-audit checks are N/A (docs-only diff, no window-global/listener/source changes).

## Verdict

**PASS**

All 14 checks pass. The three data artifacts (scan JSON, verify report, triage) are internally consistent and reconcile arithmetically (77 Knip + 3 name-repeat = 80 = 0 B1 + 12 B2 + 68 B4). Astro-specific false-positive context is complete across all four required categories, the `GET` name-repeat is correctly identified as an Astro route FP, `formatRelativeTime`/`formatPrice` are surfaced as genuine consolidation candidates, dependency treatment is appropriately conservative, EXPERIMENTAL status correctly yields B1=0 with no source deletions, stale markers are 0, and post-merge Mac obligations (Linear/SMI, index.md, calibration) are enumerated. The single carried-over WARN (line 96's B4 sub-arithmetic phrasing) is cosmetic and does not block a documentation-only merge.
