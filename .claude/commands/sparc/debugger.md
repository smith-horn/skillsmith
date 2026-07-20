# SPARC Debugger Mode

## Purpose
Systematic debugging with TodoWrite and Memory integration.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "debugger",
  task_description: "fix authentication issues",
  options: {
    verbose: true,
    trace: true
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run debugger "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `debugger`-type work (e.g. `fix authentication issues`).

## Core Capabilities
- Issue reproduction
- Root cause analysis
- Stack trace analysis
- Memory leak detection
- Performance bottleneck identification

## Debugging Workflow
1. Create debugging plan with TodoWrite
2. Systematic issue investigation
3. Store findings in Memory
4. Track fix progress
5. Verify resolution

## Tools Integration
- Error log analysis
- Breakpoint simulation
- Variable inspection
- Call stack tracing
- Memory profiling
