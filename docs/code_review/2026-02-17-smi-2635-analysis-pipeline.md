# Code Review: SMI-2635 — Formalize Analysis-to-Execution Pipeline

**Date**: February 17, 2026
**Reviewer**: governance-specialist
**Scope**: Execution plan + 4 wave configs for SMI-2635 and surrounding Skill Friction Reduction initiative

---

## Files Reviewed

| File | Lines | Status |
|------|-------|--------|
| `docs/internal/execution/analysis-to-execution-pipeline.md` | 290 | PASS |
| `.claude/hive-mind/analysis-pipeline-wave-1.yaml` | 75 | PASS WITH WARNINGS |
| `.claude/hive-mind/skill-friction-wave-1.yaml` | 100 | PASS |
| `.claude/hive-mind/skill-friction-wave-2.yaml` | 118 | PASS |
| `.claude/hive-mind/skill-friction-wave-3.yaml` | 97 | PASS WITH WARNINGS |

All files are well under the 500-line limit.

---

## Findings

### BLOCKING

None.

---

### WARNING

#### W1 — `analysis-pipeline-wave-1.yaml`: `depends_on` is incomplete

**File**: `.claude/hive-mind/analysis-pipeline-wave-1.yaml`, line 10

**Issue**: The wave lists `depends_on: [skill-friction-wave-1]` but its task description explicitly reads artifacts from all three skill-friction waves (lines 51–53):

```yaml
- .claude/hive-mind/skill-friction-wave-1.yaml
- .claude/hive-mind/skill-friction-wave-2.yaml
- .claude/hive-mind/skill-friction-wave-3.yaml
```

If an executor runs this wave concurrently after only wave-1 completes, waves 2 and 3 may not yet exist. The `depends_on` field controls sequencing for automated orchestrators.

**Recommended fix**: Change `depends_on` to reference the last wave in the skill-friction chain:

```yaml
depends_on:
  - skill-friction-wave-3
```

Wave-3 already depends on wave-1, so the full chain is implied. This correctly blocks analysis-pipeline-wave-1 from running until all three skill-friction waves are done.

**Note**: If the intent is that the pipeline doc was authored *before* the waves executed (i.e., the doc itself is the artifact, not a synthesis of wave outputs), then `depends_on: [skill-friction-wave-1]` is defensible. In that case, add a clarifying comment to the YAML.

---

#### W2 — `skill-friction-wave-3.yaml`: Broad `rm -rf` in `allowed_tools`

**File**: `.claude/hive-mind/skill-friction-wave-3.yaml`, line 37

**Issue**: The worker's `allowed_tools` includes:

```yaml
- Bash(rm -rf ~/.claude/skills/*)
```

This is the only instance of a destructive `rm -rf` pattern across all wave configs in `.claude/hive-mind/` (confirmed by grep). Granting this as a pre-authorized tool is high-risk:

- A path expansion error (e.g., `~/.claude/skills/ *` with a space) could wipe unintended directories
- The glob `~/.claude/skills/*` deletes all skills, not just the specific prefixed duplicates targeted by SMI-2632
- The task description already provides a careful 5-step prerequisite audit before deletion — the broad tool grant undermines that safety protocol by pre-authorizing the destructive action

**Recommended fix**: Scope the deletion more tightly or remove it from `allowed_tools` and require explicit approval per deletion:

```yaml
- Bash(rm -rf ~/.claude/skills/*-claude-skill)
- Bash(rm -rf ~/.claude/skills/*-skill)
```

Or remove the rm entry entirely and let the agent request approval at runtime (agents can still propose deletions; the user confirms).

---

### INFO

#### I1 — `analysis-pipeline-wave-1.yaml`: Missing `resource_profile` key

**File**: `.claude/hive-mind/analysis-pipeline-wave-1.yaml`

The established format (seen in `backlog-wave-1.yaml` and the template in the execution plan itself) uses `resource_profile: laptop`. This file uses `resource_profile: laptop` — wait, it is present on line 14. No issue here.

*(Confirmed present: line 14 `resource_profile: laptop`.)*

---

#### I2 — `analysis-to-execution-pipeline.md`: No wave overview table

**File**: `docs/internal/execution/analysis-to-execution-pipeline.md`

The established execution plan format (see `retro-improvements-implementation-plan.md`, lines 27–37) opens with a wave overview table. This document has `**Waves**: 1` in the header but no overview table.

This is appropriate for the document's nature — it is a *pipeline runbook* rather than a standard wave execution plan, so the table is not a meaningful addition. The document clearly calls itself a "6-step pipeline" runbook. No action required, noting for awareness.

---

#### I3 — `skill-friction-wave-2.yaml`: `depends_on_task` is a non-standard field

**File**: `.claude/hive-mind/skill-friction-wave-2.yaml`, line 65

SMI-2630 uses `depends_on_task: smi-2628` at the task level. This field does not appear in any other wave config in the repository and is not part of the documented schema in `analysis-to-execution-pipeline.md` (Step 5b template). Claude Flow will likely ignore this field.

The intra-wave dependency is correctly documented in the task description prose ("This builds on wave 1's SMI-2628 changes"). The `depends_on_task` field is harmless but may mislead future wave authors into believing task-level dependency enforcement is supported.

**Recommendation**: Remove `depends_on_task: smi-2628` and rely on the prose description, or add a comment noting it is advisory only:

```yaml
# NOTE: depends_on_task is advisory — Claude Flow does not enforce intra-wave task order.
# SMI-2630 should be executed after SMI-2628 completes within this wave.
depends_on_task: smi-2628
```

---

## Standards Checklist

| Check | Result |
|-------|--------|
| File naming: kebab-case | PASS — all files use kebab-case |
| File length < 500 lines | PASS — longest is 290 lines |
| YAML syntax valid | PASS — all 4 configs parse cleanly |
| Required YAML fields present | PASS — name, description, topology, resource_profile, agents, tasks, quality_gates, completion all present |
| `quality_gates` includes preflight | PASS — all configs use `docker exec skillsmith-dev-1 npm run preflight` |
| Commit messages: conventional commits | PASS — all use `type(scope): description (SMI-NNNN)` format |
| Linear issue IDs in range (SMI-2626 to SMI-2635) | PASS — all IDs verified in range |
| `depends_on` references valid wave names | PARTIAL — wave names exist; completeness concern raised in W1 |
| No duplicate content across configs | PASS — tasks are distinct across all configs |
| No secrets or hardcoded credentials | PASS |
| No command injection patterns | PASS — `execFileSync` pattern referenced in smi-2633 task |
| Markdown well-formed | PASS |
| Execution plan has issue reference | PASS — SMI-2635 in header |
| Referenced file paths exist | PASS — all paths verified: `retro-improvements-implementation-plan.md`, `skill-conflict-resolution-implementation-plan.md`, `usage-report-skills-assessment.md` all confirmed present |

---

## Summary

**Total findings**: 5 (0 blocking, 2 warnings, 3 info)

The artifacts are well-structured and closely follow established patterns. The two warnings are actionable:

- **W1** (`depends_on` in `analysis-pipeline-wave-1.yaml`) is a sequencing correctness issue — fix recommended before executing the wave under an automated orchestrator.
- **W2** (broad `rm -rf` in `skill-friction-wave-3.yaml`) is a safety concern — the tool grant should be scoped or removed to prevent accidental mass deletion.

No issues were found with commit message formatting, YAML structure, Linear issue ID validity, file naming, or security patterns.
