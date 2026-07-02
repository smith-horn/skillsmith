/**
 * installAgentPack preserve-existing semantics (SMI-5456).
 *
 * Split from agent-pack-installer.test.ts at the 500-line gate; shares its
 * temp-HOME + manifest-env fixture shape. Covers the non-interactive conflict
 * refusal for a foreign pre-existing `skillsmith` MCP entry and the
 * `force: true` overwrite path (including the manifest-records-a-real-backup
 * invariant that uninstall replay depends on).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installAgentPack } from './agent-pack-installer.js'
import { AGENT_INSTALL_DIR_ENV_VAR, getAgentManifestPath } from './agent-manifest.js'

let homeDir: string
let manifestDir: string
let prevInstallDirEnv: string | undefined

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
