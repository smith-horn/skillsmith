# SPARC Designer Mode

## Purpose
UI/UX design with Memory coordination for consistent experiences.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "designer",
  task_description: "create dashboard UI",
  options: {
    design_system: true,
    responsive: true
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run designer "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `designer`-type work (e.g. `create dashboard UI`).

## Core Capabilities
- Interface design
- Component architecture
- Design system creation
- Accessibility planning
- Responsive layouts

## Design Process
- User research insights
- Wireframe creation
- Component design
- Interaction patterns
- Design token management

## Memory Coordination
- Store design decisions
- Share component specs
- Maintain consistency
- Track design evolution
