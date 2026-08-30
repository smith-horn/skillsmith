/**
 * @fileoverview ADR-139 (SMI-6274 Wave 4) point 5's Wave 5 bootstrap
 *   requirement — `installAgentPack({ scope: 'workspace' })` must be the
 *   ONLY thing that can bootstrap AntiGravity as a target (creating
 *   `.agents/skills` if it doesn't exist yet). Split from the sibling
 *   `agent-pack-installer.test.ts` (already at the 500-line gate) following
 *   this file family's existing `.cursor-hooks.test.ts`/`.cursor-mcp.test.ts`
 *   sibling convention.
 * @module @skillsmith/core/install/agent-pack-installer.workspace-scope.test
 * @see ADR-139 required test 15.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installAgentPack } from './agent-pack-installer.js'
import { AGENT_INSTALL_DIR_ENV_VAR } from './agent-manifest.js'

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
  it('bare `agent install` (no scope) never creates .agents/skills, and reports no antigravity row', () => {
    const result = installAgentPack({ homeDir, cwd: workspaceDir })

    expect(existsSync(join(workspaceDir, '.agents', 'skills'))).toBe(false)
    expect(result.harnessReports.find((r) => r.harness === 'antigravity')).toBeUndefined()
  })

  it('`--scope workspace` in a repository with no .agents/ creates it and registers antigravity as a target', () => {
    expect(existsSync(join(workspaceDir, '.agents'))).toBe(false)

    const result = installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const skillPackPath = join(workspaceDir, '.agents', 'skills', 'skillsmith-agent', 'SKILL.md')
    expect(existsSync(skillPackPath)).toBe(true)
    expect(readFileSync(skillPackPath, 'utf-8').length).toBeGreaterThan(0)

    const antigravityReport = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(antigravityReport).toBeDefined()
    expect(antigravityReport?.detected).toBe(true)
    expect(antigravityReport?.skillPackWritten).toBe(true)
    expect(antigravityReport?.notes.some((n) => n.includes('Created workspace'))).toBe(true)
  })

  it('`--scope workspace` when .agents/skills already exists writes into it without a "Created" note', () => {
    mkdirSync(join(workspaceDir, '.agents', 'skills'), { recursive: true })

    const result = installAgentPack({ homeDir, cwd: workspaceDir, scope: 'workspace' })

    const antigravityReport = result.harnessReports.find((r) => r.harness === 'antigravity')
    expect(antigravityReport?.skillPackWritten).toBe(true)
    expect(antigravityReport?.notes.some((n) => n.includes('Created workspace'))).toBe(false)
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
