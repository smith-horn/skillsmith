/**
 * @fileoverview Tests for `uninstallAgentPack` (SMI-5456 Wave 1 Step 5) —
 *               split from `agent-pack-installer.test.ts` when the combined
 *               file crossed the 500-line gate. Same temp-HOME + manifest-dir
 *               isolation setup; covers the P-5 exact-reversal invariant plus
 *               the governance manifest-path-guard security tests.
 * @module @skillsmith/core/install/agent-pack-uninstaller.test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installAgentPack } from './agent-pack-installer.js'
import { uninstallAgentPack } from './agent-pack-uninstaller.js'
import { AGENT_INSTALL_DIR_ENV_VAR, getAgentManifestPath } from './agent-manifest.js'
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
  homeDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-uninstall-home-'))
  manifestDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-uninstall-manifest-'))
  prevInstallDirEnv = process.env[AGENT_INSTALL_DIR_ENV_VAR]
  process.env[AGENT_INSTALL_DIR_ENV_VAR] = manifestDir
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(manifestDir, { recursive: true, force: true })
  if (prevInstallDirEnv !== undefined) process.env[AGENT_INSTALL_DIR_ENV_VAR] = prevInstallDirEnv
  else delete process.env[AGENT_INSTALL_DIR_ENV_VAR]
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
    // it pre-existed with unrelated content. Asserting the FULL document
    // (not just `mcpServers`) is the regression test for the "duplicate
    // backups when hooks+MCP share a config file" bug the commit message
    // claims fixed: a stray SECOND backup captured mid-install (after hooks
    // were merged in but before MCP was) would restore a `hooks` key that
    // never existed pre-install while still passing a narrower
    // `mcpServers`-only assertion.
    const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect(doc).toEqual({ someOtherKey: true })
    expect(doc.mcpServers).toBeUndefined()
    expect(doc.hooks).toBeUndefined()

    expect(result.restored).toContain(settingsPath)
    expect(result.removed.length).toBeGreaterThan(0)
  })

  // Governance regression test (2026-07-01): a hand-tampered or corrupted
  // manifest must never become an arbitrary-file-delete primitive. See
  // `agent-manifest-path-guard.ts`.
  it('refuses to delete or overwrite a manifest entry pointing outside any known installer target', () => {
    installAgentPack({ homeDir })

    // Simulate a tampered manifest: a "sensitive" file the installer never
    // wrote, with a fabricated entry pointing `uninstallAgentPack` at it.
    const sensitivePath = join(homeDir, 'not-an-installer-path.txt')
    writeFileSync(sensitivePath, 'do not touch me')

    const manifestPath = getAgentManifestPath()
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<{
        path: string
        kind: string
        harness: string | null
        backupPath: string | null
        executable: boolean
      }>
    }
    manifest.entries.push({
      path: sensitivePath,
      kind: 'skill',
      harness: null,
      backupPath: null,
      executable: false,
    })
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const result = uninstallAgentPack()

    // The sensitive file survives untouched...
    expect(existsSync(sensitivePath)).toBe(true)
    expect(readFileSync(sensitivePath, 'utf-8')).toBe('do not touch me')
    // ...and is reported as rejected, not silently dropped or counted as removed.
    expect(result.rejected).toContain(sensitivePath)
    expect(result.removed).not.toContain(sensitivePath)
  })

  it('refuses to restore from a backupPath outside the manifest backups directory', () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ realCurrentContent: true }))

    // A forged "backup" living OUTSIDE the trusted backups directory, whose
    // content an attacker fully controls.
    const forgedBackupPath = join(homeDir, 'forged-backup.json')
    writeFileSync(forgedBackupPath, JSON.stringify({ attackerControlled: true }))

    const manifestPath = getAgentManifestPath()
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          installedAt: new Date().toISOString(),
          packSchemaVersion: 1,
          entries: [
            {
              path: settingsPath,
              kind: 'mcp-config',
              harness: 'claude-code',
              backupPath: forgedBackupPath,
              executable: false,
            },
          ],
        },
        null,
        2
      )
    )

    const result = uninstallAgentPack()

    // settingsPath must NOT be overwritten with the forged backup's content.
    const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect(doc).toEqual({ realCurrentContent: true })
    expect(result.rejected).toContain(settingsPath)
    expect(result.restored).not.toContain(settingsPath)
  })

  it('restores a pre-existing codex config.toml to its exact pre-install content (hook wiring included)', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    const configPath = join(homeDir, '.codex', 'config.toml')
    const preInstall = '# my codex config\nmodel = "gpt-x"\n'
    writeFileSync(configPath, preInstall)

    installAgentPack({ homeDir })
    // Sanity: install actually added all three of our blocks.
    const installed = readFileSync(configPath, 'utf-8')
    expect(installed).toContain('# >>> skillsmith:hooks.SessionStart >>>')
    expect(installed).toContain('# >>> skillsmith:mcp_servers.skillsmith >>>')

    const result = uninstallAgentPack()

    // Exact pre-install content back — no residual marker blocks.
    expect(readFileSync(configPath, 'utf-8')).toBe(preInstall)
    expect(result.restored).toContain(configPath)
    // Hook scripts (including the inert session-end.sh) are gone.
    expect(existsSync(join(homeDir, '.codex', 'hooks', 'session-start.sh'))).toBe(false)
    expect(existsSync(join(homeDir, '.codex', 'hooks', 'session-end.sh'))).toBe(false)
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

// SMI-5456 adversarial-review regression: a RE-install (no intervening
// uninstall) takes no fresh backup for already-installed paths, so the fresh
// manifest recorded `backupPath: null` for the shared config files — silently
// dropping install #1's genuine pre-install backup reference. uninstall then
// treated the modified pre-existing file as "created fresh" and DELETED it.
// `carryForwardPriorBackups` in `agent-pack-installer.ts` fixes this; these
// tests lock it in. See that helper's doc comment.
describe('uninstallAgentPack — double-install reversal (pre-install backup not stranded)', () => {
  it('restores a pre-existing claude-code settings.json after install → install → uninstall', () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ someOtherKey: true }, null, 2))

    installAgentPack({ homeDir })
    installAgentPack({ homeDir }) // re-install (byte-identical pack, no fresh backup taken)

    const result = uninstallAgentPack()

    // The user's pre-install settings.json must survive — restored to its
    // exact pre-install content, NOT deleted.
    expect(existsSync(settingsPath)).toBe(true)
    const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect(doc).toEqual({ someOtherKey: true })
    expect(result.restored).toContain(settingsPath)
    expect(result.removed).not.toContain(settingsPath)
  })

  it('restores a pre-existing codex config.toml after install → install → uninstall', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    const configPath = join(homeDir, '.codex', 'config.toml')
    const preInstall = '# my codex config\nmodel = "gpt-x"\n'
    writeFileSync(configPath, preInstall)

    installAgentPack({ homeDir })
    installAgentPack({ homeDir })

    const result = uninstallAgentPack()

    expect(existsSync(configPath)).toBe(true)
    expect(readFileSync(configPath, 'utf-8')).toBe(preInstall)
    expect(result.restored).toContain(configPath)
  })

  it('still DELETES a config file the installer created fresh, even after a re-install', () => {
    // No pre-existing settings.json: install created it. A re-install must not
    // spuriously invent a backup — uninstall still deletes it.
    installAgentPack({ homeDir })
    installAgentPack({ homeDir })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)

    uninstallAgentPack()
    expect(existsSync(settingsPath)).toBe(false)
  })
})
