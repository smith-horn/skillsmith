/**
 * @fileoverview ADR-139 (SMI-6274 Wave 4) point 5's Wave 5 bootstrap
 *   requirement — `installAgentPack({ scope: 'workspace' })` must be the
 *   ONLY thing that can CREATE `.agents/skills` when it doesn't exist yet.
 *   Split from the sibling `agent-pack-installer.test.ts` (already at the
 *   500-line gate) following this file family's existing
 *   `.cursor-hooks.test.ts`/`.cursor-mcp.test.ts` sibling convention.
 *
 *   SMI-6275 Wave 5 correction to this file's own original assertions: Wave
 *   4 omitted the `antigravity` report row entirely when no workspace scope
 *   resolved — this test file originally asserted exactly that omission.
 *   Wave 5's own required test ("no `.agents/` directory and no `--scope
 *   workspace` → clear message, no silent no-op — match whatever 'not
 *   detected' reporting shape other undetected harnesses already use")
 *   corrects that: AntiGravity now ALWAYS gets a row, `detected: false`
 *   with an explanatory note when its workspace scope doesn't resolve,
 *   matching every other harness's reporting shape. The first test below is
 *   updated accordingly. MCP-config-specific coverage (schema, idempotency,
 *   conflict/force, uninstall) lives in the sibling
 *   `agent-pack-installer.antigravity-mcp.test.ts`.
 * @module @skillsmith/core/install/agent-pack-installer.workspace-scope.test
 * @see ADR-139 required test 15.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installAgentPack } from './agent-pack-installer.js'
import { uninstallAgentPack } from './agent-pack-uninstaller.js'
import { AGENT_INSTALL_DIR_ENV_VAR } from './agent-manifest.js'
import { CLIENT_NATIVE_PATHS } from './paths.js'
import { relocateUnderHome } from './agent-home-relocate.js'

let homeDir: string
let workspaceDir: string
let manifestDir: string
let prevInstallDirEnv: string | undefined

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

describe('installAgentPack --scope workspace (ADR-139 point 5, required test 15)', () => {
  it('bare `agent install` (no scope, no existing .agents/) never creates .agents/skills, and reports antigravity as not detected — SMI-6275 Wave 5 correction: a row is now ALWAYS present, matching every other harness', () => {
    const result = installAgentPack({ homeDir, cwd: workspaceDir })

    expect(existsSync(join(workspaceDir, '.agents', 'skills'))).toBe(false)
    const antigravityReport = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(antigravityReport).toBeDefined()
    expect(antigravityReport?.detected).toBe(false)
    expect(antigravityReport?.skillPackWritten).toBe(false)
    expect(antigravityReport?.mcpConfig).toBeNull()
    // Clear message, not a silent no-op (SMI-6275 Wave 5 required test).
    expect(
      antigravityReport?.notes.some(
        (n) => n.includes('No .agents/') && n.includes('--scope workspace')
      )
    ).toBe(true)
  })

  it('bare `agent install` (no scope) AUTO-DETECTS an already-existing .agents/skills marker and configures AntiGravity — SMI-6275 Wave 5', () => {
    mkdirSync(join(workspaceDir, '.agents', 'skills'), { recursive: true })

    const result = installAgentPack({ homeDir, cwd: workspaceDir })

    const skillPackPath = join(workspaceDir, '.agents', 'skills', 'skillsmith-agent', 'SKILL.md')
    expect(existsSync(skillPackPath)).toBe(true)
    const mcpConfigPath = join(workspaceDir, '.agents', 'mcp_config.json')
    expect(existsSync(mcpConfigPath)).toBe(true)

    const antigravityReport = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(antigravityReport?.detected).toBe(true)
    expect(antigravityReport?.skillPackWritten).toBe(true)
    expect(antigravityReport?.mcpConfig?.status).toBe('created')
    // Auto-detect never creates — the marker already existed.
    expect(antigravityReport?.notes.some((n) => n.includes('Created workspace'))).toBe(false)
  })

  it('`--scope workspace` in a repository with no .agents/ creates it and registers antigravity as a target, writing both the skill pack and mcp_config.json', () => {
    expect(existsSync(join(workspaceDir, '.agents'))).toBe(false)

    const result = installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const skillPackPath = join(workspaceDir, '.agents', 'skills', 'skillsmith-agent', 'SKILL.md')
    expect(existsSync(skillPackPath)).toBe(true)
    expect(readFileSync(skillPackPath, 'utf-8').length).toBeGreaterThan(0)
    const mcpConfigPath = join(workspaceDir, '.agents', 'mcp_config.json')
    expect(existsSync(mcpConfigPath)).toBe(true)

    const antigravityReport = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(antigravityReport).toBeDefined()
    expect(antigravityReport?.detected).toBe(true)
    expect(antigravityReport?.skillPackWritten).toBe(true)
    expect(antigravityReport?.mcpConfig?.status).toBe('created')
    expect(antigravityReport?.notes.some((n) => n.includes('Created workspace'))).toBe(true)
  })

  it('`--scope workspace` when .agents/skills already exists writes into it without a "Created" note', () => {
    mkdirSync(join(workspaceDir, '.agents', 'skills'), { recursive: true })

    const result = installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const antigravityReport = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(antigravityReport?.skillPackWritten).toBe(true)
    expect(antigravityReport?.notes.some((n) => n.includes('Created workspace'))).toBe(false)
  })

  // GPT-5.6-Sol pr-reviewer finding (SMI-6275 Wave 5): resolveScopedSkillsDir()
  // throws UnsatisfiableWorkspaceScopeError when `--scope workspace` can't be
  // satisfied (no .agents/ marker AND no ancestor .git). Before the fix, that
  // throw propagated out of installAgentPack() entirely, skipping
  // saveAgentManifest() and losing every OTHER harness's already-written
  // entries — real files on disk with no manifest record, unreachable by
  // `agent uninstall`.
  it('`--scope workspace` outside any workspace (no .agents/, no ancestor .git) does not throw, reports antigravity as not detected with the resolver error, and still persists every other harness to the manifest', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-bare-'))
    try {
      let result: ReturnType<typeof installAgentPack> | undefined
      expect(() => {
        result = installAgentPack({ homeDir, cwd: bareDir, scope: 'workspace' })
      }).not.toThrow()

      const antigravityReport = result?.harnessReports.find((r) => r.harness === 'antigravity')
      expect(antigravityReport?.detected).toBe(false)
      expect(antigravityReport?.skillPackWritten).toBe(false)
      expect(
        antigravityReport?.notes.some((n) => n.includes('workspace scope could not be resolved'))
      ).toBe(true)

      // Proof the manifest actually recorded every other harness's writes
      // (not just that the files exist on disk, which would be true even
      // with the bug — the bug was the MANIFEST being skipped): a real
      // installer-written file from a harness untouched by this failure
      // must still exist...
      const claudeSkillPath = join(
        relocateUnderHome(CLIENT_NATIVE_PATHS['claude-code'], homeDir),
        'skillsmith-agent',
        'SKILL.md'
      )
      expect(existsSync(claudeSkillPath)).toBe(true)

      // ...and uninstallAgentPack (which replays ONLY the manifest, never
      // re-deriving "what the generator would currently produce") must be
      // able to find and remove it — impossible unless saveAgentManifest()
      // was actually reached despite the AntiGravity resolver's throw.
      const uninstallResult = uninstallAgentPack()
      expect(uninstallResult.removed).toContain(claudeSkillPath)
      expect(existsSync(claudeSkillPath)).toBe(false)
    } finally {
      rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it('every other harness report is unaffected by --scope workspace', () => {
    const withoutScope = installAgentPack({ homeDir, cwd: workspaceDir })
    rmSync(homeDir, { recursive: true, force: true })
    homeDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-home-'))
    const withScope = installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const nonAntigravity = (r: typeof withScope.harnessReports) =>
      r.filter((x) => x.harness !== 'antigravity').map((x) => x.harness)
    expect(nonAntigravity(withScope.harnessReports)).toEqual(
      nonAntigravity(withoutScope.harnessReports)
    )
  })
})
