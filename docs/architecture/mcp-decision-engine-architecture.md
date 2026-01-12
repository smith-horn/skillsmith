# MCP Decision Engine Architecture

## Overview

The MCP Decision Engine is a standalone Claude Code skill that provides an 8-dimension scoring framework to help users decide between implementing capabilities as Skills (with scripts) vs MCP servers.

## Problem Statement

Users frequently face the decision of whether to implement a capability as:
- **Skill with scripts**: Lower token overhead, deterministic execution
- **MCP server**: Real-time data access, dynamic tool discovery

Making the wrong choice can result in:
- 10-100x token waste (choosing MCP for repeatable tasks)
- Missed functionality (choosing Skill for real-time needs)
- Maintenance burden (wrong tool for the job)

## Solution Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   mcp-decision-helper Skill                  │
├─────────────────────────────────────────────────────────────┤
│  SKILL.md                                                    │
│  ├── Trigger phrases and invocation                          │
│  ├── 8-dimension scoring framework                           │
│  ├── Automatic disqualifier logic                            │
│  └── Output generation instructions                          │
├─────────────────────────────────────────────────────────────┤
│  scripts/                                                    │
│  └── evaluate.ts                                             │
│      ├── Score calculation logic                             │
│      ├── Disqualifier detection                              │
│      └── Report generation                                   │
├─────────────────────────────────────────────────────────────┤
│  templates/                                                  │
│  ├── skill-template.md (Skill output structure)              │
│  ├── mcp-template.md (MCP output structure)                  │
│  └── hybrid-template.md (Combined approach)                  │
├─────────────────────────────────────────────────────────────┤
│  references/                                                 │
│  ├── decision-framework.md (Detailed criteria)               │
│  └── examples.md (Sample evaluations)                        │
└─────────────────────────────────────────────────────────────┘
```

### Scoring Framework

| Dimension | Skill Indicator (+2) | MCP Indicator (+2) |
|-----------|---------------------|-------------------|
| Task Repeatability | Same operation >10x daily | One-off exploration |
| Data Freshness | Point-in-time acceptable | Real-time required |
| Token Sensitivity | Budget <50K tokens | Flexible budget |
| Reliability Needs | Deterministic/auditable | Moderate tolerance |
| Maintenance Capacity | No DevOps team | Full DevOps available |
| Integration Scope | Single system | Multi-system orchestration |
| Discovery Needs | Static, known tools | Dynamic tool discovery |
| Auth Complexity | Simple/none | OAuth/SSO/enterprise |

### Decision Thresholds

- **Score ≥ 6 for Skills** → Recommend Skill implementation
- **Score ≥ 6 for MCP** → Recommend MCP server
- **Mixed scores** → Recommend Hybrid approach

### Automatic Disqualifiers

**Must use MCP (no scoring needed):**
- Real-time streaming requirement
- Dynamic tool discovery essential
- Enterprise SSO/OAuth integration
- Multi-system orchestration hub

**Must use Skill (no scoring needed):**
- Token budget <10K per session
- Deterministic execution audit required
- No DevOps capacity for server maintenance
- Highly repetitive operations (>10x daily)

## Data Flow

```
User Request ("Should I use MCP or Skill for X?")
        │
        ▼
┌─────────────────────┐
│ Parse Task Context  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Check Disqualifiers │──────► Immediate recommendation
└─────────┬───────────┘        (if disqualifier triggered)
          │
          ▼
┌─────────────────────┐
│ Score 8 Dimensions  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Calculate Totals    │
│ - Skill Score       │
│ - MCP Score         │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Generate Report     │
│ - Recommendation    │
│ - Breakdown         │
│ - Next Steps        │
└─────────────────────┘
```

## Output Format

### Evaluation Report Structure

```markdown
## MCP vs Skill Evaluation: [Task Name]

### Recommendation: [SKILL | MCP | HYBRID]

### Score Breakdown

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| ... | ... | ... |

**Skill Score:** X/16
**MCP Score:** Y/16

### Token Impact

| Approach | Est. Startup | Est. Per-Task | Daily Total |
|----------|--------------|---------------|-------------|
| Skill | ~200 tokens | ~500 tokens | ~5,200 tokens |
| MCP | ~15,000 tokens | ~2,000 tokens | ~35,000 tokens |

### Recommended Next Steps

1. [Action item 1]
2. [Action item 2]
3. [Action item 3]
```

## Integration Points

### Skill Builder Integration

The MCP Decision Engine should be invoked when:
- User asks skill-builder to create a new capability
- User is unsure whether to create a skill or MCP server
- During architectural planning phases

### Cross-Reference

- Skill Builder can reference: "Run mcp-decision-helper first to determine approach"
- MCP Decision Engine can reference: "Use skill-builder to implement Skill" or "Use [MCP docs] to implement server"

## Security Considerations

- No external API calls required (fully local)
- No secrets or credentials needed
- All evaluation is deterministic

## Token Efficiency

- Skill startup: ~50 tokens (progressive disclosure)
- Full evaluation: ~500-1,000 tokens
- Much lighter than analyzing this manually in conversation

## References

- Research: /docs/backlog/skill-optimizations/skills-vs-mcp-research.md
- Research: /docs/backlog/skill-optimizations/mcp-builder-skill-prompt.md
- Implementation: /docs/execution/mcp-decision-engine-implementation.md
