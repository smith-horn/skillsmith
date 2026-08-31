/**
 * AntiGravity `.agents/mcp_config.json` entry-shape + lifecycle coverage
 * (SMI-6275 Wave 5, GH#2166 ask 3).
 *
 * Split from the sibling `agent-pack-installer.workspace-scope.test.ts`
 * (which covers detection/scope-resolution behavior) and
 * `agent-pack-installer.test.ts`/`agent-manifest-path-guard.test.ts`,
 * mirroring this file family's existing `.cursor-mcp.test.ts` sibling
 * convention. Covers the four things Wave 5's own required test names:
 *   1. Entry shape — `@skillsmith/mcp-server` key, `npx` form,
 *      `SKILLSMITH_CLIENT=antigravity` + `SKILLSMITH_TOOL_PROFILE=agent`.
 *   2. Idempotency — re-install does not duplicate or corrupt the entry.
 *   3. Conflict/force — a foreign entry at the same key is preserved unless
 *      `--force` is passed.
 *   4. Uninstall — removes only Skillsmith-owned keys, restoring any
 *      hand-added sibling key untouched (also the regression test for the
 *      `agent-manifest-path-guard.ts` workspace-relative allowlist fix this
 *      wave adds — without it, `uninstallAgentPack` would silently REJECT
 *      every AntiGravity manifest entry as "outside known install targets").
 *
 * @module @skillsmith/core/install/agent-pack-installer.antigravity-mcp.test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installAgentPack } from './agent-pack-installer.js'
import { uninstallAgentPack } from './agent-pack-uninstaller.js'
import { AGENT_INSTALL_DIR_ENV_VAR } from './agent-manifest.js'

let homeDir: string
let workspaceDir: string
let manifestDir: string
let prevInstallDirEnv: string | undefined

interface AntigravityMcpDoc {
  mcpServers: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> } | undefined
  >
}

function mcpConfigPath(workspace: string): string {
  return join(workspace, '.agents', 'mcp_config.json')
}

function readAntigravityMcpJson(workspace: string): AntigravityMcpDoc {
  return JSON.parse(readFileSync(mcpConfigPath(workspace), 'utf-8')) as AntigravityMcpDoc
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-home-'))
  workspaceDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-workspace-'))
  mkdirSync(join(workspaceDir, '.git'), { recursive: true })
  manifestDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-manifest-'))
  prevInstallDirEnv = process.env[AGENT_INSTALL_DIR_ENV_VAR]
  process.env[AGENT_INSTALL_DIR_ENV_VAR] = manifestDir
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(workspaceDir, { recursive: true, force: true })
  rmSync(manifestDir, { recursive: true, force: true })
  if (prevInstallDirEnv !== undefined) process.env[AGENT_INSTALL_DIR_ENV_VAR] = prevInstallDirEnv
  else delete process.env[AGENT_INSTALL_DIR_ENV_VAR]
})

describe('installAgentPack — AntiGravity mcp_config.json entry shape (SMI-6275 Wave 5)', () => {
  it('writes the entry under the @skillsmith/mcp-server key with the npx form + SKILLSMITH_CLIENT=antigravity', () => {
    const result = installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const doc = readAntigravityMcpJson(workspaceDir)
    const entry = doc.mcpServers['@skillsmith/mcp-server']
    expect(entry?.command).toBe('npx')
    expect(entry?.args).toEqual(['-y', '@skillsmith/mcp-server'])
    expect(entry?.env?.SKILLSMITH_CLIENT).toBe('antigravity')
    expect(entry?.env?.SKILLSMITH_TOOL_PROFILE).toBe('agent')
    // No stray legacy 'skillsmith'-keyed entry — this is a first-ever
    // implementation, nothing to migrate away from.
    expect(doc.mcpServers.skillsmith).toBeUndefined()

    const report = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(report?.mcpConfig?.status).toBe('created')
  })

  it('does not regress claude-code’s own entry — still the npx form under the "skillsmith" key, no SKILLSMITH_CLIENT', () => {
    installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const claudeDoc = JSON.parse(
      readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf-8')
    ) as AntigravityMcpDoc
    expect(claudeDoc.mcpServers.skillsmith?.command).toBe('npx')
    expect(claudeDoc.mcpServers.skillsmith?.env?.SKILLSMITH_TOOL_PROFILE).toBe('agent')
    expect(claudeDoc.mcpServers.skillsmith?.env?.SKILLSMITH_CLIENT).toBeUndefined()
  })
})

describe('installAgentPack — AntiGravity mcp_config.json idempotency (SMI-6275 Wave 5)', () => {
  it('re-install does not create a duplicate second server entry', () => {
    installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })
    const second = installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const doc = readAntigravityMcpJson(workspaceDir)
    expect(Object.keys(doc.mcpServers)).toEqual(['@skillsmith/mcp-server'])

    const report = second.harnessReports.find((r) => r.harness === 'antigravity')
    expect(report?.mcpConfig?.status).toBe('unchanged')
  })

  it('a second install run leaves the file byte-identical', () => {
    installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })
    const afterFirst = readFileSync(mcpConfigPath(workspaceDir), 'utf-8')
    installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })
    const afterSecond = readFileSync(mcpConfigPath(workspaceDir), 'utf-8')

    expect(afterSecond).toBe(afterFirst)
  })
})

describe('installAgentPack — AntiGravity mcp_config.json conflict + --force (SMI-6275 Wave 5)', () => {
  it('leaves a foreign entry at the same key untouched, reporting a conflict', () => {
    mkdirSync(join(workspaceDir, '.agents'), { recursive: true })
    const foreignEntry = { command: 'some-other-tool', args: ['--flag'] }
    writeFileSync(
      mcpConfigPath(workspaceDir),
      JSON.stringify({ mcpServers: { '@skillsmith/mcp-server': foreignEntry } }, null, 2)
    )

    const result = installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const doc = readAntigravityMcpJson(workspaceDir)
    expect(doc.mcpServers['@skillsmith/mcp-server']).toEqual(foreignEntry)

    const report = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(report?.mcpConfig?.status).toBe('conflict')
    expect(report?.notes.some((n) => n.includes('--force'))).toBe(true)
  })

  it('--force overwrites a foreign entry at the same key', () => {
    mkdirSync(join(workspaceDir, '.agents'), { recursive: true })
    writeFileSync(
      mcpConfigPath(workspaceDir),
      JSON.stringify(
        { mcpServers: { '@skillsmith/mcp-server': { command: 'some-other-tool' } } },
        null,
        2
      )
    )

    const result = installAgentPack({
      homeDir,
      cwd: workspaceDir,
      scope: 'workspace',
      force: true,
    })

    const doc = readAntigravityMcpJson(workspaceDir)
    expect(doc.mcpServers['@skillsmith/mcp-server']?.command).toBe('npx')
    const report = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(report?.mcpConfig?.status).toBe('updated')
  })
})

describe('installAgentPack + uninstallAgentPack — AntiGravity workspace artifacts (SMI-6275 Wave 5)', () => {
  it('uninstall removes the freshly-created skill pack AND mcp_config.json entirely (no manifest-guard rejection)', () => {
    installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })
    const skillPackPath = join(workspaceDir, '.agents', 'skills', 'skillsmith-agent', 'SKILL.md')
    expect(existsSync(skillPackPath)).toBe(true)
    expect(existsSync(mcpConfigPath(workspaceDir))).toBe(true)

    const result = uninstallAgentPack({ homeDir })

    // The regression this test guards: without the agent-manifest-path-guard.ts
    // workspace-relative allowlist fix, both paths would land in `rejected`
    // (outside the guard's home-relative-only allowlist) and never actually
    // be deleted.
    expect(result.rejected).toEqual([])
    expect(result.removed).toContain(skillPackPath)
    expect(result.removed).toContain(mcpConfigPath(workspaceDir))
    expect(existsSync(skillPackPath)).toBe(false)
    expect(existsSync(mcpConfigPath(workspaceDir))).toBe(false)
  })

  it('uninstall restores a hand-added sibling key in mcp_config.json untouched, removing only our own key', () => {
    mkdirSync(join(workspaceDir, '.agents'), { recursive: true })
    const siblingDoc = { mcpServers: { 'my-other-tool': { command: 'foo', args: ['bar'] } } }
    writeFileSync(mcpConfigPath(workspaceDir), JSON.stringify(siblingDoc, null, 2))

    installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })
    const afterInstall = readAntigravityMcpJson(workspaceDir)
    expect(afterInstall.mcpServers['my-other-tool']).toEqual(siblingDoc.mcpServers['my-other-tool'])
    expect(afterInstall.mcpServers['@skillsmith/mcp-server']).toBeDefined()

    const result = uninstallAgentPack({ homeDir })
    expect(result.rejected).toEqual([])
    expect(result.restored).toContain(mcpConfigPath(workspaceDir))

    const afterUninstall = readAntigravityMcpJson(workspaceDir)
    expect(afterUninstall.mcpServers['my-other-tool']).toEqual(
      siblingDoc.mcpServers['my-other-tool']
    )
    expect(afterUninstall.mcpServers['@skillsmith/mcp-server']).toBeUndefined()
  })
})
