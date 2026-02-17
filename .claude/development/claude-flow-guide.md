# Claude-Flow MCP Server Guide

Agent spawning, swarm orchestration, and SPARC development reference.

## Setup

Configured via `.mcp.json` (auto-loaded by Claude Code):

```json
{
  "mcpServers": {
    "claude-flow": {
      "command": "npx",
      "args": ["claude-flow@alpha", "mcp", "start"],
      "env": {
        "CLAUDE_FLOW_LOG_LEVEL": "info",
        "CLAUDE_FLOW_MEMORY_BACKEND": "sqlite"
      }
    }
  }
}
```

Manual setup: `claude mcp add claude-flow -- npx claude-flow@alpha mcp start`

Verify: `claude mcp list | grep claude-flow`

## MCP Tools

| Tool | Purpose |
|------|---------|
| `mcp__claude-flow__swarm_init` | Initialize swarm with topology (hierarchical, mesh, etc.) |
| `mcp__claude-flow__agent_spawn` | Spawn specialist agents |
| `mcp__claude-flow__task_orchestrate` | Coordinate task execution |
| `mcp__claude-flow__memory_usage` | Shared memory operations |
| `mcp__claude-flow__swarm_destroy` | Cleanup swarm after completion |

## Specialist Agent Types

| Agent | Role | Specialization |
|-------|------|----------------|
| `architect` | System design | API contracts, infrastructure, DDD |
| `coder` | Implementation | Backend, frontend, React, Astro, Rust |
| `tester` | QA | Unit, integration, E2E, security tests |
| `reviewer` | Code review | Security audit, best practices |
| `researcher` | Analysis | Codebase exploration, documentation |

## Example: Spawning Agents for a Wave

```javascript
// 1. Initialize swarm (use "laptop" profile for MacBook)
mcp__claude-flow__swarm_init({
  topology: "hierarchical",
  maxAgents: 2,  // MacBook constraint
  queen_model: "sonnet",
  worker_model: "haiku"
})

// 2. Spawn specialist team (all in single message for parallel execution)
mcp__claude-flow__agent_spawn({ type: "architect" })
mcp__claude-flow__agent_spawn({ type: "coder" })
mcp__claude-flow__agent_spawn({ type: "tester" })
mcp__claude-flow__agent_spawn({ type: "reviewer" })

// 3. Execute and coordinate via task_orchestrate
mcp__claude-flow__task_orchestrate({
  task: "Implement SMI-XXX feature",
  strategy: "parallel"
})
```

## Hive Mind Orchestration

Configs in `.claude/hive-mind/`:

```bash
./start-hive-mind.sh                                              # Run config
npx claude-flow swarm --config .claude/hive-mind/your-config.yaml  # Direct
```

### Resource Profiles

| Profile | Max Agents | Use Case |
|---------|------------|----------|
| `laptop` | 2 | M1/M4 MacBook development |
| `workstation` | 4 | Desktop with more resources |
| `server` | 8+ | CI/CD or cloud execution |

### When to Version Configs

- **Version**: Reusable templates, team workflows, release processes
- **Gitignore**: One-time tasks, personal preferences, experiments

See [.claude/hive-mind/README.md](../../.claude/hive-mind/README.md) for full documentation.

## SPARC Development

### Core Commands

```bash
npx claude-flow sparc modes              # List available modes
npx claude-flow sparc tdd "<feature>"    # Run TDD workflow
npx claude-flow sparc run <mode> "<task>" # Execute specific mode
```

Available modes: orchestrator, coder, researcher, tdd, architect, reviewer, debugger, tester, analyzer, optimizer, documenter, designer, innovator, swarm-coordinator, memory-manager, batch-executor, workflow-manager.

### Concurrent Execution Rules

1. ALL operations MUST be concurrent/parallel in a single message
2. **NEVER save working files to the root folder**
3. Use Claude Code's Task tool for spawning agents concurrently
4. Batch ALL todos in ONE TodoWrite call

### MCP Server Setup

```bash
claude mcp add claude-flow npx claude-flow@alpha mcp start
```

See `.claude/agents/` for available agent definitions.

## Related Skills

- [Hive Mind Execution Skill](../../.claude/skills/hive-mind-execution/SKILL.md)
- [Hive Mind Advanced Skill](../../.claude/skills/hive-mind-advanced/SKILL.md)
