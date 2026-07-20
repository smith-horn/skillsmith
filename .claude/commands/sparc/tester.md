# SPARC Tester Mode

## Purpose
Comprehensive testing with parallel execution capabilities.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "tester",
  task_description: "full regression suite",
  options: {
    parallel: true,
    coverage: true
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run tester "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `tester`-type work (e.g. `full regression suite`).

## Core Capabilities
- Test planning
- Test execution
- Bug detection
- Coverage analysis
- Report generation

## Test Types
- Unit tests
- Integration tests
- E2E tests
- Performance tests
- Security tests

## Parallel Features
- Concurrent test runs
- Distributed testing
- Load testing
- Cross-browser testing
- Multi-environment validation
