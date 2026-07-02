/**
 * @fileoverview Tests for `installAgentPack` / `uninstallAgentPack`
 *               (SMI-5456 Wave 1 Step 5).
 * @module @skillsmith/core/install/agent-pack-installer.test
 *
 * Covers the P-5 "Harness MCP config files" + "Dual-path pack copies"
 * invariants named in
 * docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md:
 *   - install to a temp HOME: dual-path byte-identical
 *   - shims only for detected harnesses
 *   - hooks +x
 *   - MCP config JSON-merge result correct
 *   - double-install idempotency (no duplicate backups/manifest entries)
 *   - preserve-existing (non-interactive refusal path)
 *   - uninstall exact-reversal
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installAgentPack } from './agent-pack-installer.js'
import { uninstallAgentPack } from './agent-pack-uninstaller.js'
import {
  AGENT_INSTALL_DIR_ENV_VAR,
  getAgentInstallBackupsDir,
  getAgentManifestPath,
} from './agent-manifest.js'
import { CLIENT_NATIVE_PATHS } from './paths.js'
import { relocateUnderHome } from './agent-home-relocate.js'

let homeDir: string
let manifestDir: string
let prevInstallDirEnv: string | undefined

function skillPath(client: keyof typeof CLIENT_NATIVE_PATHS): string {
  return join(
    relocateUnderHome(CLIENT_NATIVE_PATHS[client], homeDir),
    'skillsmith-agent',
    'SKILL.md'
  )
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-home-'))
  manifestDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-manifest-'))
  prevInstallDirEnv = process.env[AGENT_INSTALL_DIR_ENV_VAR]
  process.env[AGENT_INSTALL_DIR_ENV_VAR] = manifestDir
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(manifestDir, { recursive: true, force: true })
  if (prevInstallDirEnv !== undefined) process.env[AGENT_INSTALL_DIR_ENV_VAR] = prevInstallDirEnv
  else delete process.env[AGENT_INSTALL_DIR_ENV_VAR]
})

describe('installAgentPack — dual-path + shim + hook + MCP', () => {
  it('writes byte-identical SKILL.md to both claude-code and agents skill paths', () => {
    installAgentPack({ homeDir })
    const claudePath = skillPath('claude-code')
    const agentsPath = skillPath('agents')
    expect(existsSync(claudePath)).toBe(true)
    expect(existsSync(agentsPath)).toBe(true)
    expect(readFileSync(claudePath, 'utf-8')).toBe(readFileSync(agentsPath, 'utf-8'))
  })

  it('writes the claude-code shim unconditionally; copilot/opencode shims only when detected', () => {
    const result = installAgentPack({ homeDir })
    const claudeShim = join(homeDir, '.claude', 'agents', 'skillsmith-agent.md')
    const copilotShim = join(homeDir, '.copilot', 'agents', 'skillsmith-agent.agent.md')
    expect(existsSync(claudeShim)).toBe(true)
    expect(existsSync(copilotShim)).toBe(false)

    const claudeReport = result.harnessReports.find((r) => r.harness === 'claude-code')
    const copilotReport = result.harnessReports.find((r) => r.harness === 'copilot')
    expect(claudeReport?.shimWritten).toBe(true)
    expect(copilotReport?.detected).toBe(false)
    expect(copilotReport?.shimWritten).toBe(false)
  })

  it('detects copilot and writes its shim + skill pack when ~/.copilot/skills is present', () => {
    mkdirSync(join(homeDir, '.copilot', 'skills'), { recursive: true })
    const result = installAgentPack({ homeDir })
    const copilotShim = join(homeDir, '.copilot', 'agents', 'skillsmith-agent.agent.md')
    expect(existsSync(copilotShim)).toBe(true)
    const copilotReport = result.harnessReports.find((r) => r.harness === 'copilot')
    expect(copilotReport?.detected).toBe(true)
    expect(copilotReport?.shimWritten).toBe(true)
  })

  it('installs claude-code + cursor hook scripts with the executable bit set', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    installAgentPack({ homeDir })
    for (const dir of ['.claude', '.cursor']) {
      const startPath = join(homeDir, dir, 'hooks', 'session-start.sh')
      const endPath = join(homeDir, dir, 'hooks', 'session-end.sh')
      expect(existsSync(startPath)).toBe(true)
      expect((statSync(startPath).mode & 0o111) !== 0).toBe(true)
      expect((statSync(endPath).mode & 0o111) !== 0).toBe(true)
    }
  })

  it('does not install cursor hooks when cursor is not detected', () => {
    installAgentPack({ homeDir })
    expect(existsSync(join(homeDir, '.cursor', 'hooks', 'session-start.sh'))).toBe(false)
  })

  it('merges the skillsmith MCP entry into claude-code settings.json with SKILLSMITH_TOOL_PROFILE=agent', () => {
    const result = installAgentPack({ homeDir })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      mcpServers: { skillsmith: { env: Record<string, string> } }
    }
    expect(doc.mcpServers.skillsmith.env.SKILLSMITH_TOOL_PROFILE).toBe('agent')
    const report = result.harnessReports.find((r) => r.harness === 'claude-code')
    expect(report?.mcpConfig?.status).toBe('created')
  })

  it('merges the codex MCP + agents entries as marker-delimited TOML blocks when codex is detected', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    const result = installAgentPack({ homeDir })
    const configPath = join(homeDir, '.codex', 'config.toml')
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('# >>> skillsmith:mcp_servers.skillsmith >>>')
    expect(content).toContain('# >>> skillsmith:agents.skillsmith-agent >>>')
    const report = result.harnessReports.find((r) => r.harness === 'codex')
    expect(report?.detected).toBe(true)
    expect(report?.shimWritten).toBe(true)
    expect(report?.mcpConfig?.status).toBe('created')
  })
})

describe('installAgentPack — double-install idempotency', () => {
  it('produces identical manifest entry count and zero additional backups on a second install', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    mkdirSync(join(homeDir, '.codex'), { recursive: true })

    installAgentPack({ homeDir })
    const manifestAfterFirst = JSON.parse(readFileSync(getAgentManifestPath(), 'utf-8')) as {
      entries: unknown[]
    }
    const backupsDir = getAgentInstallBackupsDir()
    const backupCountAfterFirst = existsSync(backupsDir) ? readdirSync(backupsDir).length : 0

    installAgentPack({ homeDir })
    const manifestAfterSecond = JSON.parse(readFileSync(getAgentManifestPath(), 'utf-8')) as {
      entries: unknown[]
    }
    const backupCountAfterSecond = existsSync(backupsDir) ? readdirSync(backupsDir).length : 0

    expect(manifestAfterSecond.entries.length).toBe(manifestAfterFirst.entries.length)
    expect(backupCountAfterSecond).toBe(backupCountAfterFirst)
  })

  it('reports mcpConfig status "unchanged" on the second install', () => {
    installAgentPack({ homeDir })
    const second = installAgentPack({ homeDir })
    const report = second.harnessReports.find((r) => r.harness === 'claude-code')
    expect(report?.mcpConfig?.status).toBe('unchanged')
  })
})

describe('installAgentPack — preserve-existing (non-interactive refusal)', () => {
  it('does not clobber a foreign pre-existing skillsmith MCP entry, and reports a conflict', () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    const foreign = {
      mcpServers: {
        skillsmith: { command: 'node', args: ['/some/other/local/path/index.js'] },
      },
    }
    writeFileSync(settingsPath, JSON.stringify(foreign, null, 2))

    const result = installAgentPack({ homeDir })
    const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as typeof foreign
    expect(doc.mcpServers.skillsmith).toEqual(foreign.mcpServers.skillsmith)

    const report = result.harnessReports.find((r) => r.harness === 'claude-code')
    expect(report?.mcpConfig?.status).toBe('conflict')
    expect(report?.notes.some((n) => n.includes('--force'))).toBe(true)
  })

  it('force: true overwrites the foreign entry and the manifest records a real backup for the file', () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    const foreign = { mcpServers: { skillsmith: { command: 'node', args: ['/other'] } } }
    writeFileSync(settingsPath, JSON.stringify(foreign, null, 2))

    const result = installAgentPack({ homeDir, force: true })
    const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      mcpServers: { skillsmith: { env: Record<string, string> } }
    }
    expect(doc.mcpServers.skillsmith.env.SKILLSMITH_TOOL_PROFILE).toBe('agent')
    const report = result.harnessReports.find((r) => r.harness === 'claude-code')
    expect(report?.mcpConfig?.status).toBe('updated')

    // The MCP merge's OWN `mcpConfig.backupPath` can legitimately be null
    // here: claude-code's hook-config merge runs FIRST this install run and
    // is the one that takes the single real backup of settings.json
    // (`alreadyBackedUpPaths` — one backup per file per run, see
    // agent-config-merge.types.ts). What matters for correctness is that the
    // MANIFEST — which uninstall actually replays — records a real backup
    // for settingsPath, regardless of which merge call happened to claim it.
    const manifest = JSON.parse(readFileSync(getAgentManifestPath(), 'utf-8')) as {
      entries: Array<{ path: string; backupPath: string | null }>
    }
    const settingsEntry = manifest.entries.find((e) => e.path === settingsPath)
    expect(settingsEntry?.backupPath).not.toBeNull()
  })
})

describe('uninstallAgentPack — exact reversal', () => {
  it('removes everything install wrote and restores foreign entries it modified (not conflicted)', () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ someOtherKey: true }, null, 2))

    installAgentPack({ homeDir })
    expect(existsSync(skillPath('claude-code'))).toBe(true)
    expect(existsSync(skillPath('agents'))).toBe(true)
    expect(existsSync(join(homeDir, '.claude', 'agents', 'skillsmith-agent.md'))).toBe(true)

    const result = uninstallAgentPack()

    expect(existsSync(skillPath('claude-code'))).toBe(false)
    expect(existsSync(skillPath('agents'))).toBe(false)
    expect(existsSync(join(homeDir, '.claude', 'agents', 'skillsmith-agent.md'))).toBe(false)

    // settings.json is restored to its pre-install content (someOtherKey
    // survives, skillsmith/hooks keys are gone) rather than deleted, since
    // it pre-existed with unrelated content.
    const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect(doc.someOtherKey).toBe(true)
    expect(doc.mcpServers).toBeUndefined()

    expect(result.restored).toContain(settingsPath)
    expect(result.removed.length).toBeGreaterThan(0)
  })

  it('deletes a config file entirely when install created it fresh (no backup)', () => {
    installAgentPack({ homeDir })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)

    uninstallAgentPack()
    // settings.json was created fresh by install (no pre-existing content) —
    // it is a "removed" (deleted) entry, not "restored".
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('is a no-op (not an error) for a manifest entry the user already deleted manually', () => {
    installAgentPack({ homeDir })
    rmSync(skillPath('claude-code'))
    const result = uninstallAgentPack()
    expect(result.alreadyGone).toContain(skillPath('claude-code'))
  })

  it('leaves foreign entries in OTHER, never-touched files untouched', () => {
    mkdirSync(join(homeDir, '.gitconfig-like-dir'), { recursive: true })
    const untouchedPath = join(homeDir, '.gitconfig-like-dir', 'config')
    writeFileSync(untouchedPath, 'unrelated content\n')

    installAgentPack({ homeDir })
    uninstallAgentPack()

    expect(readFileSync(untouchedPath, 'utf-8')).toBe('unrelated content\n')
  })
})
