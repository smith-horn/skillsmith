# SPARC Batch Executor Mode

## Purpose
Parallel task execution specialist using batch operations.

## Activation

### Option 1: SPARC methodology (skill + phase agents)

SPARC is not an MCP tool in ruflo v3 -- there is no `mcp__ruflo__sparc_mode` (or similarly named) tool. Use the `sparc-methodology` skill for full SPARC-workflow guidance, and dispatch the `specification`, `pseudocode`, `architecture`, or `refinement` subagent_type via the Agent tool for phase-specific work within a SPARC cycle (e.g. `process multiple files`).

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
