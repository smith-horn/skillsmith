# SPARC Batch Executor Mode

## Purpose
Parallel task execution specialist using batch operations.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "batch-executor",
  task_description: "process multiple files",
  options: {
    parallel: true,
    batch_size: 10
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run batch-executor "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `batch-executor`-type work (e.g. `process multiple files`).

## Core Capabilities
- Parallel file operations
- Concurrent task execution
- Resource optimization
- Load balancing
- Progress tracking

## Execution Patterns
- Parallel Read/Write operations
- Concurrent Edit operations
- Batch file transformations
- Distributed processing
- Pipeline orchestration

## Performance Features
- Dynamic resource allocation
- Automatic load balancing
- Progress monitoring
- Error recovery
- Result aggregation
