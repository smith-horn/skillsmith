# ADR-025: Skill Behavioral Classification Framework

## Status

Accepted

## Date

2026-01-23

## Context

During the Skill Architecture Refactor Initiative (SMI-1735), analysis revealed that the original directive "EXECUTE, DON'T ASK" was being applied as a blanket policy to all workflow skills. This caused conflicts with skills that legitimately need to ask questions during execution.

### The Problem

The `governance` skill correctly uses "EXECUTE, DON'T ASK" because code review findings should be actioned immediately without asking permission. However, skills like `wave-planner` and `mcp-decision-helper` are **designed** to ask questions:

- **wave-planner**: Must ask about scope, architecture decisions, and execution strategy
- **mcp-decision-helper**: Must ask questions to guide skill vs MCP decisions
- **skill-builder**: Must ask about behavioral classification, triggers, and tools

Applying "EXECUTE, DON'T ASK" to these skills breaks their core functionality.

### Wrong vs Correct Interpretation

| Wrong Interpretation | Correct Interpretation |
|---------------------|------------------------|
| "Never ask the user anything" | "Don't ask permission to follow the prescribed workflow" |
| "Execute blindly" | "Execute the workflow, asking for required inputs" |
| "Skip all clarification" | "Skip permission-seeking, not clarification" |

## Decision

Classify skills into **4 behavioral types** based on their interaction pattern:

### 1. Autonomous Execution

**Directive**: EXECUTE, DON'T ASK

Skills that follow a prescribed workflow with no decisions required from the user. They should execute automatically without asking for permission.

**When to Use**:
- Enforcement and compliance skills
- Code review workflows
- Automated fixes and formatting
- CI/CD integrations

**Examples**:
- `governance` - Code review findings are actioned immediately
- `hive-mind-execution` - Executes planned waves without re-asking
- `docker-enforce` - Enforces container patterns automatically

### 2. Guided Decision

**Directive**: ASK, THEN EXECUTE

Skills that require user input on specific decisions, then execute based on those decisions. They ask structured questions at defined points.

**When to Use**:
- Planning and architecture skills
- Decision frameworks
- Configuration wizards
- Template generators

**Examples**:
- `wave-planner` - Asks about scope, architecture decisions, then generates plan
- `mcp-decision-helper` - Guides through skill vs MCP decision matrix
- `skill-builder` - Asks classification, triggers, tools before generating

### 3. Interactive Exploration

**Directive**: ASK THROUGHOUT

Skills that engage in ongoing dialogue with the user, discovering requirements through conversation. The interaction IS the value.

**When to Use**:
- Research and exploration
- Debugging sessions
- Browser automation
- Creative/design tasks

**Examples**:
- `dev-browser` - Continuous interaction for web automation
- `researcher` - Explores topics based on ongoing feedback
- `pair-programming` - Collaborative coding with discussion

### 4. Configurable Enforcement

**Directive**: USER-CONFIGURED

Skills that adapt their behavior based on project or user configuration. The enforcement level is not fixed.

**When to Use**:
- Security and compliance tools with severity levels
- Linting with configurable strictness
- Environment-dependent workflows

**Examples**:
- `varlock` - Block mode vs warn mode based on project settings
- `security-auditor` - Severity thresholds from config
- `ci-doctor` - Strictness based on CI environment

## Classification Guide

To determine which classification applies to a skill:

```
┌─────────────────────────────────────────┐
│ Does the skill need user input to work? │
└─────────────────────────────────────────┘
         │                        │
        YES                       NO
         │                        │
         ▼                        ▼
┌─────────────────┐     ┌──────────────────────┐
│ Is input needed │     │ Autonomous Execution │
│ throughout, or  │     └──────────────────────┘
│ just upfront?   │
└─────────────────┘
    │           │
  UPFRONT   THROUGHOUT
    │           │
    ▼           ▼
┌────────────┐  ┌───────────────────────┐
│  Guided    │  │ Interactive           │
│  Decision  │  │ Exploration           │
└────────────┘  └───────────────────────┘

Exception: If behavior depends on config → Configurable Enforcement
```

## Consequences

### Positive

1. **Clarity for skill authors**: Clear guidance on which directive to use
2. **Better user experience**: Skills behave as expected for their type
3. **Correct governance**: "EXECUTE, DON'T ASK" only where appropriate
4. **Consistent documentation**: Each skill declares its classification

### Negative

1. **Migration effort**: Existing skills need classification added
2. **Documentation overhead**: Authors must understand 4 types
3. **Potential misclassification**: Edge cases may be unclear

### Implementation Requirements

1. **skill-builder** must include classification selection in template
2. **governance** skill must be documented as "Autonomous Execution"
3. **wave-planner** must be documented as "Guided Decision"
4. All project skills should declare their classification in SKILL.md

## Related Issues

- SMI-1735: Skill Architecture Refactor Initiative (parent)
- SMI-1738: Create Skill Behavioral Classification Framework
- SMI-1742: Add behavioral classification to skill-builder template

## References

- [agent-skill-framework.md](../articles/agent-skill-framework.md) - Original skill guidelines
- [skill-architecture-refactor-plan.md](../execution/skill-architecture-refactor-plan.md) - Implementation plan
