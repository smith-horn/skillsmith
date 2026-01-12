# Orchestrator-Delegation Pattern

> **Phase 10 Documentation** | SMI-1395
> For integration into Skill Builder

## Overview

The Orchestrator-Delegation pattern separates task coordination from execution, achieving significant token savings by isolating verbose operations in subagents while keeping the orchestrator's context clean.

### Token Economics

| Scenario | Without Delegation | With Delegation | Savings |
|----------|-------------------|-----------------|---------|
| Single verbose task | 43,588 tokens | 27,297 tokens | **37%** |
| 10-worker swarm | 50,000 tokens | 1,500 tokens | **97%** |

---

## Pattern Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                         │
│  (Claude Code main context - token-conscious)           │
│                                                         │
│  Responsibilities:                                      │
│  • User interaction                                     │
│  • Task decomposition                                   │
│  • Agent coordination                                   │
│  • Result synthesis                                     │
│  • Context: ~10,000 tokens (preserved)                 │
└─────────────────────────────────────────────────────────┘
              │                    │                    │
              ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   SPECIALIST A  │  │   SPECIALIST B  │  │   SPECIALIST C  │
│   (Subagent)    │  │   (Subagent)    │  │   (Subagent)    │
│                 │  │                 │  │                 │
│ • PDF Analysis  │  │ • Code Review   │  │ • Test Execute  │
│ • 50K tokens    │  │ • 30K tokens    │  │ • 40K tokens    │
│   (isolated)    │  │   (isolated)    │  │   (isolated)    │
│                 │  │                 │  │                 │
│ Returns: ~500   │  │ Returns: ~400   │  │ Returns: ~300   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## Implementation

### Step 1: Identify Delegation Candidates

```javascript
// Task classification function
function shouldDelegate(task) {
  const delegationCriteria = [
    task.expectedTokens > 500,           // Verbose output
    task.type === 'document_processing', // PDF, Excel, etc.
    task.type === 'multi_file_analysis', // Code review
    task.type === 'test_execution',      // Test suites
    task.type === 'research',            // Iterative research
  ];

  return delegationCriteria.some(criterion => criterion);
}
```

### Step 2: Create Specialist Prompts

```javascript
// Template for specialist delegation
const specialistPrompt = (task) => `
You are a ${task.specialistType} specialist.

INPUT: ${task.input}

INSTRUCTIONS: ${task.instructions}

OUTPUT CONSTRAINTS:
- Maximum ${task.tokenBudget} tokens
- Format: ${task.outputFormat}
- Include only: ${task.requiredFields.join(', ')}

SUCCESS CRITERIA: ${task.successCriteria}
`;
```

### Step 3: Execute Delegation

```javascript
// CORRECT: Single message with all delegations
[Single Message]:
  Task("PDF Specialist",
    `Analyze ${pdfPath}. Return: summary (100 words), ` +
    `key metrics (JSON), recommendations (3 bullets). ` +
    `Max 500 tokens.`,
    "researcher")

  Task("Code Reviewer",
    `Review ${codePath} for security issues. Return: ` +
    `findings as JSON with severity, location, fix. ` +
    `Max 400 tokens.`,
    "code-analyzer")

  Task("Test Runner",
    `Execute npm test. Return: pass/fail counts, ` +
    `failing test names only. Max 300 tokens.`,
    "tester")
```

### Step 4: Synthesize Results

```javascript
// Orchestrator receives compact summaries
const results = await Promise.all([
  pdfAnalysis,    // ~500 tokens
  codeReview,     // ~400 tokens
  testResults     // ~300 tokens
]);

// Total context impact: ~1,200 tokens
// vs. 120,000+ tokens without delegation
```

---

## Skill Builder Integration

### Adding to CLAUDE.md

Skills should include delegation rules in their CLAUDE.md:

```markdown
## Skill Delegation Rules

| Task Pattern | Delegate To | Return Budget |
|--------------|-------------|---------------|
| PDF processing | pdf-specialist | ~500 tokens |
| Code review | code-review-specialist | ~400 tokens |
| Test execution | test-runner-specialist | ~300 tokens |
| Excel analysis | data-analyst | ~400 tokens |
| Research query | researcher | ~600 tokens |

### Delegation Protocol

1. Identify task type from user request
2. Check if task matches delegation criteria
3. Delegate entire task to appropriate specialist
4. Await summary response (enforce token budget)
5. Synthesize specialist output for user

**CRITICAL**: Do NOT execute verbose skills in main context.
```

### Skill Builder Template

When creating skills, include delegation awareness:

```yaml
# skill-definition.yaml
name: "my-skill"
delegation:
  enabled: true
  threshold: 500  # tokens
  specialists:
    - pattern: "analyze.*pdf"
      agent: "researcher"
      budget: 500
    - pattern: "review.*code"
      agent: "code-analyzer"
      budget: 400
    - pattern: "run.*test"
      agent: "tester"
      budget: 300
```

---

## Decision Framework

### Quick Decision Tree

```
Is expected output > 500 tokens?
├── YES → Delegate to specialist
│         └── Define token budget in prompt
│
└── NO → Is task latency-critical?
         ├── YES → Execute in main context
         │
         └── NO → Is context headroom > 50%?
                  ├── YES → Execute in main context
                  │
                  └── NO → Delegate to specialist
```

### Delegation Checklist

Before executing in main context, verify:

- [ ] Output will be under 500 tokens
- [ ] No document processing required
- [ ] Single-file operation only
- [ ] Not a test execution
- [ ] Not iterative research
- [ ] Context headroom > 50%

If ANY checkbox fails → **DELEGATE**

---

## Examples by Task Type

### Document Analysis

```javascript
// ❌ WRONG: PDF in main context (50K+ tokens)
Read("/reports/annual-2025.pdf")

// ✅ CORRECT: Delegate to specialist
Task("PDF Analyst",
  "Analyze /reports/annual-2025.pdf. " +
  "Extract: executive summary (100 words), " +
  "financial highlights (5 metrics), " +
  "risk factors (top 3). " +
  "Max 500 tokens.",
  "researcher")
```

### Code Review

```javascript
// ❌ WRONG: Multi-file review in main context (30K+ tokens)
files.forEach(f => Read(f))
// ... then analyze each file

// ✅ CORRECT: Delegate to specialist
Task("Code Reviewer",
  "Review all files in /src/api/ for: " +
  "1. Security vulnerabilities (OWASP Top 10) " +
  "2. Performance issues " +
  "3. Best practice violations " +
  "Return: JSON array with severity, file, line, issue, fix. " +
  "Max 400 tokens.",
  "code-analyzer")
```

### Test Execution

```javascript
// ❌ WRONG: Full test output in main context (40K+ tokens)
Bash("npm test")

// ✅ CORRECT: Delegate to specialist
Task("Test Runner",
  "Execute: npm test " +
  "Return only: " +
  "- Total: X passed, Y failed " +
  "- Failed tests: [list names only] " +
  "- Coverage: X% " +
  "Max 300 tokens.",
  "tester")
```

### Research Tasks

```javascript
// ❌ WRONG: Verbose research in main context
WebSearch("best practices for...")
// ... multiple searches and analysis

// ✅ CORRECT: Delegate to specialist
Task("Research Specialist",
  "Research authentication best practices for Node.js APIs. " +
  "Consider: JWT, OAuth2, session-based. " +
  "Return: " +
  "- Recommendation (50 words) " +
  "- Comparison table (3 options) " +
  "- Top 3 libraries with rationale " +
  "Max 600 tokens.",
  "researcher")
```

---

## Performance Monitoring

### Tracking Delegation Effectiveness

```javascript
// Metrics to track
const delegationMetrics = {
  tasksTotal: 0,
  tasksDelegated: 0,
  tokensWithoutDelegation: 0,
  tokensWithDelegation: 0,

  get savingsRate() {
    return 1 - (this.tokensWithDelegation / this.tokensWithoutDelegation);
  }
};
```

### Expected Savings by Domain

| Domain | Typical Savings | Notes |
|--------|----------------|-------|
| PDF Analysis | 95-98% | Large documents benefit most |
| Code Review | 85-92% | Multi-file reviews |
| Test Execution | 90-95% | Verbose test output |
| Research | 80-90% | Iterative searches |
| Data Analysis | 88-94% | Large datasets |

---

## Anti-Patterns

### 1. Over-Delegation

```javascript
// ❌ DON'T delegate trivial tasks
Task("Specialist", "Return the current date", "researcher")
// This adds overhead for no benefit

// ✅ DO execute directly
new Date().toISOString()
```

### 2. Under-Specified Prompts

```javascript
// ❌ DON'T leave output format vague
Task("Analyst", "Analyze the code", "code-analyzer")

// ✅ DO specify exact output format and budget
Task("Analyst",
  "Analyze /src/auth.ts. " +
  "Return JSON: {issues: [{severity, line, message}], summary: string}. " +
  "Max 400 tokens.",
  "code-analyzer")
```

### 3. Sequential Delegation

```javascript
// ❌ DON'T delegate one at a time
Message 1: Task("Agent A", ...)
Message 2: Task("Agent B", ...)
Message 3: Task("Agent C", ...)

// ✅ DO batch all delegations
[Single Message]:
  Task("Agent A", ...)
  Task("Agent B", ...)
  Task("Agent C", ...)
```

---

## Integration Checklist

When integrating delegation into a skill:

1. [ ] Identify verbose operations in the skill
2. [ ] Define token budgets for each operation type
3. [ ] Create specialist prompt templates
4. [ ] Add delegation rules to CLAUDE.md
5. [ ] Update skill to use Task tool for delegation
6. [ ] Test token savings with and without delegation
7. [ ] Document delegation behavior for users

---

## Related Documentation

- [Parallel Agent Patterns](./parallel-agent-patterns.md)
- [Decision Framework Examples](./decision-framework-examples.md)
- [Token Budget Guidelines](./parallel-agent-patterns.md#token-budget-guidelines)

---

*Generated as part of Skillsmith Phase 10: Parallel Agent Execution Patterns*
