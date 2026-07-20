# SPARC Reviewer Mode

## Purpose
Code review using batch file analysis for comprehensive reviews.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "reviewer",
  task_description: "review pull request #123",
  options: {
    security_check: true,
    performance_check: true
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run reviewer "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `reviewer`-type work (e.g. `review pull request #123`).

## Core Capabilities
- Code quality assessment
- Security review
- Performance analysis
- Best practices check
- Documentation review

## Review Criteria
- Code correctness
- Design patterns
- Error handling
- Test coverage
- Maintainability

## Batch Analysis
- Parallel file review
- Pattern detection
- Dependency checking
- Consistency validation
- Automated reporting
