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

`scripts/mcp-ruflo-launcher.sh` runs six checks (0-5), in order, before it `exec`s into the running `skillsmith-ruflo-1` container ([ADR-170](../../docs/internal/adr/170-ruflo-mcp-server-tree-store-and-topology.md)):

0. `SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1` kill switch — checked first, before any docker call. No `npx` fallback by design.
1. Container liveness, then the container's ID is resolved once and used for every later docker call, so a container swapped in under the same name fails closed instead of silently being attached to.
2. Service command authentication: the running container's Entrypoint, Cmd, and WorkingDir must equal the § 1 / § 4 literals exactly.
3. `RUFLO_CLI_PIN` vs the served `@claude-flow/cli` version, read via a sentinel-tagged probe run inside the container.
4. Authority quad (§ 5): the `/srv/ruflo` mount's volume identity, instance-nonce label, and EACH of the two store files' `store_generation` row (`.swarm/memory.db` and `.swarm/agentdb-memory.db` -- the served `@claude-flow/cli` keeps both, and a swapped or copied copy of either one must be caught independently) must all match the machine-local authority file at `~/.skillsmith/ruflo-store.json`; an empty or partially-initialised volume is refused by name, distinct from a generation mismatch.
5. Per-spawn guard (`scripts/ruflo-launch-guard.mjs`), piped into the container immediately before exec — writability probes, then the runtime's `state.lock` decision taken under an OS-released mutex (SQLite `BEGIN IMMEDIATE` on `state.lock.launcher.db`, a kernel lock the holder's death releases) — the guard never deletes the runtime's lock; a stale one is waited out (the runtime clears it after 30 s), a live one refuses.

**Guard exit codes** (each prints one `[ruflo] guard: ...` line naming the failing check — read the guard's own header for the current message text):

| Code | Meaning | Recovery |
|------|---------|----------|
| 0 | authorized | — |
| 1 | a writability probe failed | fix cwd/volume permissions (ADR-170 § 4) |
| 2 | entrypoint realpath mismatch | recreate the `ruflo` service |
| 3 | the launcher mutex is held by another launcher past the 3 s busy timeout | retry — nothing to delete (a live holder releases on exit; a dead one already did); the message names the last recorded holder pid |
| 4 | the mutex database `state.lock.launcher.db` is unusable (not a database, a directory, unreadable) | remove ONLY that file — it holds no state — never `state.lock` or `state.json` |
| 5 | the runtime's `state.lock` is held by a live server (another session mid-transaction) | retry — nothing to delete; a stale lock is waited out by the guard itself |
| 6 | retired — a malformed real `state.lock` warns and proceeds; a stale one is waited out (the runtime clears a lock older than 30 s on its next acquire) | — |
| 7 | internal error, including a missing `better-sqlite3` in the image (an image defect, not a lock problem) | file a Linear issue |

Nothing under `/srv/ruflo/.claude-flow/policy/` is deleted by hand for codes 3, 5 or 6. For code 4 only: `docker exec skillsmith-ruflo-1 rm -f /srv/ruflo/.claude-flow/policy/state.lock.launcher.db` (the mutex database carries no state and is recreated on the next spawn). To see who holds what: `docker exec skillsmith-ruflo-1 ps -eo pid,etimes,args` is not available (the image has no `ps`); use the literal copy of `scripts/ruflo-launch-guard.mjs`'s own `PROC_SCAN_CMD_HINT` constant -- `docker exec skillsmith-ruflo-1 sh -c 'for p in /proc/[0-9]*; do printf "%s " "${p#/proc/}"; tr "\0" " " < "$p/cmdline"; echo; done'` -- which that file's own header now says this guide must be updated together with.

Disable the launcher entirely (no `npx` fallback): `SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1`.

## MCP Tools

The live registry serves **353 tools** total (measured 2026-09-23 via `tools/list` against the running `skillsmith-ruflo-1` service, `@claude-flow/cli@3.42.4`) — most of it is not granted. `CLAUDE.md`'s § Ruflo MCP Server names the small subset this repo actually uses; the rest needs an explicit ask, and a large share of the memory-mutating surface (`memory_import`, `memory_import_claude`, `memory_migrate`, `memory_search`, `memory_search_unified`, `memory_store`, and more) sits in `.claude/settings.json`'s `permissions.deny` by design (SMI-6744 A0.6: no corpus content enters ruflo's index before Wave 4's structural guarantee). `hooks_model-route` is also denied (SMI-5659: it writes `.swarm/model-router-state.json` on every call and is not sandboxed by worktree cwd) — never call it. Its sibling `hooks_route` is classified Allowed (`docs/internal/architecture/ruflo-tool-classification.md` § `hooks_*`) and is **not** in `permissions.deny`.

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

SPARC-mode CLI invocation (`ruflo sparc modes/tdd/run`) does **not** exist in the installed v3 CLI — `sparc` is not a recognized subcommand (`docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js sparc --help` → `[ERROR] Unknown command: sparc / Did you mean: start, swarm, status`). For SPARC-style workflows use:

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
