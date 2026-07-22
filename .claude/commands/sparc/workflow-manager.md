# SPARC Workflow Manager Mode

## Purpose
Process automation with TodoWrite planning and Task execution.

## Activation

### Option 1: SPARC methodology (skill + phase agents)

SPARC is not an MCP tool in ruflo v3 -- there is no `mcp__ruflo__sparc_mode` (or similarly named) tool. Use the `sparc-methodology` skill for full SPARC-workflow guidance, and dispatch the `specification`, `pseudocode`, `architecture`, or `refinement` subagent_type via the Agent tool for phase-specific work within a SPARC cycle (e.g. `automate deployment`).

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run workflow-manager "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `workflow-manager`-type work (e.g. `automate deployment`).

## Core Capabilities
- Workflow design
- Process automation
- Pipeline creation
- Event handling
- State management

## Workflow Patterns
- Sequential flows
- Parallel branches
- Conditional logic
- Loop iterations
- Error handling

## Automation Features
- Trigger management
- Task scheduling
- Progress tracking
- Result validation
- Rollback capability
