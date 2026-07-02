/**
 * Per-harness install step for `installAgentPack` (SMI-5456 Wave 1 Step 5).
 *
 * One function per concern (shim, hooks, MCP registration) so the
 * orchestrator (`agent-pack-installer.ts`) stays a readable top-level loop.
 * Every function is additive to `entries`/`report` in place — the caller
 * owns aggregation and the manifest save.
 *
 * @module @skillsmith/core/install/agent-pack-installer.harness
 */

import { join } from 'node:path'
import type { AgentPackArtifact, HarnessId } from '../services/agent-pack/index.js'
import {
  AGENT_HOOK_TARGETS,
  AGENT_MCP_TARGETS,
  AGENT_SHIM_TARGETS,
  type McpHarnessId,
} from './agent-harness-targets.js'
import { mergeJsonMcpEntry } from './agent-config-merge.json.js'
import { mergeYamlMcpEntry } from './agent-config-merge.yaml.js'
import { mergeTomlBlock } from './agent-config-merge.toml-block.js'
import { mergeJsonArrayEntry } from './agent-config-merge.json-array.js'
import {
  CODEX_AGENTS_FOREIGN_HEADER,
  CODEX_HOOKS_TABLE_CONFLICT_HEADER,
  CODEX_MCP_FOREIGN_HEADER,
  buildAgentMcpEntryValue,
  buildCodexMcpTomlBlock,
  buildCodexSessionStartHookBlock,
  buildOpenCodeMcpEntryValue,
} from './agent-pack-installer.entry.js'
import { relocateUnderHome } from './agent-home-relocate.js'
import { writeOwnedArtifactFile } from './agent-pack-installer.fs-helpers.js'
import type { AgentManifestEntry } from './agent-manifest.js'
import type { HarnessInstallReport } from './agent-pack-installer.types.js'
import type { MergeResult } from './agent-config-merge.types.js'

/**
 * A merge "succeeded" (our content is present in the file, whether this
 * call wrote it or it already matched) whenever status is 'created',
 * 'updated', OR 'unchanged'. Manifest entries must be pushed for ALL THREE —
 * not just 'created'/'updated' — because the manifest is rebuilt fresh every
 * `installAgentPack` run (`entries: []` at the top of the function): an
 * 'unchanged' result on a re-install is not a no-op from the manifest's
 * perspective, it is "this path is still part of what's installed." Gating
 * the push on 'created'/'updated' only would silently drop that path from
 * the manifest the moment a re-install found it already correct — the
 * P-5 double-install-idempotency test caught this losing 3 of 12 entries.
 * Only 'conflict' (we deliberately left a foreign entry untouched — nothing
 * of ours is there) and 'error' (the write failed) are excluded.
 */
function mergeSucceeded(status: MergeResult['status']): boolean {
  return status === 'created' || status === 'updated' || status === 'unchanged'
}

export interface HarnessInstallCtx {
  homeDir: string | undefined
  force: boolean
  backupDir: string
  entries: AgentManifestEntry[]
  /**
   * Config-file paths already backed up during THIS install run. Shared
   * across every merge call so a harness whose hooks + MCP registration
   * share one file (claude-code: `settings.json`; codex: `config.toml`)
   * only backs it up once, capturing genuine pre-install state rather than
   * repeatedly "backing up" content this same run already wrote.
   */
  backedUpPaths: Set<string>
}

/** Write the named-agent shim for `harness` when a target exists (claude-code/copilot/opencode). */
export function installShim(
  harness: HarnessId,
  artifact: AgentPackArtifact | undefined,
  ctx: HarnessInstallCtx,
  report: HarnessInstallReport
): void {
  const target = AGENT_SHIM_TARGETS[harness]
  if (!target || !artifact) return
  const path = relocateUnderHome(target.path, ctx.homeDir)
  const result = writeOwnedArtifactFile({
    path,
    content: artifact.content,
    executable: false,
    backupDir: ctx.backupDir,
  })
  report.shimWritten = true
  ctx.entries.push({
    path,
    kind: 'shim',
    harness,
    backupPath: result.backupPath,
    executable: false,
  })
  if (result.backupPath)
    report.notes.push(`shim: pre-existing content backed up to ${result.backupPath}`)
}

/** Install + wire SessionStart/SessionEnd hook scripts for claude-code/cursor (JSON hook config). */
export function installJsonHooks(
  harness: 'claude-code' | 'cursor',
  startArtifact: AgentPackArtifact | undefined,
  endArtifact: AgentPackArtifact | undefined,
  ctx: HarnessInstallCtx,
  report: HarnessInstallReport
): void {
  const target = AGENT_HOOK_TARGETS[harness]
  if (!target || !startArtifact || !endArtifact) return

  const scriptDir = relocateUnderHome(target.scriptDir, ctx.homeDir)
  const startPath = join(scriptDir, 'session-start.sh')
  const endPath = join(scriptDir, 'session-end.sh')
  const startResult = writeOwnedArtifactFile({
    path: startPath,
    content: startArtifact.content,
    executable: true,
    backupDir: ctx.backupDir,
  })
  const endResult = writeOwnedArtifactFile({
    path: endPath,
    content: endArtifact.content,
    executable: true,
    backupDir: ctx.backupDir,
  })
  ctx.entries.push(
    {
      path: startPath,
      kind: 'hook-script',
      harness,
      backupPath: startResult.backupPath,
      executable: true,
    },
    {
      path: endPath,
      kind: 'hook-script',
      harness,
      backupPath: endResult.backupPath,
      executable: true,
    }
  )
  report.hooksInstalled = true

  const configPath = relocateUnderHome(target.configPath, ctx.homeDir)
  const startWire = mergeJsonArrayEntry({
    path: configPath,
    keyPath: target.sessionStartKeyPath,
    entry: hookMatcherEntry(startPath),
    isOurEntry: (item) => hookEntryCommand(item) === startPath,
    backupDir: ctx.backupDir,
    alreadyBackedUpPaths: ctx.backedUpPaths,
  })
  const endWire = mergeJsonArrayEntry({
    path: configPath,
    keyPath: target.sessionEndKeyPath,
    entry: hookMatcherEntry(endPath),
    isOurEntry: (item) => hookEntryCommand(item) === endPath,
    backupDir: ctx.backupDir,
    alreadyBackedUpPaths: ctx.backedUpPaths,
  })
  report.hookConfig.push(startWire, endWire)
  if (mergeSucceeded(startWire.status) || mergeSucceeded(endWire.status)) {
    ctx.entries.push({
      path: configPath,
      kind: 'hook-config',
      harness,
      backupPath: startWire.backupPath ?? endWire.backupPath,
      executable: false,
    })
  }
}

/**
 * Install hook scripts for Codex (+x) and wire the SessionStart hook into
 * `~/.codex/config.toml` as a marker-delimited `[[hooks.SessionStart]]`
 * array-of-tables block (shape Step-6-verified against
 * developers.openai.com/codex/hooks).
 *
 * SessionStart ONLY — deliberate, do not "complete" this:
 *   - Codex has NO SessionEnd event. There is nothing to wire the
 *     session-end.sh cleanup script to.
 *   - Codex's Stop event fires PER-TURN, not per-session. Wiring the marker
 *     cleanup there would delete the agent-mediation marker file after the
 *     FIRST turn, silently unmarking every subsequent tool call in the same
 *     session and corrupting the mediation-share metric the whole Wave-1
 *     bet is measured by.
 *   - Cleanup therefore rides the server's 12h marker TTL
 *     (`telemetry/agent-marker.ts` `AGENT_MARKER_TTL_MS`) — the same
 *     crash-backstop path every harness already relies on.
 *
 * session-end.sh is still installed (inert on Codex — nothing invokes it):
 * it keeps the on-disk script tree identical across hook-capable harnesses
 * and stays manifest-tracked, so uninstall removes it like any other owned
 * file. Zero uninstall complication.
 */
export function installCodexHooks(
  startArtifact: AgentPackArtifact | undefined,
  endArtifact: AgentPackArtifact | undefined,
  ctx: HarnessInstallCtx,
  report: HarnessInstallReport
): void {
  const target = AGENT_HOOK_TARGETS.codex
  if (!target || !startArtifact || !endArtifact) return
  const scriptDir = relocateUnderHome(target.scriptDir, ctx.homeDir)
  const startPath = join(scriptDir, 'session-start.sh')
  const endPath = join(scriptDir, 'session-end.sh')
  const startResult = writeOwnedArtifactFile({
    path: startPath,
    content: startArtifact.content,
    executable: true,
    backupDir: ctx.backupDir,
  })
  const endResult = writeOwnedArtifactFile({
    path: endPath,
    content: endArtifact.content,
    executable: true,
    backupDir: ctx.backupDir,
  })
  ctx.entries.push(
    {
      path: startPath,
      kind: 'hook-script',
      harness: 'codex',
      backupPath: startResult.backupPath,
      executable: true,
    },
    {
      path: endPath,
      kind: 'hook-script',
      harness: 'codex',
      backupPath: endResult.backupPath,
      executable: true,
    }
  )
  report.hooksInstalled = true

  const configPath = relocateUnderHome(target.configPath, ctx.homeDir)
  const wire = mergeTomlBlock({
    path: configPath,
    markerId: 'hooks.SessionStart',
    blockContent: buildCodexSessionStartHookBlock(startPath),
    foreignHeaderPattern: CODEX_HOOKS_TABLE_CONFLICT_HEADER,
    backupDir: ctx.backupDir,
    force: ctx.force,
    alreadyBackedUpPaths: ctx.backedUpPaths,
  })
  report.hookConfig.push(wire)
  if (mergeSucceeded(wire.status)) {
    ctx.entries.push({
      path: configPath,
      kind: 'hook-config',
      harness: 'codex',
      backupPath: wire.backupPath,
      executable: false,
    })
  }
  if (wire.status === 'conflict') {
    report.notes.push(
      `Codex hook wiring skipped: ${configPath} defines [hooks.SessionStart] as a plain TOML table — appending our [[hooks.SessionStart]] array entry would make the file invalid TOML. Wire ${startPath} manually.`
    )
  }
  if (wire.status === 'error') {
    report.notes.push(`Codex hook wiring failed at ${configPath}: ${wire.errorMessage}`)
  }
  report.notes.push(
    'Codex: session-end.sh installed but not wired — Codex has no SessionEnd event and its Stop event fires per-turn (wiring cleanup there would break session-scoped mediation marking); marker cleanup rides the server-side 12h TTL.'
  )
}

function hookMatcherEntry(scriptPath: string): Record<string, unknown> {
  return { matcher: '', hooks: [{ type: 'command', command: scriptPath }] }
}

function hookEntryCommand(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined
  const hooks = (item as Record<string, unknown>).hooks
  if (!Array.isArray(hooks) || hooks.length === 0) return undefined
  const first = hooks[0]
  if (!first || typeof first !== 'object') return undefined
  const command = (first as Record<string, unknown>).command
  return typeof command === 'string' ? command : undefined
}

/**
 * Codex's named-agent "shim" is a `[agents.skillsmith-agent]` TOML entry
 * merged into the same `~/.codex/config.toml` as its MCP registration —
 * the artifact's content (`shims/codex/agents.toml`, rendered by the
 * locked `renderCodexToml`) is already the exact block text to install.
 */
export function installCodexAgentsShim(
  artifact: AgentPackArtifact | undefined,
  ctx: HarnessInstallCtx,
  report: HarnessInstallReport
): void {
  const target = AGENT_MCP_TARGETS.codex
  if (!artifact) return
  const path = relocateUnderHome(target.path, ctx.homeDir)
  const result = mergeTomlBlock({
    path,
    markerId: 'agents.skillsmith-agent',
    blockContent: artifact.content,
    foreignHeaderPattern: CODEX_AGENTS_FOREIGN_HEADER,
    backupDir: ctx.backupDir,
    force: ctx.force,
    alreadyBackedUpPaths: ctx.backedUpPaths,
  })
  if (mergeSucceeded(result.status)) {
    report.shimWritten = true
    ctx.entries.push({
      path,
      kind: 'shim',
      harness: 'codex',
      backupPath: result.backupPath,
      executable: false,
    })
  }
  if (result.status === 'conflict') {
    report.notes.push(
      `Codex agent entry at ${path} already has a hand-written [agents.skillsmith-agent] table — left untouched.`
    )
  }
  if (result.status === 'error') {
    report.notes.push(`Codex agent entry merge failed at ${path}: ${result.errorMessage}`)
  }
}

/** Merge the `skillsmith` MCP server registration for any of the 7 MCP-capable harnesses. */
export function installMcpConfig(
  harness: McpHarnessId,
  ctx: HarnessInstallCtx,
  report: HarnessInstallReport
): void {
  const target = AGENT_MCP_TARGETS[harness]
  const path = relocateUnderHome(target.path, ctx.homeDir)
  // OpenCode's entry schema is structurally different from the mcpServers
  // convention (typed local|remote, command-array, `environment`) — see
  // buildOpenCodeMcpEntryValue.
  const entryValue =
    harness === 'opencode' ? buildOpenCodeMcpEntryValue() : buildAgentMcpEntryValue()

  const result =
    target.format === 'json'
      ? mergeJsonMcpEntry({
          path,
          keyPath: target.keyPath,
          entryValue,
          backupDir: ctx.backupDir,
          force: ctx.force,
          alreadyBackedUpPaths: ctx.backedUpPaths,
        })
      : target.format === 'yaml'
        ? mergeYamlMcpEntry({
            path,
            mcpServersKey: target.keyPath[0] ?? 'mcp_servers',
            entryValue,
            backupDir: ctx.backupDir,
            force: ctx.force,
            alreadyBackedUpPaths: ctx.backedUpPaths,
          })
        : mergeTomlBlock({
            path,
            markerId: 'mcp_servers.skillsmith',
            blockContent: buildCodexMcpTomlBlock(),
            foreignHeaderPattern: CODEX_MCP_FOREIGN_HEADER,
            backupDir: ctx.backupDir,
            force: ctx.force,
            alreadyBackedUpPaths: ctx.backedUpPaths,
          })

  report.mcpConfig = result
  if (mergeSucceeded(result.status)) {
    ctx.entries.push({
      path,
      kind: 'mcp-config',
      harness,
      backupPath: result.backupPath,
      executable: false,
    })
  }
  if (result.status === 'conflict') {
    report.notes.push(
      `MCP config at ${path} already has a 'skillsmith' entry that doesn't look like ours — left untouched. Re-run with --force to overwrite, or edit ${path} manually.`
    )
  }
  if (result.status === 'error') {
    report.notes.push(`MCP config merge failed at ${path}: ${result.errorMessage}`)
  }
}
