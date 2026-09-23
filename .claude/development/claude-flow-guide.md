# Ruflo MCP Server Guide

Agent spawning, swarm orchestration, and SPARC development reference.

> **Note**: The package was renamed from `claude-flow` to `ruflo` in v3.5.x. The `.mcp.json` server key is `ruflo`, so every tool is exposed as `mcp__ruflo__<name>` (confirmed live, 2026-09-23, against the served `@claude-flow/cli@3.42.4`) — not the old `mcp__claude-flow__` prefix an earlier revision of this guide used.

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

The live registry serves **353 tools** total (measured 2026-09-23 via `tools/list` against the running `skillsmith-ruflo-1` service, `@claude-flow/cli@3.42.4`) — most of it is not granted. `CLAUDE.md`'s § Ruflo MCP Server names the small subset this repo actually uses; the rest needs an explicit ask, and a large share of the memory-mutating surface (`memory_import`, `memory_import_claude`, `memory_migrate`, `memory_search`, `memory_search_unified`, `memory_store`, and more) sits in `.claude/settings.json`'s `permissions.deny` by design (SMI-6744 A0.6: no corpus content enters ruflo's index before Wave 4's structural guarantee). `hooks_route`/`hooks_model-route` are also denied (SMI-5659) — never call them.

| Tool | Purpose | Required input | Notes |
|------|---------|-----------------|-------|
| `mcp__ruflo__swarm_init` | Initialize a swarm with persistent state tracking (topology, consensus) | none — `topology`, `maxAgents`, `strategy`, `config` all optional | `topology` enum includes hierarchical/mesh/hierarchical-mesh/ring/star/hybrid/adaptive/pheromone-adaptive |
| `mcp__ruflo__agent_spawn` | Spawn a Ruflo-tracked agent (cost attribution + memory persistence + swarm coordination) | `agentType` | `model` enum: `haiku`/`sonnet`/`opus`/`opus-4.7`/`inherit` |
| `mcp__ruflo__coordination_orchestrate` | Orchestrate multi-agent coordination (vote/sync/load-balance) | `task` | `strategy` enum: `parallel`/`sequential`/`pipeline`/`broadcast` |
| `mcp__ruflo__swarm_shutdown` | Shutdown a swarm and update persistent state | none — `swarmId`, `graceful` optional | |
| `mcp__ruflo__memory_retrieve` | Read back a value previously stored via `memory_store`, by exact (namespace, key) | `key` | `namespace` optional, default `"default"` |
| `mcp__ruflo__memory_list` | Enumerate stored memory entries without semantic search | none — `namespace`, `limit`, `offset` optional | |
| `mcp__ruflo__memory_delete` | Remove a stored memory entry by exact (namespace, key) | `key` | `namespace` optional, default `"default"` |
| `mcp__ruflo__memory_bridge_status` | Report memory bridge status — AgentDB vectors, SONA learning, intelligence patterns, connection health | none | |
| `mcp__ruflo__memory_store` | Persistent key-value store with vector embedding | `key`, `value` | **denied** in `.claude/settings.json`'s `permissions.deny` — present in the live registry (confirmed 2026-09-23) but not currently callable from this repo |

**Retired names, not live tools**: `task_orchestrate`, `memory_usage`, and `swarm_destroy` do **not** exist in the live registry (SMI-5777) — `coordination_orchestrate`, `memory_retrieve`/`memory_list`/`memory_delete`, and `swarm_shutdown` above are their respective replacements. Full list: `tools/list` (353 tools).

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
// 1. Initialize swarm
mcp__ruflo__swarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})

// 2. Spawn specialist team (all in a single message for parallel execution;
//    agentType is a free-form string — architect/coder/tester/reviewer/researcher
//    per this guide's own convention below, not an enum the schema enforces)
mcp__ruflo__agent_spawn({ agentType: "architect", model: "opus", task: "Design the API contract" })
mcp__ruflo__agent_spawn({ agentType: "coder", model: "sonnet", task: "Implement SMI-XXX feature" })
mcp__ruflo__agent_spawn({ agentType: "tester", model: "sonnet", task: "Write tests for SMI-XXX" })
mcp__ruflo__agent_spawn({ agentType: "reviewer", model: "opus", task: "Review the SMI-XXX diff" })

// 3. Coordinate via coordination_orchestrate (task_orchestrate does not exist, SMI-5777)
mcp__ruflo__coordination_orchestrate({
  task: "Implement SMI-XXX feature",
  strategy: "parallel"
})

// 4. Shut down when the wave is done
mcp__ruflo__swarm_shutdown({ graceful: true })
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
