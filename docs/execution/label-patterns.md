# Agent-Label Routing Patterns for Linear Issues

This document describes the labeling strategy that enables AI agents to self-select and execute Linear issues based on domain expertise.

## Design Decision

**Approach**: Skill-Domain Labels (not Agent-Specific Labels)

Instead of labels like `agent:coder` or `agent:security-manager`, we use domain labels (`security`, `performance`, `neural`) that agents match based on their capabilities. This provides:

1. **Flexibility**: New agents can join without label updates
2. **Simplicity**: Fewer labels to maintain
3. **Natural routing**: Agents self-select based on expertise
4. **Multi-agent capability**: Multiple agents can work on same domain

## Label Categories

### Phase Labels (Sequencing)
Control execution order across milestones.

| Label | Purpose | Agents Wait For |
|-------|---------|-----------------|
| `phase-1` | Core Infrastructure | Nothing |
| `phase-2` | Neural Capabilities | phase-1 complete |
| `phase-3` | Multi-LLM Support | phase-1 complete |
| `phase-4` | Security Hardening | phase-1 complete |
| `phase-5` | Testing & Docs | phases 1-4 complete |

### Domain Labels (Routing)
Route issues to appropriate specialist agents.

| Label | Primary Agents | Capability Match |
|-------|----------------|------------------|
| `security` | security-manager, byzantine-coordinator | Threat detection, CVE, sandboxing |
| `performance` | performance-benchmarker, perf-analyzer | Profiling, optimization, HNSW |
| `neural` | safla-neural, collective-intelligence | ML, learning, pattern recognition |
| `infrastructure` | swarm-init, mesh-coordinator | Config, dependencies, topology |
| `testing` | tester, tdd-london-swarm | Unit, integration, E2E tests |
| `core` | coder, sparc-coder | Implementation, refactoring |
| `reliability` | raft-manager, gossip-coordinator | Consensus, failover, recovery |
| `documentation` | researcher | Docs, ADRs, comments |

### Type Labels (Context)
Provide additional context for agents.

| Label | Meaning |
|-------|---------|
| `feature` | New functionality |
| `refactor` | Code restructuring (no behavior change) |
| `breaking-change` | Requires migration or version bump |

## Agent Selection Algorithm

```
1. Filter issues by phase (respect dependencies)
2. Filter by domain labels matching agent capabilities
3. If multiple matches: prefer issues with more matching labels
4. If tie: select by priority (Critical > High > Medium)
5. Claim issue and update status to In Progress
```

## Patterns

### Pattern: Multi-Domain Routing
Issues with multiple domain labels (e.g., `security` + `feature`) route to agents with combined expertise.

- **Good**: `security` + `feature` -> security-manager (if it can implement features)
- **Good**: `security` + `feature` -> coder + security-manager (parallel execution)

### Pattern: Phase Gating
Agents must respect phase dependencies before claiming issues.

- **Good**: Check all `phase-1` issues complete before starting `phase-2`
- **Good**: Issues without phase labels can run in parallel with any phase

### Pattern: Primary/Secondary Fallback
If primary agent unavailable, secondary agents can execute.

- **Good**: `testing` issue -> tester (primary) unavailable -> reviewer (secondary)
- **Good**: Log which agent executed for traceability

## Anti-Patterns

### Anti-Pattern: Agent-Specific Labels
**Bad**: Using labels like `agent:coder`, `agent:tester`

**Why it fails**:
- Label proliferation (54 agents = 54 labels)
- Tight coupling (agent removed = orphan labels)
- No flexibility (can't add agents without label updates)
- Manual assignment required

**Fix**: Use domain labels that agents self-match.

### Anti-Pattern: Ignoring Phase Order
**Bad**: Starting `phase-2` neural work before `phase-1` infrastructure

**Why it fails**:
- Dependencies not satisfied (V3 not installed)
- Work may need to be redone
- Integration failures

**Fix**: Query phase-1 issues first; only proceed when all complete.

### Anti-Pattern: Single-Label Issues
**Bad**: Issue with only `phase-1` label, no domain label

**Why it fails**:
- No agent knows to claim it
- Falls into backlog limbo
- Manual triage required

**Fix**: Always include at least one domain label.

### Anti-Pattern: Over-Labeling
**Bad**: Issue with 5+ domain labels (`security`, `performance`, `core`, `testing`, `infrastructure`)

**Why it fails**:
- Unclear ownership (too many agents match)
- Analysis paralysis
- Issue is probably too large

**Fix**: If 4+ domain labels needed, split into multiple issues.

### Anti-Pattern: Stale Phase Labels
**Bad**: Leaving `phase-1` label on completed issues

**Why it fails**:
- Blocks downstream phases (phase-2 waits forever)
- Incorrect status reporting
- Agent confusion

**Fix**: Remove phase label or mark issue Done when complete.

### Anti-Pattern: Label Conflicts
**Bad**: `breaking-change` + `refactor` without migration plan

**Why it fails**:
- Refactor implies no behavior change
- Breaking change implies behavior change
- Contradictory signals to agents

**Fix**: Choose one. If refactor causes breaking change, use `breaking-change` only.

## Issue Template

When creating issues for agent execution:

```
Title: [Verb] [What] [Where]
Example: "Integrate ReasoningBank for skill recommendation learning"

Labels (required):
- One phase label: phase-1, phase-2, etc.
- One+ domain labels: security, performance, neural, etc.
- One type label: feature, refactor, breaking-change

Description:
- What: Clear statement of work
- Why: Business/technical justification
- Files: Specific paths to modify
- Acceptance Criteria: Testable checklist

Example:
  Files:
  - New: packages/core/src/learning/ReasoningBankIntegration.ts
  - Update: packages/core/src/learning/interfaces.ts

  Acceptance Criteria:
  - [ ] recordInstallation() creates positive trajectory
  - [ ] recordDismissal() creates negative trajectory
  - [ ] Unit tests pass
```

## Integration with Linear Skill

The Linear skill can use these patterns to:

1. **Create issues**: Auto-apply domain labels based on file paths
2. **Query issues**: Filter by domain label for agent assignment
3. **Update issues**: Add phase label when dependencies resolve
4. **Validate issues**: Warn if missing domain label or over-labeled

### Example Linear Skill Enhancement

```typescript
// Auto-label based on file paths
function inferLabels(files: string[]): string[] {
  const labels: string[] = []

  if (files.some(f => f.includes('/security/'))) labels.push('security')
  if (files.some(f => f.includes('/learning/'))) labels.push('neural')
  if (files.some(f => f.includes('/embeddings/'))) labels.push('performance')
  if (files.some(f => f.includes('.test.ts'))) labels.push('testing')

  return labels
}

// Validate before create
function validateIssue(issue: Issue): ValidationResult {
  const domainLabels = ['security', 'performance', 'neural', 'testing', 'core', ...]
  const hasDomain = issue.labels.some(l => domainLabels.includes(l))

  if (!hasDomain) {
    return { valid: false, error: 'Missing domain label for agent routing' }
  }

  if (issue.labels.filter(l => domainLabels.includes(l)).length > 4) {
    return { valid: false, error: 'Over-labeled: consider splitting issue' }
  }

  return { valid: true }
}
```

## Agent Self-Selection by Domain Label

Specialist agents self-select issues based on domain labels matching their capabilities:

| Domain Label | Primary Agents | Secondary Agents |
|--------------|----------------|------------------|
| `security` | `security-manager`, `byzantine-coordinator` | `reviewer`, `tester` |
| `performance` | `performance-benchmarker`, `perf-analyzer` | `coder`, `reviewer` |
| `neural` | `safla-neural`, `collective-intelligence-coordinator` | `researcher`, `coder` |
| `infrastructure` | `swarm-init`, `mesh-coordinator` | `coder`, `planner` |
| `testing` | `tester`, `tdd-london-swarm`, `production-validator` | `reviewer` |
| `core` | `coder`, `sparc-coder` | `reviewer`, `tester` |
| `refactor` | `coder`, `reviewer` | `architecture` |
| `reliability` | `raft-manager`, `gossip-coordinator` | `tester` |
| `documentation` | `researcher` | `reviewer` |
| `breaking-change` | `planner`, `migration-planner` | `coder`, `tester` |
| `feature` | `coder`, `sparc-coder` | `tester`, `reviewer` |

**Agent Selection Rules**:
1. Primary agents have first priority for matching labels
2. If primary agent unavailable, secondary agents execute
3. Multi-label issues (e.g., `security` + `feature`) route to agent with both capabilities
4. Phase labels determine execution order (phase-1 before phase-2)
