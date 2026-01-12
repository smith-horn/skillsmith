# Parallel Agents for Claude Skills and Plugins

## Research Summary

**Date:** January 10, 2026  
**Author:** Ryan (Smith Horn Group Ltd)  
**Topic:** Token economics and context management for skill execution in Claude Code

---

## Executive Summary

This research investigates whether skills in Claude Code should be executed by dedicated parallel (sub)agents rather than the main orchestrator agent. The hypothesis is that a focused, skill-primed subagent would provide better context isolation, reduced token consumption, and improved output quality.

**Key Finding:** Claude Code does **not** automatically route skill invocations to isolated subagents. The default behavior loads skills into the main orchestrator's context. However, the architecture supports explicit configuration of skill-specialized subagents that can achieve 37-97% token savings.

---

## Table of Contents

1. [Hypothesis Under Investigation](#hypothesis-under-investigation)
2. [How Claude Code Handles Skills](#how-claude-code-handles-skills)
3. [Token Economics](#token-economics)
4. [Skills and Subagent Integration](#skills-and-subagent-integration)
5. [Comparative Analysis](#comparative-analysis)
6. [Recommended Architecture](#recommended-architecture)
7. [Implementation Guide](#implementation-guide)
8. [Tradeoffs](#tradeoffs)
9. [Conclusions](#conclusions)
10. [Sources](#sources)

---

## Hypothesis Under Investigation

**Hypothesis:** A parallel (sub)agent should be the one to execute a skill—focused and primed for the skill—rather than the general or orchestrator-level agent.

**Rationale:**
- First-principles thinking suggests that specialized agents with isolated context windows should outperform generalist agents for domain-specific tasks
- Context pollution from intermediate results degrades model performance
- Token accumulation in orchestrator context creates cost and quality issues

---

## How Claude Code Handles Skills

### Skill Discovery and Invocation

Skills in Claude Code are **model-invoked**—Claude autonomously decides when to use them based on the request and the skill's description. The selection mechanism uses pure LLM reasoning rather than algorithmic routing:

> "The skill selection mechanism has no algorithmic routing or intent classification at the code level. Claude Code doesn't use embeddings, classifiers, or pattern matching to decide which skill to invoke. Instead, the system formats all available skills into a text description embedded in the Skill tool's prompt, and lets Claude's language model make the decision."

### Progressive Disclosure Architecture

Skills use a progressive loading pattern to manage context efficiently:

| Stage | What Loads | Token Cost |
|-------|------------|------------|
| **Startup** | Skill name + description only | ~30-50 tokens per skill |
| **Trigger** | Full SKILL.md content | ~500-2000+ tokens |
| **Execution** | Referenced files (on-demand) | Variable |
| **Scripts** | Output only (code never enters context) | Minimal |

### Default Execution Context

**Critical Finding:** By default, skills execute in the **main conversation context**, not in isolated subagents.

When Claude invokes a skill:
1. The full SKILL.md is loaded into the orchestrator's context
2. All intermediate outputs accumulate in the same context
3. Working memory remains in the orchestrator's window
4. Only the final response is presented to the user

---

## Token Economics

### The Context Pollution Problem

When skills run in the orchestrator context, token costs scale multiplicatively:

```
Total Tokens = (X + Y + Z) × N

Where:
X = Input context tokens (skill instructions, references)
Y = Working context tokens (intermediate results, reasoning)
Z = Output tokens (final answer)
N = Number of skill invocations
```

**Example:** 10 skill invocations with 5,000 tokens working context each = 50,000 tokens of context bloat.

### Subagent Isolation Benefits

With skill execution delegated to subagents:

```
Orchestrator Tokens = Z × N (summaries only)
Subagent Tokens = (X + Y + Z) per agent (isolated, discarded after use)
```

**Example:** 10 subagents returning 150-token summaries = 1,500 tokens in orchestrator context.

### Measured Token Savings

| Metric | Without Isolation | With Subagent Isolation | Reduction |
|--------|-------------------|-------------------------|-----------|
| Average task tokens | 43,588 | 27,297 | 37% |
| Multi-worker scenario | 50,000 | 1,500 | 97% |
| Complex research tasks | 200KB raw | 1KB results | 99.5% |

---

## Skills and Subagent Integration

### Key Architectural Constraint

**Subagents do not automatically inherit skills from the main conversation.**

This means:
- Built-in agents (Explore, Plan, general-purpose) cannot use custom skills
- Only explicitly configured custom subagents can access skills
- Skills must be declared in the subagent's `skills:` field

### Enabling Skills in Subagents

To give a subagent access to specific skills:

```yaml
# .claude/agents/code-reviewer.md
---
name: code-reviewer
description: Review code for quality and best practices
skills: pr-review, security-check
tools: Read, Grep, Glob
model: sonnet
---

Your system prompt here...
```

The listed skills are loaded into the subagent's context when it starts.

### Forked Context Option

For one-off skill isolation without creating a dedicated subagent:

```yaml
---
name: document-processor
context: fork
agent: true
---
```

This runs the skill in a forked subagent with its own separate context.

---

## Comparative Analysis

### Execution Patterns Compared

| Pattern | Token Cost | Context Pollution | Latency | Complexity |
|---------|------------|-------------------|---------|------------|
| **Skill in Main Context** | High | High | Low | Simple |
| **Skill in Dedicated Subagent** | Low | Minimal | Medium | Moderate |
| **Parallel Subagents + Skills** | Very Low | Minimal | Low (parallel) | Complex |

### When to Use Each Pattern

**Skill in Main Context:**
- Simple skills under ~500 tokens total
- Quick lookups or transformations
- When latency is critical
- Single-use, non-verbose operations

**Skill in Dedicated Subagent:**
- Document processing (PDF, Excel, etc.)
- Test execution and analysis
- Code review and analysis
- Any skill producing verbose intermediate output

**Parallel Subagents with Skills:**
- Multi-step workflows
- Comparative analysis across multiple sources
- Complex research tasks
- High-throughput processing scenarios

---

## Recommended Architecture

### Optimal Pattern: Skill-Specialized Subagents

```
┌─────────────────────────────────────────────────────────┐
│                  Orchestrator Agent                      │
│            (minimal context, routing decisions)          │
│                   ~20k tokens baseline                   │
└────────────────────────┬────────────────────────────────┘
                         │ delegates based on task type
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   PDF Agent     │ │   Excel Agent   │ │   Code Review   │
│                 │ │                 │ │     Agent       │
│ skills:         │ │ skills:         │ │ skills:         │
│   - pdf         │ │   - xlsx        │ │   - pr-review   │
│                 │ │   - data-viz    │ │   - security    │
│ (isolated ctx)  │ │ (isolated ctx)  │ │ (isolated ctx)  │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    Returns summary only
                     (~150-500 tokens)
```

### Design Principles

1. **Orchestrator stays lean:** Only routing logic and high-level context
2. **Skills live in specialists:** Each skill-heavy domain gets a dedicated subagent
3. **Summaries, not transcripts:** Subagents return structured summaries, not raw output
4. **Parallel when possible:** Independent tasks run concurrently

---

## Implementation Guide

### Step 1: Create Skill-Specialized Subagent

```yaml
# .claude/agents/pdf-specialist.md
---
name: pdf-specialist
description: Process PDF documents - extract text, fill forms, merge files. Use for any PDF-related work.
skills: pdf-processing
tools: Read, Bash, Write
model: sonnet
---

You are a PDF processing specialist. Your role is to:

1. Execute PDF operations using the pdf-processing skill
2. Process all intermediate results internally
3. Return ONLY a structured summary of results

## Output Format

Always return results in this format:
- **Operation:** [what was done]
- **Files processed:** [list]
- **Key findings:** [summary]
- **Output location:** [paths to generated files]

Do not include raw text extractions or verbose intermediate outputs.
```

### Step 2: Create Orchestration Instructions

Add to your `CLAUDE.md`:

```markdown
## Skill Delegation Rules

When encountering tasks that match these patterns, delegate to specialized subagents:

| Task Pattern | Delegate To |
|--------------|-------------|
| PDF processing, form filling, document extraction | pdf-specialist |
| Excel analysis, pivot tables, data visualization | excel-specialist |
| Code review, PR analysis, security scanning | code-review-specialist |

### Delegation Protocol

1. Identify task type from user request
2. Delegate entire task to appropriate specialist subagent
3. Await summary response
4. Synthesize specialist output for user

Do NOT execute skills directly in main context for verbose operations.
```

### Step 3: Configure Parallel Execution (Advanced)

For multi-skill workflows:

```yaml
# .claude/agents/research-coordinator.md
---
name: research-coordinator
description: Coordinate multi-source research tasks using parallel specialist agents
tools: Task
model: opus
---

You coordinate research by delegating to specialists in parallel:

1. Analyze the research request
2. Identify which specialists are needed
3. Spawn parallel tasks to appropriate specialists
4. Synthesize results into cohesive analysis

Available specialists:
- pdf-specialist: Document analysis
- web-researcher: Online sources
- code-analyst: Codebase investigation
```

---

## Tradeoffs

### Arguments FOR Subagent-Based Skill Execution

| Benefit | Impact |
|---------|--------|
| Context isolation | 37-97% token savings |
| Focused system prompts | Improved output quality |
| Parallel execution | Reduced wall-clock time |
| Prevents context rot | Longer productive sessions |
| Specialized tool access | Better security posture |

### Arguments AGAINST Subagent-Based Skill Execution

| Drawback | Impact |
|----------|--------|
| Cold start latency | Subagents need time to gather context |
| Complexity overhead | More configuration required |
| Context loss | Subagents start with clean slate |
| No nested delegation | Subagents cannot spawn other subagents |
| Coordination overhead | Orchestrator must manage handoffs |

### Decision Framework

```
IF skill produces < 500 tokens working context
   AND latency is critical
   AND orchestrator has sufficient headroom
THEN execute in main context

ELSE delegate to skill-specialized subagent
```

---

## Conclusions

### Validation of Hypothesis

The hypothesis that **parallel agents should execute skills rather than the orchestrator** is **supported by the evidence** for most non-trivial skill invocations:

1. **Token economics strongly favor isolation** - 37-97% savings measured
2. **Context pollution degrades performance** - Anthropic documentation confirms this
3. **Architecture supports the pattern** - But requires explicit configuration

### Key Takeaways

1. **Claude Code does NOT automatically route skills to subagents** - This must be configured
2. **Built-in agents cannot use custom skills** - Only custom subagents with explicit `skills:` field
3. **The optimal architecture is skill-specialized subagents** - One subagent per skill domain
4. **Summaries should replace transcripts** - Subagents return structured summaries only
5. **Parallel execution compounds benefits** - For multi-skill workflows

### Recommendations

For your workshop curriculum and consulting practice:

1. **Teach the skill-subagent pattern** as the default architecture for production Claude Code implementations
2. **Create reference implementations** of skill-specialized subagents for common domains
3. **Develop metrics** for measuring context efficiency in client deployments
4. **Build templates** for CLAUDE.md orchestration instructions

---

## Sources

Anthropic. "Agent Skills - Claude Code Docs." *Claude Code Documentation*, 2025. https://code.claude.com/docs/en/skills

Anthropic. "Create Custom Subagents - Claude Code Docs." *Claude Code Documentation*, 2025. https://code.claude.com/docs/en/sub-agents

Anthropic. "Subagents in the SDK - Claude Docs." *Claude Developer Platform*, 2025. https://platform.claude.com/docs/en/agent-sdk/subagents

Anthropic. "Introducing Advanced Tool Use on the Claude Developer Platform." *Anthropic Engineering Blog*, 2025. https://www.anthropic.com/engineering/advanced-tool-use

Folkman, Tyler. "Claude Skills Solve the Context Window Problem (Here's How They Work)." *The AI Architect*, 26 Oct. 2025. https://tylerfolkman.substack.com/p/the-complete-guide-to-claude-skills

Lee, Hanchung. "Claude Agent Skills: A First Principles Deep Dive." *Personal Blog*, 26 Oct. 2025. https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/

PubNub. "Best Practices for Claude Code Subagents." *PubNub Blog*, 28 Aug. 2025. https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/

Shankar, Shrivu. "How I Use Every Claude Code Feature." *SSHH Blog*, 2 Nov. 2025. https://blog.sshh.io/p/how-i-use-every-claude-code-feature

Shilkov, Mikhail. "Inside Claude Code Skills: Structure, Prompts, Invocation." *mikhail.io*, Oct. 2025. https://mikhail.io/2025/10/claude-code-skills/

Snapp, Rich. "Context Management with Subagents in Claude Code." *RichSnapp.com*, 5 Oct. 2025. https://www.richsnapp.com/article/2025/10-05-context-management-with-subagents-in-claude-code

---

## Appendix: Quick Reference

### Subagent Configuration Template

```yaml
---
name: [skill-domain]-specialist
description: [What this agent does]. Use for [trigger conditions].
skills: [skill-1], [skill-2]
tools: [tool-1], [tool-2]
model: sonnet
---

You are a [domain] specialist. 

## Responsibilities
- Execute [skill] operations
- Process intermediate results internally  
- Return structured summaries only

## Output Format
- **Operation:** [description]
- **Results:** [summary]
- **Files:** [locations]
```

### Token Budget Planning

| Component | Typical Tokens | Notes |
|-----------|----------------|-------|
| System prompt | 3,000-10,000 | Scales with CLAUDE.md size |
| Skill metadata (10 skills) | 300-500 | 30-50 per skill |
| Full skill load | 500-2,000 | Per invoked skill |
| Subagent summary | 150-500 | Per delegation |
| Working headroom | 150,000+ | For actual work |

### Performance Monitoring

Check context usage regularly:
```
/context
```

Target: Keep orchestrator under 50% utilization for optimal performance.
