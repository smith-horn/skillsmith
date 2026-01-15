# Parallel Agent Execution Architecture

## Overview

This document defines the architecture for parallel agent execution patterns, specifically how skills should be executed in isolated subagents vs the main conversation context for optimal token efficiency.

## Problem Statement

Claude Code skills execute in the main conversation context by default, leading to:

1. **Context Pollution**: Intermediate outputs accumulate
2. **Token Waste**: Full skill content loads even for simple tasks
3. **Performance Degradation**: Context window fills faster
4. **No Parallelization**: Skills execute sequentially

**Measured Token Impact:**

| Scenario | Main Context | Subagent Isolated | Savings |
|----------|--------------|-------------------|---------|
| Single task | 43,588 | 27,297 | 37% |
| 10-worker scenario | 50,000 | 1,500 | 97% |

## Architecture Overview

### Execution Model Comparison

```
┌─────────────────────────────────────────────────────────────┐
│                 MAIN CONTEXT EXECUTION                       │
│                 (Current Default Behavior)                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Orchestrator Context                                        │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ User request                           ~100 tokens      ││
│  │ Skill A SKILL.md loaded                ~2,000 tokens    ││
│  │ Skill A intermediate output            ~5,000 tokens    ││
│  │ Skill A final result                   ~500 tokens      ││
│  │ Skill B SKILL.md loaded                ~1,500 tokens    ││
│  │ Skill B intermediate output            ~3,000 tokens    ││
│  │ Skill B final result                   ~400 tokens      ││
│  │ ... accumulates indefinitely ...                        ││
│  └─────────────────────────────────────────────────────────┘│
│  Total: ~12,500+ tokens (and growing)                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                 SUBAGENT ISOLATED EXECUTION                  │
│                 (Recommended Pattern)                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Orchestrator Context (Lean)                                 │
│  ┌──────────────────────────────────────────┐               │
│  │ User request                 ~100 tokens │               │
│  │ Delegation decision          ~50 tokens  │               │
│  │ Skill A summary returned     ~150 tokens │               │
│  │ Skill B summary returned     ~150 tokens │               │
│  │ Synthesis for user           ~200 tokens │               │
│  └──────────────────────────────────────────┘               │
│  Total: ~650 tokens (bounded)                                │
│                                                              │
│  Subagent Contexts (Isolated, Discarded After Task)          │
│  ┌────────────────────┐  ┌────────────────────┐             │
│  │ Skill A Specialist │  │ Skill B Specialist │             │
│  │ - SKILL.md loaded  │  │ - SKILL.md loaded  │             │
│  │ - Execution        │  │ - Execution        │             │
│  │ - Returns summary  │  │ - Returns summary  │             │
│  └────────────────────┘  └────────────────────┘             │
│  (Context discarded)      (Context discarded)                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Decision Framework

### When to Execute in Main Context

```
Skill produces < 500 tokens working context
        │
        ▼
     [YES] ──► Latency is critical?
                    │
                    ▼
                 [YES] ──► Orchestrator has headroom?
                                │
                                ▼
                             [YES] ──► EXECUTE IN MAIN CONTEXT
```

**Criteria for main context execution:**
- Simple lookups returning <500 tokens
- Latency-critical operations (user waiting)
- Single-shot operations with no intermediate state
- Orchestrator context has >50% headroom

### When to Delegate to Subagent

```
Skill produces verbose output (>500 tokens)
        │
        ▼
     [YES] ──► DELEGATE TO SUBAGENT

OR

Skill involves document processing
        │
        ▼
     [YES] ──► DELEGATE TO SUBAGENT

OR

Multiple skills needed in sequence
        │
        ▼
     [YES] ──► DELEGATE TO PARALLEL SUBAGENTS
```

**Criteria for subagent delegation:**
- Document processing (PDF, Excel, large files)
- Test execution (verbose output)
- Code review (multi-file analysis)
- Research tasks (iterative exploration)
- Any operation producing >500 tokens of intermediate state

### Pattern Selection Matrix

| Task Type | Main Context | Dedicated Subagent | Parallel Subagents |
|-----------|--------------|-------------------|-------------------|
| Simple lookup | Preferred | Overkill | Overkill |
| Single file edit | Preferred | Optional | Overkill |
| Document processing | Avoid | Preferred | Optional |
| Multi-file analysis | Avoid | Preferred | For comparison |
| Test execution | Avoid | Preferred | For parallel suites |
| Research workflow | Avoid | Preferred | Multiple sources |

## Implementation Patterns

### Pattern 1: Orchestrator Delegation

```markdown
## In CLAUDE.md

### Skill Delegation Rules

When encountering tasks that match these patterns, delegate to specialized subagents:

| Task Pattern | Delegate To | Return Budget |
|--------------|-------------|---------------|
| PDF processing | pdf-specialist | ~500 tokens |
| Excel analysis | excel-specialist | ~300 tokens |
| Code review | code-review-specialist | ~400 tokens |

### Delegation Protocol

1. Identify task type from user request
2. Delegate entire task to appropriate specialist
3. Await summary response (max 500 tokens)
4. Synthesize specialist output for user

**Do NOT execute skills directly for verbose operations.**
```

### Pattern 2: Forked Context for One-Off Tasks

When a task needs skill isolation but doesn't warrant a dedicated subagent:

```markdown
## Forked Context Usage

For one-off skill isolation without persistent subagent:

1. Spawn temporary Task agent with skill attached
2. Pass task-specific prompt
3. Receive summary-only response
4. Context automatically discarded

Example:
Task("Analyze this PR", {
  skills: ["code-review"],
  returnBudget: 500
})
```

### Pattern 3: Parallel Skill Execution

For tasks requiring multiple skills simultaneously:

```markdown
## Parallel Execution Pattern

When multiple independent analyses are needed:

1. Spawn parallel subagents (one per skill domain)
2. Each returns bounded summary
3. Orchestrator synthesizes results

Example:
// Single message, multiple Task calls
Task("Security analysis", { skills: ["security-audit"] })
Task("Performance analysis", { skills: ["perf-analyzer"] })
Task("Style review", { skills: ["style-checker"] })

// Orchestrator receives 3 summaries (~1,500 tokens)
// vs main context (~15,000+ tokens)
```

## Token Budget Guidelines

### Summary Return Budgets by Domain

| Domain | Max Return Tokens | Rationale |
|--------|------------------|-----------|
| Quick lookup | 100-200 | Single fact retrieval |
| File operation | 200-300 | Status + path |
| Code review | 300-500 | Findings + locations |
| Document analysis | 400-600 | Summary + key points |
| Test execution | 300-500 | Pass/fail + failures |
| Research | 500-800 | Findings + sources |

### Orchestrator Context Budget

For sustainable orchestration:
- Keep orchestrator context <30K tokens
- Reserve 50% for user interaction
- Each subagent return: max 500 tokens
- Max parallel subagents: 5-10

## Tradeoffs

### Benefits of Subagent Isolation

| Benefit | Impact |
|---------|--------|
| Token savings | 37-97% reduction |
| Focused prompts | Higher accuracy |
| Parallel execution | Faster completion |
| Context preservation | No degradation |
| Clear boundaries | Easier debugging |

### Costs of Subagent Isolation

| Cost | Mitigation |
|------|------------|
| Cold start latency | Pre-warm common agents |
| Coordination complexity | Clear delegation rules |
| Context loss | Summary format requirements |
| No nested delegation | Flat hierarchy design |
| Setup overhead | Automated generation |

## Metrics and Monitoring

### Recommended Tracking

```typescript
interface ExecutionMetrics {
  // Token metrics
  orchestratorTokens: number;
  subagentTokensTotal: number;
  tokenSavingsPercent: number;

  // Timing metrics
  delegationLatency: number;
  subagentExecutionTime: number;
  totalTaskTime: number;

  // Quality metrics
  summaryCompleteness: 'full' | 'partial' | 'truncated';
  taskSuccess: boolean;
}
```

### Health Indicators

- Orchestrator context growth rate
- Average subagent return size
- Delegation decision accuracy
- Task completion rate

## References

- Research: /docs/backlog/skill-optimizations/parallel-agents-skills-research.md
- Implementation: /docs/execution/parallel-agent-execution-implementation.md
