# Wave 8 Triage — packages/website

**Date:** 2026-09-02
**Branch:** cleanup/code-health-wave-8-website
**Machine:** Windows 11, wrsmith108

## Scan artifacts

| File | Path |
|------|------|
| Scan JSON | `docs/code-health/2026-09-02-033322-website-scan-repo.json` |
| Scan MD | `docs/code-health/2026-09-02-033322-website-scan-repo.md` |
| Verify MD | `docs/code-health/2026-09-02-033340-packages-website-code-health.md` |

## Triage results

Note: Scan JSON reports 77 candidates (Knip static analysis). Verify-candidates.sh adds 3
name-repeat-detector findings (not in scan JSON). Verify report is authoritative: 80 total.

Candidate partition (80 total — from verify report):

| Bucket | Count | Action |
|--------|-------|--------|
| B1 Safe-to-delete | 0 | EXPERIMENTAL workspace — no source deletions |
| B2 Consolidation candidate | 12 | Human review (9 deps from Knip + 3 name-repeats from verify) |
| B4 Needs-runtime-verification | 68 | EXPERIMENTAL + large Astro bundler-external FP class |

**Total candidates (verify):** 80 (B1 0 + B2 12 + B4 68 = 80)
**Scan JSON candidates:** 77 (Knip static)
**FP tags:** 0 (none from scan; Astro FP class documented below)

## Why no Bucket 1 items

EXPERIMENTAL workspace (`calibrated=false`). Source deletions not performed from Windows.
Bucket 1 requires calibration + Mac Docker re-run.

## Coverage run status

Not attempted — uncalibrated workspace.

## Astro-specific false positive context (wave plan directive)

**Wave plan note:** "Astro-based. Bundler-external deps generate noise — a large Bucket 4 count is
expected. Call out any Astro-specific false positives in the triage checkpoint's Bucket 3 section."

Astro generates four categories of false positives that Knip cannot resolve statically:

1. **Config-loaded plugins**: Tailwind, PostCSS, and Prettier plugins are loaded via config files
   (`.prettierrc`, `tailwind.config.*`, `astro.config.mjs`) rather than TypeScript imports.
   Knip sees these as unused deps.

2. **Script-tag imports**: Astro's `<script>` tags in `.astro` files reference TypeScript modules
   (e.g., `src/scripts/web-vitals.ts`) that load independently from the TypeScript module graph.
   Both the file and its dep (`web-vitals`) appear as "unused."

3. **API route handlers**: Astro pages export named `GET`/`POST`/`PUT` handlers for SSR.
   These are legitimate Astro route handlers — flagging `GET` as a "name-repeat" because two
   different page files both export `GET` is an Astro-specific false positive.

4. **Content collection types**: Astro's content collection types and utility exports are
   consumed via Astro's own build pipeline, not standard Node.js imports.

## Consolidation candidates (B2)

### Dependencies — likely Astro/Tailwind FPs

| Package | File | Likely use | Astro FP? | Priority |
|---------|------|-----------|-----------|----------|
| `tailwindcss` | package.json | PostCSS / Astro integration | **YES** — loaded via PostCSS config | LOW — expected FP |
| `@tailwindcss/typography` | package.json | Tailwind typography plugin | **YES** — loaded via tailwind.config | LOW — expected FP |
| `prettier-plugin-astro` | package.json | Prettier `.astro` formatting | **YES** — loaded via .prettierrc | LOW — expected FP |
| `web-vitals` | package.json | `src/scripts/web-vitals.ts` | **YES** — loaded via Astro `<script>` tag | LOW — expected FP |
| `cookie` | package.json | Middleware/API route cookies | MAYBE — check Astro middleware | MEDIUM |
| `loupe` | package.json | Test utilities / vitest dep | MAYBE — may be transitive | MEDIUM |
| `picomatch` | package.json | Glob matching in config/scripts | MAYBE — check scripts/ | MEDIUM |
| `strip-ansi` | package.json | Terminal output in scripts | MAYBE — check scripts/ | MEDIUM |
| `strip-literal` | package.json | Code processing utility | MAYBE — check usage | MEDIUM |

### Name-repeat findings (from verify, not scan JSON)

| Finding | Files | Priority | Note |
|---------|-------|----------|------|
| `formatRelativeTime` | `lib/inventory-view.ts`, `lib/team-activity-format.ts` | HIGH | Different relative-time format functions in two lib files — genuine consolidation candidate |
| `formatPrice` | `lib/pricing-data.ts`, `lib/pricing.ts` | HIGH | Pricing formatter in two related files — genuine consolidation candidate |
| `GET` | `pages/blog/rss.xml.ts`, `pages/status.rss.xml.ts` | LOW | **Astro-specific FP** — each Astro page exports its own `GET` handler; these are independent RSS endpoints, not duplications |

### Observations from scan JSON name-repeats (both in B4)

| Name | Files | Category | Note |
|------|-------|----------|------|
| `isRovingNavKey` | `lib/status-poller.ts`, `lib/status-client.ts` | exports | Same utility in two status files — possible consolidation; both in B4 |
| `IncidentUpdateContent` | `lib/status-client.ts`, `lib/status-render.ts` | types | Same type in two status files — possible type-consolidation; both in B4 |

## Needs-runtime-verification candidates (B4) — summary

68 candidates across: exports (28 minus 9 deps = ~19 code), types (35), files (5), plus unlisted/binaries.

Key groupings:
- **`constants/terminology.ts`** (6 candidates): QUARANTINE_SEVERITY, SKILL_CATEGORIES, PRICING_TIERS, CONTACT_TOPICS, getTrustTierById, getQuarantineSeverityById — UI terminology constants used by Astro components via the content pipeline
- **`lib/status-client.ts`** (11 candidates): Full status-polling state machine exports and types — likely used by Astro `<script>` tags invisible to Knip
- **`lib/auth-callback-handler.ts`** (5 candidates): Auth flow helpers — may be used by Astro SSR pages
- **`src/types/index.ts`** (8 candidates): Core domain types (Skill, SkillCategory, Feature, etc.) — used by Astro content collections and components
- **5 index/barrel files**: All `src/components/index.ts`, `src/constants/index.ts`, `src/lib/api.ts`, `src/scripts/web-vitals.ts`, `src/components/auth/index.ts`

High Astro FP likelihood: constants and types used by `.astro` component files that import them through Astro's own module resolution (not the TS module graph Knip analyzes). Mac calibration should cross-reference B4 exports against `.astro` files.

## Stale suppression markers

0 found. No `audit:code-health-ok` markers in `packages/website/src/`.

## Wave objective and success criteria

This wave establishes a baseline scan of `packages/website` (Astro). 80 candidates (77 Knip + 3
name-repeat): 12 in B2 (human review) and 68 in B4 (all EXPERIMENTAL + high Astro FP class).

The large B4 count (68) is **expected** per wave plan — Astro's bundler-external architecture generates
significant noise for Knip's static TypeScript analysis. Mac calibration must cross-reference against
`.astro` component files before any promotion from B4 to B1.

**Genuine consolidation opportunities:** `formatRelativeTime` and `formatPrice` in B2 are worth Mac review as real duplications. `isRovingNavKey` and `IncidentUpdateContent` in B4 are worth checking once calibrated.

## Post-merge obligations (Mac)

- [ ] Create/update SMI issue; comment with squash SHA
- [ ] Post project update using PR Business Summary
- [ ] Update `docs/code-health/index.md` with wave-8 row
- [ ] Calibrate `packages/website` — cross-reference B4 exports against `.astro` files before promotion
- [ ] Verify Tailwind/prettier-plugin-astro/web-vitals deps are expected FPs (confirm via config files)
- [ ] Investigate `formatRelativeTime` and `formatPrice` — genuine consolidation candidates
- [ ] Confirm `GET` in 2 RSS pages is Astro route FP (not actionable)
- [ ] Check `isRovingNavKey` and `IncidentUpdateContent` — same symbol in two status files
