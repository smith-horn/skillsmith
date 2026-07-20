# SPARC TDD Mode

## Purpose
Test-driven development with TodoWrite planning and comprehensive testing.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "tdd",
  task_description: "shopping cart feature",
  options: {
    coverage_target: 90,
    test_framework: "jest"
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run tdd "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `tdd`-type work (e.g. `shopping cart feature`).

## Core Capabilities
- Test-first development
- Red-green-refactor cycle
- Test suite design
- Coverage optimization
- Continuous testing

## TDD Workflow
1. Write failing tests
2. Implement minimum code
3. Make tests pass
4. Refactor code
5. Repeat cycle

## Testing Strategies
- Unit testing
- Integration testing
- End-to-end testing
- Performance testing
- Security testing
