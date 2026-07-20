# SPARC Architect Mode

## Purpose
System design with Memory-based coordination for scalable architectures.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "architect",
  task_description: "design microservices architecture",
  options: {
    detailed: true,
    memory_enabled: true
  }
}
```

### Option 2: SPARC CLI is unavailable in v3

The `sparc` subcommand does not exist in ruflo v3 (`npx -y ruflo@3.14.2 sparc --help` returns `[ERROR] Unknown command: sparc`) -- there is no CLI equivalent to `sparc run architect "..."`. Use the `sparc-methodology` skill for SPARC-workflow guidance, or dispatch a role-specific subagent via the Agent tool for `architect`-type work (e.g. `design microservices architecture`).

## Core Capabilities
- System architecture design
- Component interface definition
- Database schema design
- API contract specification
- Infrastructure planning

## Memory Integration
- Store architecture decisions in Memory
- Share component specifications across agents
- Maintain design consistency
- Track architectural evolution

## Design Patterns
- Microservices
- Event-driven architecture
- Domain-driven design
- Hexagonal architecture
- CQRS and Event Sourcing
