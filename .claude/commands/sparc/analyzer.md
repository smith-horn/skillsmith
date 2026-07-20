# SPARC Analyzer Mode

## Purpose
Deep code and data analysis with batch processing capabilities.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "analyzer",
  task_description: "analyze codebase performance",
  options: {
    parallel: true,
    detailed: true
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run analyzer "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `analyzer`-type work (e.g. `analyze codebase performance`).

## Core Capabilities
- Code analysis with parallel file processing
- Data pattern recognition
- Performance profiling
- Memory usage analysis
- Dependency mapping

## Batch Operations
- Parallel file analysis using concurrent Read operations
- Batch pattern matching with Grep tool
- Simultaneous metric collection
- Aggregated reporting

## Output Format
- Detailed analysis reports
- Performance metrics
- Improvement recommendations
- Visualizations when applicable