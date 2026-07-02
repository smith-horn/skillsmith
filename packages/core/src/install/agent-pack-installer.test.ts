/**
 * @fileoverview Tests for `installAgentPack` (SMI-5456 Wave 1 Step 5).
 * @module @skillsmith/core/install/agent-pack-installer.test
 *
 * Covers the P-5 "Harness MCP config files" + "Dual-path pack copies"
 * invariants named in
 * docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md:
 *   - install to a temp HOME: dual-path byte-identical
 *   - shims only for detected harnesses
 *   - hooks +x (incl. Codex SessionStart TOML wiring, Step-6 corrected)
 *   - MCP config JSON/YAML/TOML merge results correct
 *   - double-install idempotency (no duplicate backups/manifest entries)
 *   - preserve-existing (non-interactive refusal path)
 * The uninstall exact-reversal + manifest-path-guard suites live in
 * `agent-pack-uninstaller.test.ts` (split at the 500-line gate).
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

  // Step-6 correction (2026-07-01): Codex hook wiring is now implemented —
  // the inline `[[hooks.SessionStart]]` array-of-tables shape was verified
  // against developers.openai.com/codex/hooks.
  it('wires the codex SessionStart hook as a marker-delimited [[hooks.SessionStart]] TOML block', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    const result = installAgentPack({ homeDir })
    const configPath = join(homeDir, '.codex', 'config.toml')
    const content = readFileSync(configPath, 'utf-8')
    const startScript = join(homeDir, '.codex', 'hooks', 'session-start.sh')

    expect(content).toContain('# >>> skillsmith:hooks.SessionStart >>>')
    expect(content).toContain('[[hooks.SessionStart]]')
    expect(content).toContain('[[hooks.SessionStart.hooks]]')
    expect(content).toContain('type = "command"')
    expect(content).toContain(JSON.stringify(startScript))

    const report = result.harnessReports.find((r) => r.harness === 'codex')
    expect(report?.hooksInstalled).toBe(true)
    expect(report?.hookConfig.some((w) => w.status === 'created')).toBe(true)
  })

  it('does NOT wire any codex SessionEnd/Stop cleanup (no SessionEnd event; Stop is per-turn)', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    const result = installAgentPack({ homeDir })
    const configPath = join(homeDir, '.codex', 'config.toml')
    const content = readFileSync(configPath, 'utf-8')

    expect(content).not.toContain('SessionEnd')
    expect(content).not.toContain('hooks.Stop')
    expect(content).not.toContain('session-end.sh')

    // session-end.sh is still INSTALLED (inert, manifest-tracked) so the
    // script tree stays uniform across hook-capable harnesses.
    const endScript = join(homeDir, '.codex', 'hooks', 'session-end.sh')
    expect(existsSync(endScript)).toBe(true)
    expect((statSync(endScript).mode & 0o111) !== 0).toBe(true)

    const report = result.harnessReports.find((r) => r.harness === 'codex')
    expect(report?.notes.some((n) => n.includes('no SessionEnd event'))).toBe(true)
  })

  it('refuses codex hook wiring (conflict) when the user defined [hooks.SessionStart] as a plain table', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    const configPath = join(homeDir, '.codex', 'config.toml')
    // Single-bracket TABLE — appending our [[...]] array entry would make
    // the file invalid TOML, so this must be a non-destructive refusal.
    const preExisting = '[hooks.SessionStart]\nsomething = "user-defined"\n'
    writeFileSync(configPath, preExisting)

    const result = installAgentPack({ homeDir })
    const content = readFileSync(configPath, 'utf-8')

    expect(content).toContain('something = "user-defined"')
    expect(content).not.toContain('# >>> skillsmith:hooks.SessionStart >>>')
    const report = result.harnessReports.find((r) => r.harness === 'codex')
    expect(report?.hookConfig.some((w) => w.status === 'conflict')).toBe(true)
    expect(report?.notes.some((n) => n.includes('plain TOML table'))).toBe(true)
  })

  it("appends alongside a user's own [[hooks.SessionStart]] array entry (valid TOML coexistence)", () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    const configPath = join(homeDir, '.codex', 'config.toml')
    const userHook = [
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "/usr/local/bin/my-own-hook.sh"',
      '',
    ].join('\n')
    writeFileSync(configPath, userHook)

    installAgentPack({ homeDir })
    const content = readFileSync(configPath, 'utf-8')

    // Both hooks present: the user's untouched, ours marker-delimited.
    expect(content).toContain('/usr/local/bin/my-own-hook.sh')
    expect(content).toContain('# >>> skillsmith:hooks.SessionStart >>>')
    expect(content.split('[[hooks.SessionStart]]').length - 1).toBe(2)
  })

  // Step-6 corrections (2026-07-01): opencode agent dir is `agents/`
  // (plural, opencode.ai/docs/agents/) and its MCP entry uses OpenCode's own
  // schema (type local|remote, command ARRAY, `environment` not `env`).
  it('writes the opencode shim to agents/ (plural) and an OpenCode-schema MCP entry when detected', () => {
    mkdirSync(join(homeDir, '.config', 'opencode', 'skills'), { recursive: true })
    const result = installAgentPack({ homeDir })

    const shimPath = join(homeDir, '.config', 'opencode', 'agents', 'skillsmith-agent.md')
    expect(existsSync(shimPath)).toBe(true)
    expect(existsSync(join(homeDir, '.config', 'opencode', 'agent', 'skillsmith-agent.md'))).toBe(
      false
    )

    const configPath = join(homeDir, '.config', 'opencode', 'opencode.json')
    const doc = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcp: {
        skillsmith: {
          type: string
          command: string[]
          environment: Record<string, string>
          env?: unknown
          args?: unknown
        }
      }
    }
    expect(doc.mcp.skillsmith.type).toBe('local')
    expect(Array.isArray(doc.mcp.skillsmith.command)).toBe(true)
    expect(doc.mcp.skillsmith.command).toContain('@skillsmith/mcp-server')
    expect(doc.mcp.skillsmith.environment.SKILLSMITH_TOOL_PROFILE).toBe('agent')
    expect(doc.mcp.skillsmith.env).toBeUndefined()
    expect(doc.mcp.skillsmith.args).toBeUndefined()

    const report = result.harnessReports.find((r) => r.harness === 'opencode')
    expect(report?.detected).toBe(true)
    expect(report?.shimWritten).toBe(true)
    expect(report?.mcpConfig?.status).toBe('created')
  })

  it('recognizes a prior-install OpenCode-schema entry as OURS and updates it without --force', () => {
    mkdirSync(join(homeDir, '.config', 'opencode', 'skills'), { recursive: true })
    const configPath = join(homeDir, '.config', 'opencode', 'opencode.json')
    // Simulates an entry a PREVIOUS sklx version wrote: same OpenCode schema,
    // same package, but stale field content. Without the command-array /
    // `environment` checks in looksLikeOurMcpEntry, this would be
    // misclassified as foreign and refuse to update.
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcp: {
            skillsmith: {
              type: 'local',
              command: ['npx', '-y', '@skillsmith/mcp-server@0.0.1'],
              environment: { SKILLSMITH_TOOL_PROFILE: 'agent', STALE_VAR: 'x' },
            },
          },
        },
        null,
        2
      )
    )

    const result = installAgentPack({ homeDir })
    const report = result.harnessReports.find((r) => r.harness === 'opencode')
    expect(report?.mcpConfig?.status).toBe('updated')

    const doc = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcp: { skillsmith: { command: string[]; environment: Record<string, string> } }
    }
    expect(doc.mcp.skillsmith.command).toContain('@skillsmith/mcp-server')
    expect(doc.mcp.skillsmith.environment.STALE_VAR).toBeUndefined()
  })

  it('writes the copilot MCP entry to mcp-config.json (Step-6 corrected filename)', () => {
    mkdirSync(join(homeDir, '.copilot', 'skills'), { recursive: true })
    const result = installAgentPack({ homeDir })

    const configPath = join(homeDir, '.copilot', 'mcp-config.json')
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(join(homeDir, '.copilot', 'mcp.json'))).toBe(false)
    const doc = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcpServers: { skillsmith: { env: Record<string, string> } }
    }
    expect(doc.mcpServers.skillsmith.env.SKILLSMITH_TOOL_PROFILE).toBe('agent')

    const report = result.harnessReports.find((r) => r.harness === 'copilot')
    expect(report?.mcpConfig?.status).toBe('created')
  })

  // Governance follow-up (2026-07-01): hermes is the ONLY detected harness
  // whose MCP config is YAML (`agent-config-merge.yaml.ts`) — before this
  // test, nothing in the installer suite ever created `~/.hermes`, so the
  // YAML merge path had zero coverage end-to-end through `installAgentPack`.
  it('merges the skillsmith MCP entry into hermes config.yaml (YAML format) when hermes is detected', () => {
    mkdirSync(join(homeDir, '.hermes', 'skills'), { recursive: true })
    const result = installAgentPack({ homeDir })
    const configPath = join(homeDir, '.hermes', 'config.yaml')
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('mcp_servers:')
    expect(content).toContain('skillsmith:')
    expect(content).toContain('SKILLSMITH_TOOL_PROFILE')
    const report = result.harnessReports.find((r) => r.harness === 'hermes')
    expect(report?.detected).toBe(true)
    expect(report?.skillPackWritten).toBe(true)
    expect(report?.mcpConfig?.status).toBe('created')
  })

  it('hermes YAML merge preserves pre-existing comments and unrelated keys', () => {
    mkdirSync(join(homeDir, '.hermes', 'skills'), { recursive: true })
    const configPath = join(homeDir, '.hermes', 'config.yaml')
    writeFileSync(
      configPath,
      ['# my hermes config', 'some_setting: true # inline note', ''].join('\n')
    )
    installAgentPack({ homeDir })
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('# my hermes config')
    expect(content).toContain('some_setting: true')
    expect(content).toContain('# inline note')
    expect(content).toContain('mcp_servers:')
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

  // Governance regression test (2026-07-01): the marker-delimited Codex TOML
  // block must be updated in place on re-install, never appended as a SECOND
  // block — a naive "no match found → append" fallback would duplicate the
  // `[mcp_servers.skillsmith]` / `[agents.skillsmith-agent]` tables on every
  // subsequent install.
  it('does not duplicate the codex TOML marker blocks on a second install', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    installAgentPack({ homeDir })
    installAgentPack({ homeDir })
    const configPath = join(homeDir, '.codex', 'config.toml')
    const content = readFileSync(configPath, 'utf-8')
    const countOccurrences = (needle: string): number => content.split(needle).length - 1
    expect(countOccurrences('# >>> skillsmith:mcp_servers.skillsmith >>>')).toBe(1)
    expect(countOccurrences('# >>> skillsmith:agents.skillsmith-agent >>>')).toBe(1)
    expect(countOccurrences('# >>> skillsmith:hooks.SessionStart >>>')).toBe(1)
    expect(countOccurrences('[mcp_servers.skillsmith]')).toBe(1)
    expect(countOccurrences('[[hooks.SessionStart]]')).toBe(1)
  })

  it('reports the codex hook wiring as "unchanged" on the second install', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true })
    installAgentPack({ homeDir })
    const second = installAgentPack({ homeDir })
    const report = second.harnessReports.find((r) => r.harness === 'codex')
    expect(report?.hookConfig.some((w) => w.status === 'unchanged')).toBe(true)
  })

  it('reports mcpConfig status "unchanged" on the second install', () => {
    installAgentPack({ homeDir })
    const second = installAgentPack({ homeDir })
    const report = second.harnessReports.find((r) => r.harness === 'claude-code')
    expect(report?.mcpConfig?.status).toBe('unchanged')
  })

  // Governance regression test (2026-07-01) for the commit-message-claimed
  // fix: "duplicate backups when hooks+MCP share a config file". Within a
  // SINGLE install run, claude-code's settings.json is merged into THREE
  // times (SessionStart hook, SessionEnd hook, MCP registration) — without
  // `alreadyBackedUpPaths` sharing across those calls, the second and third
  // merges would each independently "back up" content THIS SAME RUN already
  // wrote, producing 3 backup files for one genuine pre-install state instead
  // of 1, and (per `agent-manifest.ts`'s `dedupeEntriesByPath` last-non-null-
  // wins rule) the manifest would end up pointing `uninstall` at the WRONG,
  // polluted backup rather than the true pre-install content.
  it('writes exactly ONE backup file for settings.json even though 3 separate merges touch it in one run', () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    const settingsPath = join(homeDir, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ preExisting: true }, null, 2))

    installAgentPack({ homeDir })

    const backupsDir = getAgentInstallBackupsDir()
    const backupFiles = readdirSync(backupsDir).filter((f) => f.includes('settings.json'))
    expect(backupFiles).toHaveLength(1)
    const backupContent = JSON.parse(readFileSync(join(backupsDir, backupFiles[0]!), 'utf-8')) as {
      preExisting: boolean
      mcpServers?: unknown
      hooks?: unknown
    }
    // The ONE backup that exists must be the GENUINE pre-install content —
    // not an intermediate state polluted by an earlier merge THIS run.
    expect(backupContent).toEqual({ preExisting: true })
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
