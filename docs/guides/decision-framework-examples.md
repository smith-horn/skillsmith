# Decision Framework Examples

This guide provides concrete examples of when to use main context execution versus subagent delegation.

## Quick Reference Matrix

| Scenario | Decision | Return Budget | Key Factor |
|----------|----------|---------------|------------|
| PDF Form Processing | Delegate | ~500 tokens | Verbose document output |
| Quick File Lookup | Main Context | N/A | Simple, <100 tokens |
| Multi-File Code Review | Delegate | ~400 tokens | Multi-file analysis |
| Parallel Research | Parallel Subagents | ~500 tokens each | Independent tasks |
| Test Execution | Delegate | ~300 tokens | Verbose output |

---

## Scenario 1: PDF Form Processing

### Task Description
Fill out a multi-page PDF form with user-provided data.

### Decision: Delegate to pdf-specialist

### Rationale
Document processing operations generate extensive intermediate output (field detection, validation logs, parsing details) that would pollute the main context. The subagent processes the entire document and returns only the essential completion status and output location.

**Return Budget**: ~500 tokens

---

## Scenario 2: Quick File Lookup

### Task Description
Check if a configuration file exists and retrieve its path.

### Decision: Execute in Main Context

### Rationale
Spawning a subagent for a simple file existence check would incur more overhead than the task itself. The output is minimal (a path or "not found"), and the result is likely needed immediately for subsequent decision-making.

**Return Budget**: N/A (main context)

---

## Scenario 3: Multi-File Code Review

### Task Description
Review changes across 10 modified files for code quality and potential issues.

### Decision: Delegate to code-review-specialist

### Rationale
A thorough code review of 10 files would generate extensive per-file commentary, diffs, and suggestions. The subagent consolidates all findings into an actionable summary with only the critical issues highlighted.

**Return Budget**: ~400 tokens

---

## Scenario 4: Parallel Research

### Task Description
Research three different JavaScript testing libraries to compare features.

### Decision: Parallel Subagents

### Rationale
Each library research task is completely independent with no shared state or dependencies. Running them in parallel maximizes efficiency. Each subagent returns a structured comparison format that can be easily combined.

**Return Budget**: ~500 tokens per subagent

### Parallel Execution Pattern
\`\`\`
Main Context:
  |
  +---> Subagent 1: Research Jest      --> 500 tokens
  +---> Subagent 2: Research Vitest    --> 500 tokens
  +---> Subagent 3: Research Mocha     --> 500 tokens
  |
  <--- Combine results (1500 tokens total)
\`\`\`

---

## Scenario 5: Test Execution

### Task Description
Run the full test suite and report results.

### Decision: Delegate to test-runner-specialist

### Rationale
A full test suite generates thousands of tokens of output (individual test names, timing, stack traces, coverage reports). The main context only needs the pass/fail summary and specific failure details if any tests failed.

**Return Budget**: ~300 tokens

---

## Decision Tree Summary

\`\`\`
Is the task output likely < 100 tokens?
  |
  YES --> Execute in Main Context
  |
  NO --> Is the task parallelizable into independent subtasks?
           |
           YES --> Spawn Parallel Subagents (budget per agent)
           |
           NO --> Delegate to Single Specialist Subagent
                    |
                    Set return budget based on:
                    - Document processing: ~500 tokens
                    - Code review: ~400 tokens
                    - Test execution: ~300 tokens
                    - Research/analysis: ~500 tokens
\`\`\`

## Return Budget Guidelines

| Task Type | Recommended Budget | Typical Contents |
|-----------|-------------------|------------------|
| Document Processing | 400-600 tokens | Status, metadata, output path, warnings |
| Code Review | 300-500 tokens | Summary, critical issues only, recommendations |
| Test Execution | 200-400 tokens | Pass/fail, counts, failure details only |
| Research | 400-600 tokens | Structured findings, pros/cons, scores |
| File Operations | 100-200 tokens | Success/failure, file counts, errors |
| API Calls | 150-300 tokens | Response summary, error details |

## Anti-Patterns to Avoid

1. **Over-Delegation** - Delegating simple tasks like \`ls\`, \`cat\`, or single file reads
2. **Under-Budgeting Returns** - Setting a 50-token budget for a code review
3. **Ignoring Parallelization** - Running independent research tasks sequentially
4. **Verbose Return Instructions** - Asking for "all details" when only a summary is needed

---

## Related Documentation

- [Parallel Agent Execution Patterns](./parallel-agent-patterns.md)
- [Token Estimation Guide](./token-estimation.md)

---

*Last updated: January 2026*
*Reference: Phase 10 - SMI-1396*
