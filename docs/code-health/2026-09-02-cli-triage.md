# Wave 1 Triage — packages/cli

**Date**: 2026-09-02  
**Branch**: cleanup/code-health-wave-1-cli  
**Machine**: Windows 11 (wrsmith108)

## Scan artifacts

- JSON: `2026-09-02-020424-cli-scan-repo.json`
- Scan summary: `2026-09-02-020424-cli-scan-repo.md`
- Verify report: `2026-09-02-020622-packages-cli-code-health.md`

## Triage results

| Bucket | Count | Action |
|--------|-------|--------|
| Safe to delete | 0 | — |
| Consolidation candidate | 4 | Human judgment only — deferred |
| Looks bad but is fine | 28 | No action |
| Needs runtime verification | 151 | Coverage run failed on Windows; re-run in Docker on Mac |

## Coverage run status

Coverage run **failed** (`verify-candidates.sh` exited non-zero for `packages/cli`).  
This is expected on Windows without Docker — the Vitest run requires test infrastructure not available in this environment.  
All calibrated-workspace candidates defaulted to `coverage_state=absent` and were routed to Bucket 4 (Needs runtime verification).

**No Safe-to-delete items this wave.** Re-run on a Mac with Docker to produce real Bucket 1 verdicts.

## Consolidation candidates (4) — not addressed this wave

| Name / finding | Files | Notes |
|---|---|---|
| Knip duplicate-export | `src/templates/skill.md.template.ts` | Human review required |
| Knip duplicate-export | `src/templates/readme.md.template.ts` | Human review required |
| Knip duplicate-export | `src/templates/changelog.md.template.ts` | Human review required |
| `getInstalledSkills` name-repeat | `recommend.helpers.ts`, `utils/skills-directory.ts` | Human review required |

## False positives (28) — no action

All 28 are CLI command-factory files (named export + default export in same file — expected convention).  
14 duplicate Knip findings for those same files are correctly folded into the same bucket.
