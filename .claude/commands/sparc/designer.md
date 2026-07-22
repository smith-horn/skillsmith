# SPARC Designer Mode

## Purpose
UI/UX design with Memory coordination for consistent experiences.

## Activation

### Option 1: SPARC methodology (skill + phase agents)

SPARC is not an MCP tool in ruflo v3 -- there is no `mcp__ruflo__sparc_mode` (or similarly named) tool. Use the `sparc-methodology` skill for full SPARC-workflow guidance, and dispatch the `specification`, `pseudocode`, `architecture`, or `refinement` subagent_type via the Agent tool for phase-specific work within a SPARC cycle (e.g. `create dashboard UI`).

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
