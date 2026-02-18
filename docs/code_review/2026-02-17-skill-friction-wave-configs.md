# Code Review: Skill Friction Wave Configs

**Date**: February 17, 2026
**Reviewer**: Code Review Agent (claude-opus-4-6)
**Initiative**: Skill Friction Reduction (SMI-2626 through SMI-2635)
**Status**: PASS (with fixes applied)

---

## Files Reviewed

| # | File | Lines | Type |
|---|------|-------|------|
| 1 | `.claude/hive-mind/skill-friction-wave-1.yaml` | 105 | Wave config |
| 2 | `.claude/hive-mind/skill-friction-wave-2.yaml` | 122 | Wave config |
| 3 | `.claude/hive-mind/skill-friction-wave-3.yaml` | 104 | Wave config |
| 4 | `.claude/hive-mind/analysis-pipeline-wave-1.yaml` | 80 | Wave config |
| 5 | `docs/internal/execution/analysis-to-execution-pipeline.md` | 260 | Execution plan |

**Reference configs used for pattern comparison:**
- `.claude/hive-mind/retro-improvements-wave-1.yaml` (issues format, token budget fields)
- `.claude/hive-mind/backlog-wave-1.yaml` (agents + tasks format, allowed_tools)
- `.claude/hive-mind/skill-conflict-wave-1.yaml` (objective field, quality gates as objects)

---

## Strengths

- Consistent structure across all 4 wave configs; follows the `backlog-wave-1.yaml` agents+tasks pattern
- Clear task descriptions with numbered steps and explicit constraints
- All quality gates use the standard `docker exec skillsmith-dev-1 npm run preflight` command
- Commit messages follow conventional commits format (`feat(skills):`, `chore(skills):`, `docs(process):`)
- File naming uses kebab-case throughout
- No duplicate content across configs
- `depends_on` chain is valid: wave-2 -> wave-1, wave-3 -> wave-1, analysis-pipeline -> wave-3
- The `depends_on_task` advisory in wave 2 (SMI-2630) is well-documented with the intra-wave ordering caveat
- Security-sensitive constraints are explicit (never `--no-verify`, never force-push, `execFileSync` with array args)
- All files under 500 lines
- Execution plan is thorough with 6 well-defined steps, abort/rollback procedures, decision matrix, and reusable checklist

---

## Issues Found and Fixes Applied

### Issue 1: Missing `claude-skill-*` prefix pattern in wave 3 (MEDIUM)

**File**: `.claude/hive-mind/skill-friction-wave-3.yaml`
**Finding**: SMI-2632 (skill deduplication) mentioned `*-claude-skill` and `*-skill` patterns but missed the `claude-skill-*` prefix pattern. Actual directory listing shows 5 directories matching `claude-skill-*` (ci-doctor, docker-optimizer, flaky-test-detector, security-auditor, version-sync), all with bare-name equivalents.

**Fix applied**:
- Added `Bash(rm -rf ~/.claude/skills/claude-skill-*)` to `allowed_tools`
- Added `claude-skill-* variants` to the task description's expected duplicates list

### Issue 2: Missing `token_estimate` and `fits_200k` fields (MINOR)

**Files**: All 4 wave configs
**Finding**: The `retro-improvements-wave-1.yaml` reference config includes `token_estimate` and `fits_200k` fields. The execution plan's own Step 2 quality gate requires "Token estimates per wave (all under 200K)". The new configs omitted these fields, creating an inconsistency with both the reference pattern and the pipeline's stated quality criteria.

**Fix applied**: Added `token_estimate` and `fits_200k: true` to all 4 configs:

| Config | Token Estimate | Rationale |
|--------|---------------|-----------|
| skill-friction-wave-1 | 45,000 | 3 small edit tasks (~15K each) |
| skill-friction-wave-2 | 75,000 | 3 new-build tasks (~25K each) |
| skill-friction-wave-3 | 50,000 | 1 cleanup task (~30K) + 1 script task (~20K) |
| analysis-pipeline-wave-1 | 25,000 | Single documentation task |

### Issue 3: YAML validation gate runs outside Docker (MINOR)

**File**: `docs/internal/execution/analysis-to-execution-pipeline.md`
**Finding**: Step 5 quality gate used `python3 -c "import yaml; ..."` without Docker prefix. CLAUDE.md requires all code execution in Docker.

**Fix applied**: Changed to `docker exec skillsmith-dev-1 python3 -c "import yaml; ..."`.

---

## Issues Reviewed and Accepted

### Accepted 1: `Bash(rm -rf ~/.claude/skills/*-skill)` glob scope

The `*-skill` glob could theoretically match skills not intended for deletion (e.g., a future skill named `my-cool-skill`). However, this risk is mitigated by:
- The task description's Step 1 requires a prerequisite audit before any deletions
- Step 3 explicitly says "Do NOT delete skills that have no bare-name equivalent"
- The glob is an `allowed_tools` grant (permission), not an automatic execution; the worker still must make deliberate decisions
- Current actual matches (`doc-hygiene-skill`, `stripe-mcp-skill`, `vercel-github-actions-skill`) all have bare-name equivalents

**Verdict**: Acceptable. The audit-first workflow in the task description provides sufficient safeguards.

### Accepted 2: `depends_on_task` is a non-standard field

Wave 2's SMI-2630 uses `depends_on_task: smi-2628` which does not appear in any reference config. This is an advisory annotation (the YAML comment explicitly says "Claude Flow does not enforce intra-wave task order"). Custom advisory fields are harmless and improve documentation.

**Verdict**: Acceptable. Enhances readability without structural risk.

### Accepted 3: Wave 3 depends only on wave 1 (not wave 2)

Wave 3's SMI-2632 (deduplication) could theoretically conflict with wave 2 (which creates new skill files). However, wave 2 creates new skills in new directories (`~/.claude/skills/ship/`, `.claude/skills/supabase/`) while wave 3 only deletes prefixed duplicates of existing skills. No file overlap.

**Verdict**: Acceptable. Dependencies are correctly minimal.

### Accepted 4: SMI-2634 not referenced in any wave config

The initiative range header says "SMI-2626 through SMI-2633" for waves 1-3. SMI-2634 (`fast-xml-parser` override, PR #172) is a separate npm vulnerability fix, not part of this initiative. SMI-2635 (analysis pipeline) is correctly in its own wave config.

**Verdict**: Correct. No gap in issue coverage.

---

## Metrics

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| File count | 5 | -- | -- |
| Max file size | 260 lines | 500 lines | PASS |
| Naming convention | kebab-case | kebab-case | PASS |
| Duplicate content | 0 | 0 | PASS |
| Secrets exposed | 0 | 0 | PASS |
| Command injection patterns | 0 | 0 | PASS |
| Linear issue coverage | 9/9 (SMI-2626-2633, SMI-2635) | 100% | PASS |
| Quality gates present | 4/4 configs | 100% | PASS |
| Token budgets present | 4/4 configs (after fix) | 100% | PASS |
| Commit message format | 4/4 conventional commits | 100% | PASS |

---

## Action Items

All items resolved in this review. Zero deferred.

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Missing `claude-skill-*` pattern in wave 3 | Medium | Fixed |
| 2 | Missing `token_estimate`/`fits_200k` fields | Minor | Fixed |
| 3 | YAML validation gate outside Docker | Minor | Fixed |
