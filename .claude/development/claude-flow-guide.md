# Ruflo MCP Server Guide

Agent spawning, swarm orchestration, and SPARC development reference.

> **Note**: The package was renamed from `claude-flow` to `ruflo` in v3.5.x. MCP tool prefixes remain `mcp__claude-flow__` for backwards compatibility.

## Setup

Configured via `.mcp.json` (auto-loaded by Claude Code). The server runs as a long-lived Docker Compose service (`skillsmith-ruflo-1`, ADR-170), not an `npx`-spawned process — `scripts/mcp-ruflo-launcher.sh` authenticates the running container before it execs into it:

```json
{
  "mcpServers": {
    "ruflo": {
      "type": "stdio",
      "command": "./scripts/mcp-ruflo-launcher.sh"
    }
  }
}
```

Bring up the service (once per machine, from the main checkout): `./scripts/ruflo-service-up.sh`.

Verify: `claude mcp list | grep ruflo`

## Launcher

`scripts/mcp-ruflo-launcher.sh` runs five checks, in order, before it `exec`s into the running `skillsmith-ruflo-1` container ([ADR-170](../../docs/internal/adr/170-ruflo-mcp-server-tree-store-and-topology.md)):

0. `SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1` kill switch — checked first, before any docker call. No `npx` fallback by design.
1. Container liveness, then the container's ID is resolved once and used for every later docker call, so a container swapped in under the same name fails closed instead of silently being attached to.
2. Service command authentication: the running container's Entrypoint, Cmd, and WorkingDir must equal the § 1 / § 4 literals exactly.
3. `RUFLO_CLI_PIN` vs the served `@claude-flow/cli` version, read via a sentinel-tagged probe run inside the container.
4. Authority quad (§ 5): the `/srv/ruflo` mount's volume identity, instance-nonce label, and `store_generation` row must all match the machine-local authority file at `~/.skillsmith/ruflo-store.json`; an empty volume is refused by name, distinct from a generation mismatch.
5. Per-spawn guard (`scripts/ruflo-launch-guard.mjs`), piped into the container immediately before exec — writability probes plus the `state.lock`/`state.lock.launcher` staleness protocol.

**Guard exit codes** (each prints one `[ruflo] guard: ...` line naming the failing check — read the guard's own header for the current message text):

| Code | Meaning | Recovery |
|------|---------|----------|
| 0 | authorized | — |
| 1 | a writability probe failed | fix cwd/volume permissions (ADR-170 § 4) |
| 2 | entrypoint realpath mismatch | recreate the `ruflo` service |
| 3 | `state.lock.launcher` held by a live launcher | wait for it to finish |
| 4 | `state.lock.launcher` unresolved (malformed) | confirm no live server, then remove |
| 5 | real `state.lock` held by a live server | wait for it to finish |
| 6 | retired — an unresolved or malformed real `state.lock` now warns and proceeds, since the runtime applies its own 30 s staleness rule | — |
| 7 | internal error (a bug in the guard itself) | file a Linear issue |

For codes 3-6, first confirm no live server with `docker exec skillsmith-ruflo-1 ps -eo pid,etimes,args`, then remove only the named stale lock: `docker exec skillsmith-ruflo-1 rm -f /srv/ruflo/.claude-flow/policy/state.lock` for codes 5/6, or the sibling `docker exec skillsmith-ruflo-1 rm -f /srv/ruflo/.claude-flow/policy/state.lock.launcher` for codes 3/4.

Disable the launcher entirely (no `npx` fallback): `SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1`.

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
./start-hive-mind.sh                                                          # Run config
node node_modules/ruflo/bin/ruflo.js swarm --config .claude/hive-mind/your-config.yaml   # Direct
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

SPARC-mode CLI invocation (`npx ruflo sparc modes/tdd/run`) does **not** exist in the installed v3 CLI — `sparc` is not a recognized subcommand (`npx ruflo sparc --help` → `[ERROR] Unknown command: sparc / Did you mean: start, swarm, status`). For SPARC-style workflows use:

- This guide's [Hive Mind Orchestration](#hive-mind-orchestration) section above for `ruflo swarm` invocations
- The repo's own `sparc-methodology` skill (`.claude/skills/sparc-methodology/SKILL.md`) for the SPARC development methodology itself

### Concurrent Execution Rules

1. ALL operations MUST be concurrent/parallel in a single message
2. **NEVER save working files to the root folder**
3. Use Claude Code's Task tool for spawning agents concurrently
4. Batch ALL todos in ONE TodoWrite call

### MCP Server Setup

```bash
./scripts/ruflo-service-up.sh
```

See `.claude/agents/` for available agent definitions.

## Related Skills

- [Hive Mind Execution Skill](../../.claude/skills/hive-mind-execution/SKILL.md)
- [Hive Mind Advanced Skill](../../.claude/skills/hive-mind-advanced/SKILL.md)
