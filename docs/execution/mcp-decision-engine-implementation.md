# MCP Decision Engine Implementation Plan

**Date:** January 2026
**Type:** New Skill Creation
**Location:** `~/.claude/skills/mcp-decision-helper/`
**Execution Model:** Sequential waves with parallel sub-tasks

---

## Overview

Implementation plan for creating the MCP Decision Engine skill that helps users decide between Skills (with scripts) vs MCP servers using an 8-dimension scoring framework.

```
┌─────────────────────────────────────────────────────────────┐
│              MCP DECISION ENGINE IMPLEMENTATION              │
├─────────────────────────────────────────────────────────────┤
│  Wave 1: Core SKILL.md Creation              ~2 hours       │
│     └── 8-dimension scoring, disqualifiers, output format   │
├─────────────────────────────────────────────────────────────┤
│  Wave 2: Evaluation Script                   ~3 hours       │
│     └── TypeScript scoring logic with CLI interface         │
├─────────────────────────────────────────────────────────────┤
│  Wave 3: Templates                           ~2 hours       │
│     └── Skill, MCP, and Hybrid output templates             │
├─────────────────────────────────────────────────────────────┤
│  Wave 4: References & Examples               ~2 hours       │
│     └── Decision framework docs and sample evaluations      │
├─────────────────────────────────────────────────────────────┤
│  Wave 5: Validation & Testing                ~1 hour        │
│     └── End-to-end testing and documentation review         │
└─────────────────────────────────────────────────────────────┘
```

---

## Wave 1: Core SKILL.md Creation

**Est. Time:** ~2 hours
**Linear Issue:** SMI-XXXX - Create SKILL.md with 8-dimension scoring

### Tasks

1. Create directory structure:
   ```bash
   mkdir -p ~/.claude/skills/mcp-decision-helper/{scripts,templates,references}
   ```

2. Create SKILL.md with:
   - YAML frontmatter (name, description, triggers)
   - 8-dimension scoring framework table
   - Automatic disqualifier logic
   - Decision thresholds (Score ≥ 6)
   - Output format specification
   - Integration instructions

### SKILL.md Structure

```yaml
---
name: mcp-decision-helper
description: Evaluate whether to implement a capability as a Skill or MCP server
triggers:
  - "should I use MCP"
  - "skill vs MCP"
  - "evaluate integration approach"
  - "MCP or skill for"
---

# MCP Decision Helper

## Purpose
Help users make informed decisions about whether to implement capabilities as Claude Code Skills (with scripts) or MCP servers.

## Quick Decision

### Automatic Disqualifiers

**Must use MCP (skip scoring):**
- [ ] Real-time streaming requirement
- [ ] Dynamic tool discovery essential
- [ ] Enterprise SSO/OAuth integration
- [ ] Multi-system orchestration hub

**Must use Skill (skip scoring):**
- [ ] Token budget <10K per session
- [ ] Deterministic execution audit required
- [ ] No DevOps capacity available
- [ ] Highly repetitive operations (>10x daily)

If none of the above apply, proceed to scoring.

## Scoring Framework

Evaluate each dimension on a scale of -2 to +2:

| Dimension | -2 (Strong Skill) | -1 | 0 | +1 | +2 (Strong MCP) |
|-----------|-------------------|----|----|----|--------------------|
| Task Repeatability | Same task >10x/day | Frequent | Mixed | Occasional | One-off exploration |
| Data Freshness | Point-in-time OK | Hourly | Daily | Near-real-time | Real-time required |
| Token Sensitivity | <10K budget | <50K budget | Moderate | Flexible | Unlimited |
| Reliability Needs | Must be deterministic | High | Standard | Moderate | Low tolerance OK |
| Maintenance Capacity | No DevOps | Limited | Moderate | Good | Full DevOps team |
| Integration Scope | Single system | Few systems | Mixed | Several | Enterprise-wide |
| Discovery Needs | Static, known | Mostly static | Some dynamic | Often dynamic | Dynamic essential |
| Auth Complexity | None/API key | Basic auth | OAuth | SSO | Enterprise SSO |

## Decision Thresholds

1. Sum all dimension scores
2. Apply decision:
   - **Score ≤ -6**: Strong recommendation for Skill
   - **Score -5 to +5**: Hybrid approach or case-by-case
   - **Score ≥ +6**: Strong recommendation for MCP

## Output Generation

After scoring, generate report using templates in `templates/` directory.

## Script Usage

npx tsx ~/.claude/skills/mcp-decision-helper/scripts/evaluate.ts

## Related Skills

- skill-builder: Use to implement if Skill recommended
- See MCP documentation for MCP implementation
```

### Acceptance Criteria

- [ ] SKILL.md created with complete scoring framework
- [ ] Trigger phrases correctly identify skill
- [ ] Disqualifier logic is clear and actionable
- [ ] Decision thresholds documented

---

## Wave 2: Evaluation Script

**Est. Time:** ~3 hours
**Linear Issue:** SMI-XXXX - Create evaluation script (evaluate.ts)

### Tasks

1. Create `scripts/evaluate.ts` with:
   - Interactive CLI prompts for each dimension
   - Score calculation logic
   - Disqualifier detection
   - Report generation
   - JSON output option

### Script Interface

```typescript
interface EvaluationInput {
  taskDescription: string;
  dimensions: {
    repeatability: number;      // -2 to +2
    dataFreshness: number;      // -2 to +2
    tokenSensitivity: number;   // -2 to +2
    reliabilityNeeds: number;   // -2 to +2
    maintenanceCapacity: number; // -2 to +2
    integrationScope: number;   // -2 to +2
    discoveryNeeds: number;     // -2 to +2
    authComplexity: number;     // -2 to +2
  };
  disqualifiers: {
    realTimeStreaming: boolean;
    dynamicDiscovery: boolean;
    enterpriseSSO: boolean;
    multiSystemOrchestration: boolean;
    tokenBudgetConstrained: boolean;
    deterministicRequired: boolean;
    noDevOps: boolean;
    highlyRepetitive: boolean;
  };
}

interface EvaluationResult {
  recommendation: 'SKILL' | 'MCP' | 'HYBRID';
  totalScore: number;
  breakdown: Record<string, { score: number; rationale: string }>;
  disqualifiersTriggered: string[];
  tokenImpact: {
    skillEstimate: string;
    mcpEstimate: string;
    savingsWithSkill: string;
  };
  nextSteps: string[];
}
```

### Acceptance Criteria

- [ ] Script runs successfully with `npx tsx evaluate.ts`
- [ ] Interactive prompts work correctly
- [ ] Disqualifiers override scoring when triggered
- [ ] JSON output option works
- [ ] Report generation is readable

---

## Wave 3: Templates

**Est. Time:** ~2 hours
**Linear Issue:** SMI-XXXX - Create Skill/MCP/Hybrid templates

### Tasks

1. Create `templates/skill-template.md`:
   - Skill directory structure
   - SKILL.md scaffolding
   - scripts/ recommendations
   - Best practices

2. Create `templates/mcp-template.md`:
   - MCP server structure (TypeScript/Python)
   - Configuration for Claude settings
   - Error handling patterns
   - Timeout considerations

3. Create `templates/hybrid-template.md`:
   - Combined approach structure
   - When to use Skill vs MCP portions
   - Migration path documentation

### Acceptance Criteria

- [ ] All three templates created
- [ ] Templates include actionable scaffolding
- [ ] Best practices documented in each
- [ ] Copy-paste ready structure

---

## Wave 4: References & Examples

**Est. Time:** ~2 hours
**Linear Issues:**
- SMI-XXXX - Create reference documentation
- SMI-XXXX - Add example evaluations

### Tasks

1. Create `references/decision-framework.md`:
   - Detailed rationale for each dimension
   - Scoring guidance with examples
   - Edge case handling

2. Create `references/examples.md`:
   - 3-5 sample evaluations
   - Various outcomes (Skill, MCP, Hybrid)
   - Real-world scenarios

### Example Evaluations

#### Example 1: Daily Report Generator

**Task**: Generate daily sales reports from CRM data

**Disqualifier Check:**
- [x] Token budget constrained: Yes (<50K)
- [x] Highly repetitive: Yes (daily)

**Result**: SKILL (disqualifier triggered)

**Rationale**: Repetitive daily task with constrained tokens. Skill approach saves ~85% tokens over MCP.

#### Example 2: Live Chat Integration

**Task**: Integrate with Slack for real-time notifications

**Disqualifier Check:**
- [x] Real-time streaming: Yes (live messages)

**Result**: MCP (disqualifier triggered)

**Rationale**: Real-time streaming requirement mandates MCP for WebSocket/event handling.

#### Example 3: GitHub PR Review

**Task**: Review PRs and provide feedback

**Total Score**: -4

**Result**: HYBRID

**Recommendation**: Use Skill for standard review workflow (repeatable), MCP for PR discovery and live status.

### Acceptance Criteria

- [ ] Decision framework covers all dimensions
- [ ] Examples show diverse outcomes
- [ ] Rationale is clear and educational
- [ ] Copy-paste usable for users

---

## Wave 5: Validation & Testing

**Est. Time:** ~1 hour
**Linear Issue:** SMI-XXXX - Validation testing

### Tasks

1. End-to-end testing:
   - Invoke skill via trigger phrase
   - Run evaluation script
   - Verify output format

2. Documentation review:
   - All files present
   - Links working
   - Examples accurate

3. Integration check:
   - Skill loads in Claude Code
   - Templates generate correctly

### Verification Checklist

```bash
# Verify directory structure
ls -la ~/.claude/skills/mcp-decision-helper/
# Expected: SKILL.md, scripts/, templates/, references/

# Test skill invocation (in Claude Code)
# "Should I use MCP or Skill for a daily report generator?"
# Expected: Skill triggers and provides evaluation

# Test script directly
npx tsx ~/.claude/skills/mcp-decision-helper/scripts/evaluate.ts --help
# Expected: Help text displayed

# Validate SKILL.md syntax
cat ~/.claude/skills/mcp-decision-helper/SKILL.md | head -20
# Expected: Valid YAML frontmatter
```

### Acceptance Criteria

- [ ] All verification commands pass
- [ ] Skill triggers correctly in Claude Code
- [ ] Script runs without errors
- [ ] Templates are complete and usable

---

## Linear Issues Summary

| Issue ID | Title | Type | Est. Hours |
|----------|-------|------|------------|
| SMI-XXXX | MCP Decision Engine: Create SKILL.md with 8-dimension scoring | Feature | 2 |
| SMI-XXXX | MCP Decision Engine: Create evaluation script (evaluate.ts) | Feature | 3 |
| SMI-XXXX | MCP Decision Engine: Create Skill/MCP/Hybrid templates | Feature | 2 |
| SMI-XXXX | MCP Decision Engine: Create reference documentation | Docs | 1 |
| SMI-XXXX | MCP Decision Engine: Add example evaluations | Docs | 1 |
| SMI-XXXX | MCP Decision Engine: Validation testing | Test | 1 |

**Total Estimated Hours:** 10

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Skill triggers correctly | 100% of trigger phrases |
| Script execution | Zero errors |
| Documentation completeness | All sections populated |
| User understanding | Clear decision within 5 minutes |

---

## References

- Architecture: /docs/architecture/mcp-decision-engine-architecture.md
- Research: /docs/backlog/skill-optimizations/skills-vs-mcp-research.md
- Research: /docs/backlog/skill-optimizations/mcp-builder-skill-prompt.md
