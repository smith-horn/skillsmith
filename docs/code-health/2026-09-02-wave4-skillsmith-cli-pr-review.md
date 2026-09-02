# Wave 4 Pre-Merge Gate — cleanup/code-health-wave-4-skillsmith-cli

**Date:** 2026-09-02
**Branch:** `cleanup/code-health-wave-4-skillsmith-cli` → `main`
**Reviewer:** pre-merge gate (docs-only PR)
**Verdict:** PASS — safe to merge

## Summary

Docs-only PR adding Wave 4 code-health audit artifacts for `packages/skillsmith-cli`. Exactly 5 files, all under `docs/code-health/`, additions only, 1 commit ahead of `main`. No `packages/` or `supabase/` source or migration content. Bucket counts reconcile across all four artifacts (1 consolidation candidate, B1=B4=0, 0 FP tags). The single finding (`@skillsmith/cli` flagged unused) is independently confirmed as a runtime-live dependency Knip can't resolve statically, correctly routed to human-review Bucket 2 rather than deletion. All 14 pre-merge checks either PASS or SKIP with a documented reason (docs-only diff has no code/SQL/edge-function/schema surface to trigger them).

## Diff Verification

| Check | Result |
|-------|--------|
| Diff is truly docs-only (`docs/code-health/` only) | PASS — `git diff main...HEAD --name-only` yields 0 files outside `docs/code-health/` |
| Exactly 5 expected files staged | PASS — see file list below |
| Branch exactly 1 commit ahead of `main` | PASS — `git log main..HEAD --oneline` = 1 line (`622400c4`) |
| No `packages/` content | PASS — 0 matches for `^packages/` |
| No `supabase/` content | PASS — 0 matches for `^supabase/` |
| Additions only (no deletions/renames) | PASS — `--diff-filter=DR` empty; `+228 / -0` across 5 files |

**Commit:** `622400c4 chore(code-health): wave 4 — packages/skillsmith-cli audit (experimental workspace)`

**5 files (228 insertions):**

1. `docs/code-health/2026-09-02-030947-skillsmith-cli-scan-repo.json` — scan JSON (25 lines)
2. `docs/code-health/2026-09-02-030947-skillsmith-cli-scan-repo.md` — scan MD (13 lines)
3. `docs/code-health/2026-09-02-031006-packages-skillsmith-cli-code-health.md` — verify MD (49 lines)
4. `docs/code-health/2026-09-02-skillsmith-cli-triage.md` — triage MD (71 lines)
5. `docs/code-health/2026-09-02-wave4-skillsmith-cli-governance-review.md` — governance review MD (70 lines)

All five expected artifact types present (scan JSON, scan MD, verify MD, triage MD, governance review MD).

## 14-Check Pre-Merge Gate

Dispatch note: the standard cross-family dispatch (ADR-128) is waived here — this is a docs-only diff with zero code, SQL, migration, or edge-function surface, so 13 of 14 checks have no trigger condition present and the one applicable check (PR-14) is a mechanical file-count/scope assertion. Verified directly against the diff.

| # | Check | Result | Reason |
|---|-------|--------|--------|
| PR-01 | Migration ordering via merge-base | SKIP | No `supabase/migrations/` files in diff |
| PR-02 | RLS partition policy propagation | SKIP | No SQL/RLS changes |
| PR-03 | DROP TABLE FK cascades | SKIP | No SQL/DDL changes |
| PR-04 | Function `search_path` | SKIP | No SQL functions in diff |
| PR-05 | `schema_version` sequence | SKIP | No migration/schema changes |
| PR-06 | Lock profile | SKIP | No migration changes |
| PR-07 | Silent catch at write paths | SKIP | No source code (`.ts`/`.js`) changes |
| PR-08 | Upsert caller completeness on column change | SKIP | No schema/upsert changes |
| PR-09 | Edge function surface registration | SKIP | No `supabase/functions/` or config.toml changes |
| PR-10 | Export continuity | SKIP | No package source / public-API changes |
| PR-11 | Enum consumer completeness | SKIP | No enum/type changes |
| PR-12 | Plan-vs-diff completeness | PASS (adapted) | Diff exactly matches the Wave 4 objective: baseline scan of `packages/skillsmith-cli` producing scan+verify+triage+governance artifacts. No scope creep; no missing artifacts. |
| PR-13 | SQL comment accuracy | SKIP | No SQL in diff |
| PR-14 | `audit:standards` delta | PASS | Docs-only under `docs/code-health/` — no source files, so no `audit:standards` surface affected (no <500-line-code, lint, or standards-audit impact). Markdown/JSON only. |

## Content Accuracy Spot-Checks (docs-only substantive validation)

- **Bucket reconciliation** — JSON (`candidates: [1]`, `looks_bad_but_fine: []`), scan MD ("Candidates: 1, ... tags: 0"), verify MD (Consolidation 1, all others 0), triage (B1=0/B2=1/B4=0, total 1) all agree. No drift.
- **Single finding is accurate to source** — `packages/skillsmith-cli/package.json` line 14 is `"@skillsmith/cli": "^0.8.2"`; matches JSON line/col (14/6) and category (`dependencies`).
- **Correct B2 (not B1) routing confirmed live** — `packages/skillsmith-cli/bin.js` lines 14–16 use `createRequire(import.meta.url)` + `require.resolve('@skillsmith/cli/package.json')` + `require('@skillsmith/cli/package.json')`. Knip cannot see these dynamic resolutions, so it flags the dep as unused; it is in fact runtime-live and deleting it would break the wrapper. The pipeline correctly refused to auto-classify it as safe. Verdict verified against actual source.
- **`calibrated: false` / EXPERIMENTAL** consistent across JSON, scan MD header, and triage's Bucket-1-absence rationale (no Docker/calibration on the Windows machine).

## Observations (non-blocking, no merge impact)

- Scan MD (lines 12–13) references `docs/internal/code-health/...` paths for the JSON and next-step command, but the artifacts actually live in `docs/code-health/` (the harness's default vs. this wave's chosen location). This is a stale self-reference inside an audit artifact, not a code defect and not a merge blocker. The Mac reviewer may correct the two paths post-merge if desired.
- Triage line 71 suggests `grep ... packages/skillsmith-cli/src/`, but the package has no `src/` dir (runtime use lives in `bin.js` at package root). The package-wide grep on line 50 already covers the real usage, so the conclusion stands.
- No `docs/code-health/index.md` exists in this directory; per the Mac post-merge obligations checklist, index updating is deferred to the Mac reviewer (documented in the triage's Post-merge obligations).
- Unrelated working-tree noise (`docs/internal` submodule pointer, untracked `.claude/proven-config.json`) is NOT part of this branch's commit and does not affect the merge.

## Sign-off

**PASS — safe to merge.** Diff is docs-only, correctly scoped to `docs/code-health/`, exactly 5 expected files, 1 commit ahead of `main`, additions only, zero `packages/`/`supabase/` content. All 14 pre-merge checks pass or SKIP with documented reason. The one substantive finding is accurate and correctly routed. Merge, then complete the Mac-side post-merge obligations (SMI issue + comment, project update, `index.md` row, runtime confirmation of `@skillsmith/cli`).
