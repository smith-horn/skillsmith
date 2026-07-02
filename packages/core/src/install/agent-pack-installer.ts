/**
 * `sklx agent install` core orchestration (SMI-5456 Wave 1 Step 5).
 *
 * Generates the pack via `generateAgentPack({ toolProfile: AGENT_TOOL_PROFILE_NAMES })`
 * (QD-2: byte-identical to the committed `packages/mcp-server/src/assets/agent-pack/`
 * tree by determinism, never read from the mcp-server package) and writes:
 *   - SKILL.md to the mandatory dual path (claude-code + agents) plus any
 *     detected Tier-2/3 harness with its own native skill directory
 *     (opencode, hermes, windsurf).
 *   - Named-agent shims for every detected harness with a shim target
 *     (claude-code always; copilot, opencode when detected; codex via its
 *     own TOML-merge "shim").
 *   - SessionStart/SessionEnd hooks (+x) for claude-code (always), cursor
 *     and codex when detected — hook CONFIG wiring ships for claude-code/
 *     cursor (JSON); Codex hook wiring is deliberately NOT attempted (see
 *     `agent-pack-installer.harness.ts`).
 *   - The `skillsmith` MCP server registration (`SKILLSMITH_TOOL_PROFILE=agent`)
 *     for every detected MCP-capable harness (all 7), backup-first,
 *     idempotent, preserve-and-prompt on a foreign entry.
 *
 * Every write funnels through `writeOwnedArtifactFile` (owned files) or the
 * `agent-config-merge.*` helpers (shared config files), both of which record
 * a manifest entry — `uninstallAgentPack` (SMI-5456) reverses exactly what
 * this function wrote by replaying that manifest, never by re-deriving
 * "what the current generator would produce".
 *
 * @module @skillsmith/core/install/agent-pack-installer
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AGENT_PACK_SKILL_NAME, generateAgentPack } from '../services/agent-pack/index.js'
import { AGENT_TOOL_PROFILE_NAMES } from '../services/agent-tool-profile.js'
import { CLIENT_NATIVE_PATHS } from './paths.js'
import { relocateUnderHome } from './agent-home-relocate.js'
import { writeOwnedArtifactFile } from './agent-pack-installer.fs-helpers.js'
import {
  getAgentInstallBackupsDir,
  getAgentManifestPath,
  loadAgentManifest,
  saveAgentManifest,
  type AgentManifestEntry,
} from './agent-manifest.js'
import {
  installCodexAgentsShim,
  installCodexHookScriptsOnly,
  installJsonHooks,
  installMcpConfig,
  installShim,
  type HarnessInstallCtx,
} from './agent-pack-installer.harness.js'
import {
  HARNESS_SUPPORT_TIER,
  type AgentInstallOptions,
  type AgentInstallResult,
  type HarnessInstallReport,
} from './agent-pack-installer.types.js'

/** Harnesses considered for the SKILL.md pack copy beyond the mandatory dual path. */
const OPTIONAL_SKILL_PACK_HARNESSES = ['windsurf', 'opencode', 'hermes'] as const

function isPresent(nativePath: string, homeDir: string | undefined): boolean {
  return existsSync(relocateUnderHome(nativePath, homeDir))
}

function isCodexPresent(homeDir: string | undefined): boolean {
  return existsSync(relocateUnderHome(join(homedir(), '.codex'), homeDir))
}

/** Write the SKILL.md pack to one client's native skill directory (`<dir>/skillsmith-agent/SKILL.md`). */
function writeSkillPackFor(
  clientNativePath: string,
  content: string,
  ctx: HarnessInstallCtx,
  harness: string
): void {
  const path = join(
    relocateUnderHome(clientNativePath, ctx.homeDir),
    AGENT_PACK_SKILL_NAME,
    'SKILL.md'
  )
  const result = writeOwnedArtifactFile({
    path,
    content,
    executable: false,
    backupDir: ctx.backupDir,
  })
  ctx.entries.push({
    path,
    kind: 'skill',
    harness,
    backupPath: result.backupPath,
    executable: false,
  })
}

function newReport(harness: string): HarnessInstallReport {
  return {
    harness,
    tier: HARNESS_SUPPORT_TIER[harness] ?? 3,
    detected: false,
    skillPackWritten: false,
    shimWritten: false,
    hooksInstalled: false,
    mcpConfig: null,
    hookConfig: [],
    notes: [],
  }
}

/**
 * Detect + install the portable Skillsmith Agent pack across every
 * supported harness. See module header for the full per-harness matrix.
 */
export function installAgentPack(opts: AgentInstallOptions = {}): AgentInstallResult {
  const homeDir = opts.homeDir
  const force = opts.force ?? false
  // Manifest/backups dir isolation for tests is via SKILLSMITH_AGENT_INSTALL_DIR
  // (agent-manifest.ts), not `homeDir` — kept separate from harness-target
  // relocation so a test can isolate manifest state without needing a full
  // fake HOME tree.
  const backupDir = getAgentInstallBackupsDir()
  const entries: AgentManifestEntry[] = []
  const ctx: HarnessInstallCtx = {
    homeDir,
    force,
    backupDir,
    entries,
    backedUpPaths: new Set<string>(),
  }

  const artifacts = generateAgentPack({ toolProfile: AGENT_TOOL_PROFILE_NAMES })
  const skillArtifact = artifacts.find((a) => a.kind === 'skill')
  const shimByHarness = new Map(
    artifacts.filter((a) => a.kind === 'shim').map((a) => [a.harness, a])
  )
  const hookStartByHarness = new Map(
    artifacts
      .filter((a) => a.kind === 'hook' && a.path.endsWith('session-start.sh'))
      .map((a) => [a.harness, a])
  )
  const hookEndByHarness = new Map(
    artifacts
      .filter((a) => a.kind === 'hook' && a.path.endsWith('session-end.sh'))
      .map((a) => [a.harness, a])
  )

  const detected = {
    'claude-code': true, // canonical client — always on, mirrors CANONICAL_CLIENT in paths.ts
    cursor: isPresent(CLIENT_NATIVE_PATHS.cursor, homeDir),
    copilot: isPresent(CLIENT_NATIVE_PATHS.copilot, homeDir),
    windsurf: isPresent(CLIENT_NATIVE_PATHS.windsurf, homeDir),
    opencode: isPresent(CLIENT_NATIVE_PATHS.opencode, homeDir),
    hermes: isPresent(CLIENT_NATIVE_PATHS.hermes, homeDir),
    codex: isCodexPresent(homeDir),
  }

  const reports: HarnessInstallReport[] = []
  const harnessIds = [
    'claude-code',
    'cursor',
    'codex',
    'copilot',
    'opencode',
    'hermes',
    'windsurf',
  ] as const

  for (const harness of harnessIds) {
    const report = newReport(harness)
    report.detected = detected[harness]
    const active = report.detected

    // Skill pack: mandatory dual path regardless of "detected"; optional
    // harnesses only when detected.
    if (harness === 'claude-code' && skillArtifact) {
      writeSkillPackFor(CLIENT_NATIVE_PATHS['claude-code'], skillArtifact.content, ctx, harness)
      report.skillPackWritten = true
    }
    if (
      active &&
      (OPTIONAL_SKILL_PACK_HARNESSES as readonly string[]).includes(harness) &&
      skillArtifact
    ) {
      const nativePath = CLIENT_NATIVE_PATHS[harness as 'windsurf' | 'opencode' | 'hermes']
      writeSkillPackFor(nativePath, skillArtifact.content, ctx, harness)
      report.skillPackWritten = true
    }

    if (harness === 'claude-code' || active) {
      if (harness === 'claude-code' || harness === 'copilot' || harness === 'opencode') {
        installShim(harness, shimByHarness.get(harness), ctx, report)
      }
      if (harness === 'claude-code' || harness === 'cursor') {
        installJsonHooks(
          harness,
          hookStartByHarness.get(harness),
          hookEndByHarness.get(harness),
          ctx,
          report
        )
      }
      if (harness === 'codex') {
        installCodexHookScriptsOnly(
          hookStartByHarness.get('codex'),
          hookEndByHarness.get('codex'),
          ctx,
          report
        )
        installCodexAgentsShim(shimByHarness.get('codex'), ctx, report)
      }
      // `harnessIds` is exactly the 7-member McpHarnessId union (all harnesses
      // considered here support MCP registration) — safe direct cast.
      installMcpConfig(harness, ctx, report)
    }

    reports.push(report)
  }

  // Mandatory dual path for the second (agents) leg — reported alongside
  // claude-code's entry rather than as an 8th standalone harness row, since
  // ~/.agents/skills is a shared open-standard convention, not a harness of
  // its own (Codex's OWN report row covers its config/hook/shim surface).
  if (skillArtifact) {
    writeSkillPackFor(CLIENT_NATIVE_PATHS.agents, skillArtifact.content, ctx, 'agents')
  }

  saveAgentManifest({
    schemaVersion: 1,
    installedAt: new Date().toISOString(),
    packSchemaVersion: 1,
    entries,
  })

  return {
    installedAt: new Date().toISOString(),
    manifestPath: getAgentManifestPath(),
    harnessReports: reports,
  }
}

// Re-export so callers (CLI) don't need a second import for manifest inspection.
export { loadAgentManifest }
