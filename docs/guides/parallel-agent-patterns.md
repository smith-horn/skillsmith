# Parallel Agent Execution Patterns

A practical guide to optimizing Claude Code workflows through strategic subagent delegation.

---

## Executive Summary

### Token Economics at a Glance

| Execution Model | Single Task | 10-Worker Scenario |
|-----------------|-------------|-------------------|
| Main Context | 43,588 tokens | 50,000 tokens |
| Subagent Isolated | 27,297 tokens | 1,500 tokens |
| **Savings** | **37%** | **97%** |

### The Problem

Claude Code skills execute in the main conversation context by default. Every skill instruction, intermediate output, and working state accumulates in the context window. This leads to:

- **Token waste**: You pay for intermediate outputs you never see
- **Context pollution**: Useful context gets buried in noise
- **Performance degradation**: Response quality drops as context fills
- **No parallelization**: Skills execute one at a time

### The Solution

Delegate verbose operations to isolated subagents. The orchestrator receives only structured summaries while subagent contexts are discarded after task completion.

**Result**: A lean orchestrator context that stays under 30K tokens regardless of task complexity.

---

## The Context Pollution Problem

### How Skills Execute by Default

When you invoke a skill in the main context, the following accumulates:

```
User request                              ~100 tokens
Skill A SKILL.md loaded                   ~2,000 tokens
Skill A tool calls (search, read, etc.)   ~3,000 tokens
Skill A intermediate reasoning            ~2,000 tokens
Skill A final output                      ~500 tokens
Skill B SKILL.md loaded                   ~1,500 tokens
Skill B tool calls                        ~2,500 tokens
Skill B intermediate reasoning            ~500 tokens
Skill B final output                      ~400 tokens
─────────────────────────────────────────────────────
Total after 2 skills:                     ~12,500 tokens
```

**This only grows.** After 5 skills, you're at 30K+ tokens. After 10, the context window starts affecting response quality.

### Visual Comparison

```
┌─────────────────────────────────────────────────────────────┐
│                 MAIN CONTEXT EXECUTION                       │
│                 (Default Behavior - AVOID)                   │
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
│  │ - SKILL.md loaded  │  │ - Full execution   │             │
│  │ - Full execution   │  │ - Returns summary  │             │
│  │ - Returns summary  │  └────────────────────┘             │
│  └────────────────────┘  (Context discarded)                │
│  (Context discarded)                                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Decision Framework

### Quick Decision Tree

```
Is the task expected to produce >500 tokens of working context?
    │
    ├── YES ──► DELEGATE TO SUBAGENT
    │
    └── NO ──► Does it involve document processing (PDF, Excel, etc.)?
                    │
                    ├── YES ──► DELEGATE TO SUBAGENT
                    │
                    └── NO ──► Are multiple independent analyses needed?
                                    │
                                    ├── YES ──► PARALLEL SUBAGENTS
                                    │
                                    └── NO ──► EXECUTE IN MAIN CONTEXT
```

### When to Execute in Main Context

Execute directly when **ALL** of these are true:

- Simple lookup returning <500 tokens
- Latency is critical (user waiting for immediate response)
- Single-shot operation with no intermediate state
- Orchestrator context has >50% headroom remaining

**Examples suitable for main context:**
```
- "What's my current git branch?"
- "Show me the contents of config.json"
- "What version of Node is installed?"
- Simple file edits under 50 lines
```

### When to Delegate to Subagent

Delegate when **ANY** of these are true:

- Operation will produce >500 tokens of intermediate output
- Task involves document processing (PDF, Excel, large files)
- Multi-file analysis or code review needed
- Research tasks requiring iterative exploration
- Test execution (verbose output, many assertions)

**Examples requiring subagent delegation:**
```
- "Analyze this 50-page PDF"
- "Review all TypeScript files for security issues"
- "Run the full test suite and summarize failures"
- "Research authentication best practices"
- "Compare 5 different API approaches"
```

### Pattern Selection Matrix

| Task Type | Main Context | Dedicated Subagent | Parallel Subagents |
|-----------|:------------:|:-----------------:|:-----------------:|
| Simple lookup | Preferred | Overkill | Overkill |
| Single file edit | Preferred | Optional | Overkill |
| Quick status check | Preferred | Overkill | Overkill |
| Document processing | Avoid | **Preferred** | Optional |
| Multi-file analysis | Avoid | **Preferred** | For comparison |
| Test execution | Avoid | **Preferred** | For parallel suites |
| Research workflow | Avoid | **Preferred** | Multiple sources |
| Code review | Avoid | **Preferred** | Multiple reviewers |

---

## Implementation Patterns

### Pattern 1: Dedicated Specialist Subagent

Use when you have a recurring task type that benefits from skill specialization.

#### Setup

Create a specialist prompt that will be used by the subagent:

```markdown
<!-- File: .claude/prompts/pdf-specialist.md -->

# PDF Analysis Specialist

You are a PDF analysis specialist. Your role is to:

1. Process the provided PDF document
2. Extract key information based on the task
3. Return a structured summary within 500 tokens

## Response Format

Always return in this structure:

### Summary
[2-3 sentence overview]

### Key Findings
- Finding 1
- Finding 2
- Finding 3

### Relevant Excerpts
[Direct quotes with page numbers if applicable]

### Recommendations
[If applicable, 1-2 actionable items]

## Token Budget
Your response MUST NOT exceed 500 tokens. Prioritize the most important information.
```

#### Invocation

Use Claude Code's Task tool to spawn the specialist:

```javascript
// Spawn a PDF specialist subagent
Task(
  "PDF Specialist",
  `Analyze the contract at /path/to/contract.pdf and extract:
   - Key terms and conditions
   - Important dates
   - Financial obligations

   Return a structured summary under 500 tokens.`,
  { skills: ["pdf-reader"] }
)
```

#### Receiving Results

The orchestrator receives only the bounded summary:

```markdown
### Summary
This is a 3-year service agreement with ABC Corp effective Jan 1, 2026.

### Key Findings
- Annual fee: $50,000 paid quarterly
- Auto-renewal clause with 90-day termination notice
- SLA guarantees 99.9% uptime with credits for breaches

### Recommendations
- Calendar the Aug 1, 2028 termination notice deadline
```

**Token impact**: ~150 tokens in orchestrator vs ~3,000+ if processed directly.

---

### Pattern 2: CLAUDE.md Delegation Rules

Encode delegation logic in CLAUDE.md so the orchestrator automatically routes tasks.

#### Add to CLAUDE.md

```markdown
## Skill Delegation Rules

When encountering these task patterns, delegate to specialized subagents:

| Task Pattern | Skill(s) to Attach | Return Budget |
|--------------|-------------------|---------------|
| PDF processing | pdf-reader | 500 tokens |
| Excel analysis | excel-parser | 300 tokens |
| Code review | code-review, security-audit | 500 tokens |
| Test execution | test-runner | 400 tokens |
| Research tasks | web-search, doc-reader | 600 tokens |
| Image analysis | vision-analyzer | 300 tokens |

### Delegation Protocol

When a user request matches a task pattern above:

1. **Identify**: Recognize the task type from the request
2. **Delegate**: Spawn a Task with the appropriate skill(s)
3. **Await**: Wait for the bounded summary response
4. **Synthesize**: Combine subagent output with conversational response

### Delegation Prompt Template

When delegating, use this prompt structure:

```text
You are a specialist for [TASK_TYPE].

Task: [SPECIFIC_USER_REQUEST]

Context: [RELEVANT_CONTEXT_FROM_ORCHESTRATOR]

Requirements:
- Complete the task fully
- Return a structured summary
- Maximum response: [TOKEN_BUDGET] tokens
- Include: [KEY_ITEMS_TO_RETURN]
- Omit: Intermediate reasoning, verbose logs, raw data
```

**Do NOT execute skills directly for verbose operations.**
```

---

### Pattern 3: Parallel Skill Execution

Use when multiple independent analyses are needed simultaneously.

#### When to Use

- Comparing multiple approaches or implementations
- Running independent audits (security, performance, style)
- Analyzing multiple files that don't depend on each other
- Gathering research from multiple sources

#### Implementation

Spawn multiple Task calls in a single message:

```javascript
// All three run in parallel
Task(
  "Security Analyst",
  "Audit src/auth/ for security vulnerabilities. Return top 5 issues with severity.",
  { skills: ["security-audit"] }
)

Task(
  "Performance Analyst",
  "Profile src/auth/ for performance bottlenecks. Return top 5 issues with impact.",
  { skills: ["perf-analyzer"] }
)

Task(
  "Style Reviewer",
  "Check src/auth/ for style guide violations. Return top 5 issues with locations.",
  { skills: ["style-checker"] }
)
```

#### Synthesis

The orchestrator receives three bounded summaries (~1,500 tokens total):

```markdown
## Combined Analysis Results

### Security (from Security Analyst)
1. SQL injection risk in loginHandler.ts:45 - HIGH
2. Missing rate limiting on /api/login - HIGH
3. Weak password validation regex - MEDIUM
...

### Performance (from Performance Analyst)
1. N+1 query in getUserRoles() - HIGH
2. Missing index on users.email - MEDIUM
3. Synchronous bcrypt blocking event loop - MEDIUM
...

### Style (from Style Reviewer)
1. Inconsistent error handling patterns - LOW
2. Missing JSDoc on public functions - LOW
3. Long functions exceeding 50 lines - LOW
...
```

**Token savings**: ~1,500 tokens vs ~15,000+ if run sequentially in main context.

---

### Pattern 4: Forked Context for One-Off Tasks

Use for skill isolation when you don't need a persistent specialist.

#### When to Use

- One-time analysis that won't be repeated
- Tasks that need skill capabilities but aren't part of a recurring pattern
- Exploratory work where you're testing an approach

#### Implementation

```javascript
// Fork a temporary context for a one-off task
Task(
  "One-off Analysis",
  `Analyze the API response structure in /tmp/api-response.json.

   Determine:
   - Top-level structure
   - Data types for each field
   - Any nested objects or arrays

   Return a TypeScript interface definition (max 300 tokens).`,
  {
    skills: ["json-analyzer"],
    returnBudget: 300
  }
)
```

#### Result

The orchestrator receives just the interface definition:

```typescript
interface ApiResponse {
  status: 'success' | 'error';
  data: {
    users: User[];
    pagination: Pagination;
  };
  meta: {
    timestamp: string;
    version: string;
  };
}
```

The full JSON analysis (potentially thousands of tokens) stays in the discarded subagent context.

---

## Token Budget Guidelines

### Summary Return Budgets by Domain

| Domain | Max Return Tokens | Rationale | Example Output |
|--------|------------------|-----------|----------------|
| Quick lookup | 100-200 | Single fact retrieval | `"Node v20.11.0"` |
| File operation | 200-300 | Status + path | `"Created 3 files in src/auth/"` |
| Code review | 300-500 | Findings + locations | 5 issues with file:line |
| Document analysis | 400-600 | Summary + key points | Executive summary + bullets |
| Test execution | 300-500 | Pass/fail + failures | `"47 passed, 3 failed: [list]"` |
| Research | 500-800 | Findings + sources | Key insights + citations |

### Orchestrator Context Budget Management

For sustainable orchestration across long sessions:

| Metric | Target | Why |
|--------|--------|-----|
| Total orchestrator context | <30K tokens | Leaves headroom for quality responses |
| Reserved for user interaction | 50% | User messages need room to accumulate |
| Max per subagent return | 500 tokens | Keeps synthesis manageable |
| Max parallel subagents | 5-10 | Diminishing returns beyond this |

### Budget Enforcement

Add these constraints to your delegation prompts:

```markdown
## Response Constraints

- **Hard limit**: 500 tokens maximum
- **Structure**: Use headers and bullets, not prose
- **Prioritize**: Most important findings first
- **Omit**:
  - Intermediate reasoning steps
  - Raw data or logs
  - Verbose explanations
  - "Let me think about this..." preambles
```

---

## Performance Metrics

### Measuring Token Efficiency

Track these metrics to validate your delegation strategy:

```typescript
interface ParallelExecutionMetrics {
  // Token metrics
  orchestratorContextSize: number;      // Current orchestrator tokens
  subagentTokensTotal: number;          // Sum of all subagent contexts
  mainContextAlternative: number;       // What it would cost in main context
  tokenSavingsPercent: number;          // (1 - actual/alternative) * 100

  // Timing metrics
  delegationDecisionMs: number;         // Time to decide to delegate
  subagentSpawnMs: number;              // Time to spawn subagent
  subagentExecutionMs: number;          // Time in subagent
  synthesisMs: number;                  // Time to combine results
  totalTaskMs: number;                  // End-to-end

  // Quality metrics
  summaryCompleteness: 'full' | 'partial' | 'truncated';
  taskSuccess: boolean;
  userSatisfaction?: 1 | 2 | 3 | 4 | 5;
}
```

### Health Indicators

Monitor these for healthy parallel execution:

| Indicator | Healthy | Warning | Critical |
|-----------|---------|---------|----------|
| Orchestrator context growth | <1K/task | 1-3K/task | >3K/task |
| Average subagent return | <400 tokens | 400-600 tokens | >600 tokens |
| Delegation decision time | <100ms | 100-500ms | >500ms |
| Task completion rate | >95% | 85-95% | <85% |
| Token savings vs main | >50% | 30-50% | <30% |

### Identifying Problems

**Context growing too fast?**
- Check if subagent returns are exceeding budgets
- Look for skills that should be delegated but aren't
- Review if orchestrator is doing work it should delegate

**Subagent returns too large?**
- Tighten the return budget in prompts
- Add explicit "omit" instructions
- Use more structured output formats

**Tasks failing?**
- Subagent may lack necessary context
- Skill may not be attached correctly
- Return budget may be too restrictive for task

---

## Tradeoffs

### Benefits of Subagent Isolation

| Benefit | Impact | Details |
|---------|--------|---------|
| Token savings | 37-97% reduction | Scales dramatically with task count |
| Context preservation | No degradation | Orchestrator stays lean and focused |
| Parallel execution | 2-5x faster | Multiple tasks run simultaneously |
| Focused prompts | Higher accuracy | Each subagent specializes in one domain |
| Clear boundaries | Easier debugging | Issues isolated to specific subagent |
| Session longevity | 5-10x more tasks | Context doesn't fill up |

### Costs of Subagent Isolation

| Cost | Impact | Mitigation |
|------|--------|------------|
| Cold start latency | ~500-1000ms per spawn | Pre-warm common specialists |
| Coordination complexity | More moving parts | Clear delegation rules in CLAUDE.md |
| Context loss | Subagent can't see main context | Pass necessary context in prompt |
| No nested delegation | Subagents can't spawn subagents | Flat hierarchy design |
| Setup overhead | Initial configuration time | Automated generation tools |
| Summary truncation | Some detail lost | Explicit "include X" instructions |

### When NOT to Use Subagents

Subagent delegation is overkill when:

- Task produces <500 tokens total
- You need immediate (<100ms) response
- Task requires access to orchestrator's full context
- Single simple operation with no iteration
- You're in an already-delegated subagent (no nesting)

---

## Getting Started

### Step 1: Audit Your Current Token Usage

Run a typical session and note:

1. Which skills are you using most?
2. How much intermediate output do they produce?
3. Where does your context get filled fastest?

```bash
# Check context size at any point
# (Token count appears in Claude Code status)
```

### Step 2: Identify Delegation Candidates

Create a list of your verbose operations:

```markdown
| Operation | Typical Output | Frequency | Delegate? |
|-----------|---------------|-----------|-----------|
| PDF analysis | ~3,000 tokens | Daily | Yes |
| Test runs | ~2,000 tokens | Hourly | Yes |
| Git status | ~100 tokens | Constant | No |
| File reads | ~500 tokens | Constant | No |
| Code review | ~4,000 tokens | Weekly | Yes |
```

### Step 3: Add Delegation Rules to CLAUDE.md

Copy this template and customize:

```markdown
## Skill Delegation Rules

### Always Delegate

| Pattern | Subagent Type | Return Budget |
|---------|--------------|---------------|
| "analyze PDF" | pdf-specialist | 500 tokens |
| "run tests" | test-runner | 400 tokens |
| "review code" | code-reviewer | 500 tokens |
| "research X" | researcher | 600 tokens |

### Delegation Prompt Template

When delegating, spawn Task with:

\`\`\`
You are a [TYPE] specialist.

Task: [USER_REQUEST]

Context from orchestrator:
[RELEVANT_CONTEXT]

Return a structured summary in [BUDGET] tokens max.
Include: [REQUIRED_ITEMS]
Omit: Intermediate steps, raw data, verbose explanations
\`\`\`
```

### Step 4: Create Your First Specialist Prompt

Start with your highest-volume verbose task:

```markdown
<!-- .claude/prompts/test-specialist.md -->

# Test Execution Specialist

Execute tests and return a structured summary.

## Response Format

### Status
[PASSED/FAILED] - X passed, Y failed, Z skipped

### Failures (if any)
1. \`test_name\` - Expected X, got Y (file:line)
2. \`test_name\` - Error message (file:line)

### Coverage (if available)
- Statements: X%
- Branches: Y%
- Lines: Z%

## Constraints
- Max 400 tokens
- List only failing tests, not passing ones
- Include file:line for each failure
```

### Step 5: Practice Delegation

Try this sequence to build muscle memory:

```javascript
// Instead of running tests directly:
Task(
  "Test Runner",
  "Run npm test and report failures only. Max 400 tokens.",
  { skills: ["test-runner"] }
)

// Instead of reviewing code directly:
Task(
  "Code Reviewer",
  "Review src/auth.ts for security issues. Top 5 only, 500 tokens max.",
  { skills: ["code-review"] }
)

// Instead of analyzing a document directly:
Task(
  "Document Analyst",
  "Summarize the key decisions in docs/adr/015-*.md. 400 tokens max.",
  { skills: ["doc-reader"] }
)
```

### Step 6: Monitor and Adjust

After a week of delegation:

1. Check your average session token count
2. Note which subagents return over-budget
3. Identify tasks that should be delegated but aren't
4. Refine return budgets based on actual needs

---

## Quick Reference Card

### Decision Checklist

```
[ ] Will task produce >500 tokens of output?
    → YES: Delegate to subagent

[ ] Does task involve document processing?
    → YES: Delegate to subagent

[ ] Are multiple independent analyses needed?
    → YES: Parallel subagents

[ ] All NO above?
    → Execute in main context
```

### Delegation Template

```javascript
Task(
  "[Specialist Type]",
  `[Task description]

   Context: [Relevant info from orchestrator]

   Requirements:
   - [Specific output needed]
   - Max [N] tokens
   - Structure: [format]`,
  { skills: ["skill-name"] }
)
```

### Common Return Budgets

- Quick lookup: 200 tokens
- File operation: 300 tokens
- Code review: 500 tokens
- Test results: 400 tokens
- Research: 600 tokens

---

## References

- Architecture: [Parallel Agent Execution Architecture](../architecture/parallel-agent-execution-architecture.md)
- Implementation: [Parallel Agent Execution Implementation](../execution/parallel-agent-execution-implementation.md)
- Research: [Parallel Agents Skills Research](../backlog/skill-optimizations/parallel-agents-skills-research.md)
