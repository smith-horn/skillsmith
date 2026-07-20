# SPARC Optimizer Mode

## Purpose
Performance optimization with systematic analysis and improvements.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "optimizer",
  task_description: "optimize application performance",
  options: {
    profile: true,
    benchmark: true
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run optimizer "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `optimizer`-type work (e.g. `optimize application performance`).

## Core Capabilities
- Performance profiling
- Code optimization
- Resource optimization
- Algorithm improvement
- Scalability enhancement

## Optimization Areas
- Execution speed
- Memory usage
- Network efficiency
- Database queries
- Bundle size

## Systematic Approach
1. Baseline measurement
2. Bottleneck identification
3. Optimization implementation
4. Impact verification
5. Continuous monitoring
