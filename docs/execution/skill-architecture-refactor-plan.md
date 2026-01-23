# Skill Architecture Refactor Implementation Plan

**Initiative:** SMI-1735
**Created:** 2026-01-23
**Status:** Planned

---

## Executive Summary

Analysis per agent-skill-framework.md guidelines revealed significant technical debt:
- **24 skills exceed 500-line guideline** (11 critical, 13 high)
- **Only 3/31 project skills have scripts/** directories
- **0/31 project skills have hooks/** directories
- **Blanket "EXECUTE, DON'T ASK" policy conflicts with planning skills**

This plan addresses these issues through 4 waves with a revised behavioral classification framework.

---

## Architecture Decision: Skill Behavioral Classification

**ADR-025** (to be created)

### Problem

The original plan assumed "EXECUTE, DON'T ASK" should be applied to all workflow skills. This is incorrect—skills like wave-planner and mcp-decision-helper legitimately need to ask questions.

### Decision

Classify skills into 4 behavioral types:

| Classification | Directive | When to Use | Examples |
|----------------|-----------|-------------|----------|
| **Autonomous Execution** | EXECUTE, DON'T ASK | Prescribed workflows with no decisions | governance, hive-mind-execution, docker-enforce |
| **Guided Decision** | ASK, THEN EXECUTE | Requires user input on choices | wave-planner, mcp-decision-helper, skill-builder |
| **Interactive Exploration** | ASK THROUGHOUT | User-driven discovery | dev-browser, researcher |
| **Configurable Enforcement** | USER-CONFIGURED | Policy depends on project settings | varlock (block/warn modes) |

### Clarification

| Wrong Interpretation | Correct Interpretation |
|---------------------|------------------------|
| "Never ask the user anything" | "Don't ask permission to follow the prescribed workflow" |
| "Execute blindly" | "Execute the workflow, asking for required inputs" |
| "Skip all clarification" | "Skip permission-seeking, not clarification" |

---

## Risk Register

| Risk | Issues | Likelihood | Impact | Mitigation |
|------|--------|------------|--------|------------|
| **Behavioral Conflict** | SMI-1738, SMI-1742 | ~~High~~ Mitigated | High | Revised to decision framework |
| **Decomposition Breaks Skills** | SMI-1736, SMI-1737, SMI-1743 | Medium | High | Test each skill; keep rollback branch |
| **Script Extraction Changes Behavior** | SMI-1739 | Medium | Medium | Ensure scripts are idempotent; add tests |
| **User Skills Divergence** | SMI-1743 | Low | Medium | Document sync pattern for user vs project |
| **Discovery Check False Positives** | SMI-1740 | Medium | Low | Make suggestions, not blocks |
| **Docker-Enforce Overhead** | SMI-1741 | Low | Low | Make optional per-project |

---

## Wave Structure

### Wave 1: Foundation & Quick Wins
**Estimated Tokens:** ~45K
**Agent:** documentation-writer

| Issue | Title | Priority | Effort |
|-------|-------|----------|--------|
| SMI-1740 | Add discovery check to wave-planner | P2 | 1h |
| SMI-1744 | Create ADR for Skill Behavioral Classification | P2 | 1h |
| SMI-1738 | Create Skill Behavioral Classification Framework | P2 | 2h |

**Acceptance Criteria:**
- [ ] wave-planner has discovery phase before creation
- [ ] ADR-025 documents behavioral classification
- [ ] Framework documented with examples

**Dependencies:** None (can start immediately)

---

### Wave 2: Reference Implementation
**Estimated Tokens:** ~80K
**Agent:** skill-architect

| Issue | Title | Priority | Effort |
|-------|-------|----------|--------|
| SMI-1743 | Decompose linear skill as reference | P1 | 4h |
| SMI-1739 | Extract scripts pattern (apply to linear) | P3 | 2h |

**Target Structure for linear skill:**
```
~/.claude/skills/linear/
├── SKILL.md (<500 lines)    # Core instructions
├── api.md                    # GraphQL API reference
├── sdk.md                    # SDK automation patterns
├── sync.md                   # Bulk sync patterns
├── projects.md               # Project/initiative management
├── troubleshooting.md        # Common issues
├── scripts/                  # (existing)
└── docs/labels.md            # Label taxonomy
```

**Acceptance Criteria:**
- [ ] linear SKILL.md under 500 lines
- [ ] Sub-skills load on demand
- [ ] All functionality preserved
- [ ] README documents structure
- [ ] Can serve as template for Wave 3

**Dependencies:** Wave 1 (classification framework needed for documentation)

---

### Wave 3: Propagate Patterns
**Estimated Tokens:** ~120K
**Agent:** coder (batch operations)

| Issue | Title | Priority | Effort |
|-------|-------|----------|--------|
| SMI-1736 | Decompose critical oversized skills | P1 | 8h |
| SMI-1741 | Integrate docker-enforce pattern | P3 | 2h |

**Skills to Decompose (using linear as reference):**
1. github-project-management (1277 lines)
2. pair-programming (1202 lines)
3. hooks-automation (1201 lines)
4. flow-nexus-platform (1157 lines)
5. github-code-review (1140 lines)
6. sparc-methodology (1115 lines)
7. github-release-management (1081 lines)
8. github-workflow-automation (1065 lines)
9. worktree-manager (1033 lines)
10. e2e-patterns (1035 lines, user skill)

**Acceptance Criteria:**
- [ ] All critical skills under 500 lines
- [ ] Progressive disclosure implemented
- [ ] docker-enforce pattern available as optional integration

**Dependencies:** Wave 2 (reference implementation)

---

### Wave 4: Documentation & Remaining
**Estimated Tokens:** ~60K
**Agent:** documentation-writer

| Issue | Title | Priority | Effort |
|-------|-------|----------|--------|
| SMI-1742 | Add classification to skill-builder template | P3 | 2h |
| SMI-1737 | Decompose high-priority skills (500-1000 lines) | P2 | 6h |

**Skills to Decompose:**
- swarm-advanced (973 lines)
- skill-builder (910 lines)
- github-multi-repo (874 lines)
- hive-mind-advanced (764 lines)
- flow-nexus-neural (738 lines)
- hive-mind-execution (730 lines)
- docker (718 lines, user skill)
- wave-planner (682 lines, user skill)
- Plus 5 more in 500-650 range

**Acceptance Criteria:**
- [ ] skill-builder includes behavioral classification section
- [ ] All skills under 500 lines
- [ ] Documentation complete

**Dependencies:** Wave 3 (patterns established)

---

## Execution Commands

```bash
# Wave 1
./claude-flow swarm "Execute Wave 1: Foundation" \
  --config .claude/hive-mind/skill-refactor-wave-1.yaml \
  --strategy development

# Wave 2
./claude-flow swarm "Execute Wave 2: Reference Implementation" \
  --config .claude/hive-mind/skill-refactor-wave-2.yaml

# Wave 3
./claude-flow swarm "Execute Wave 3: Propagate Patterns" \
  --config .claude/hive-mind/skill-refactor-wave-3.yaml

# Wave 4
./claude-flow swarm "Execute Wave 4: Documentation" \
  --config .claude/hive-mind/skill-refactor-wave-4.yaml
```

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Skills over 500 lines | 24 | 0 |
| Skills with scripts/ | 3/31 | 15/31 |
| Skills with behavioral classification | 1/31 | 31/31 |
| Average SKILL.md size | ~750 lines | <400 lines |

---

## Appendix: Issue Summary

| Issue | Title | Wave | Status |
|-------|-------|------|--------|
| SMI-1735 | Skill Architecture Refactor Initiative | Parent | Backlog |
| SMI-1736 | Decompose critical oversized skills | 3 | Backlog |
| SMI-1737 | Decompose high-priority skills | 4 | Backlog |
| SMI-1738 | Create Behavioral Classification Framework | 1 | Backlog |
| SMI-1739 | Extract deterministic operations to scripts/ | 2 | Backlog |
| SMI-1740 | Add discovery check to wave-planner | 1 | Backlog |
| SMI-1741 | Integrate docker-enforce pattern | 3 | Backlog |
| SMI-1742 | Add classification to skill-builder template | 4 | Backlog |
| SMI-1743 | Decompose linear skill as reference | 2 | Backlog |
| SMI-1744 | Create ADR for Behavioral Classification | 1 | Backlog |
