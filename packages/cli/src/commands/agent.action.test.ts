/**
 * @fileoverview Tests for `skillsmith agent` subcommands.
 * @module @skillsmith/cli/commands/agent.action.test
 * @see SMI-5456 Wave 1 Step 5.
 *
 * Covers:
 *   install: renders a per-harness report (tier, detected, written flags, MCP status)
 *   install: passes --force through to installAgentPack
 *   install: errors surface via console.error + process.exit(1)
 *   uninstall: renders removed/restored/alreadyGone counts
 *   uninstall: errors surface via console.error + process.exit(1)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@skillsmith/core/telemetry', () => ({
  withTelemetry: <TArgs extends readonly unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn> | TReturn
  ) => fn,
}))

vi.mock('@skillsmith/core/install', () => ({
  installAgentPack: vi.fn(),
  uninstallAgentPack: vi.fn(),
}))

import { installAgentPack, uninstallAgentPack } from '@skillsmith/core/install'
import {
  runInstall,
  runUninstall,
  agentInstallActionImpl,
  agentUninstallActionImpl,
} from './agent.action.js'
import type { AgentInstallResult, AgentUninstallResult } from '@skillsmith/core/install'

const installAgentPackMock = vi.mocked(installAgentPack)
const uninstallAgentPackMock = vi.mocked(uninstallAgentPack)

function captureConsole() {
  const log: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args) => log.push(args.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...args) => err.push(args.join(' ')))
  return { log, err, all: () => [...log, ...err] }
}

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agent install — report rendering', () => {
  it('prints tier, detected badge, written flags, and MCP status per harness', async () => {
    const result: AgentInstallResult = {
      installedAt: '2026-07-01T00:00:00.000Z',
      manifestPath: '/mock/.skillsmith/agent-install/manifest.json',
      harnessReports: [
        {
          harness: 'claude-code',
          tier: 1,
          detected: true,
          skillPackWritten: true,
          shimWritten: true,
          hooksInstalled: true,
          mcpConfig: { status: 'created', path: '/mock/.claude/settings.json', backupPath: null },
          hookConfig: [],
          notes: [],
        },
        {
          harness: 'copilot',
          tier: 1,
          detected: false,
          skillPackWritten: false,
          shimWritten: false,
          hooksInstalled: false,
          mcpConfig: null,
          hookConfig: [],
          notes: [],
        },
      ],
    }
    installAgentPackMock.mockReturnValue(result)

    const cap = captureConsole()
    await runInstall()
    const output = cap.all().join('\n')

    expect(output).toContain('claude-code')
    expect(output).toContain('Tier 1')
    expect(output).toContain('detected')
    expect(output).toContain('written')
    expect(output).toContain('installed')
    expect(output).toContain('created')
    expect(output).toContain('copilot')
    expect(output).toContain('not detected')
    expect(output).toContain(result.manifestPath)
  })

  it('surfaces a conflict status and its note', async () => {
    const result: AgentInstallResult = {
      installedAt: '2026-07-01T00:00:00.000Z',
      manifestPath: '/mock/manifest.json',
      harnessReports: [
        {
          harness: 'claude-code',
          tier: 1,
          detected: true,
          skillPackWritten: true,
          shimWritten: true,
          hooksInstalled: true,
          mcpConfig: { status: 'conflict', path: '/mock/.claude/settings.json', backupPath: null },
          hookConfig: [],
          notes: ['MCP config already has a foreign entry — re-run with --force to overwrite it.'],
        },
      ],
    }
    installAgentPackMock.mockReturnValue(result)

    const cap = captureConsole()
    await runInstall()
    const output = cap.all().join('\n')

    expect(output).toContain('conflict')
    expect(output).toContain('re-run with --force')
  })

  it('passes force: true through to installAgentPack when --force is set', async () => {
    installAgentPackMock.mockReturnValue({
      installedAt: '2026-07-01T00:00:00.000Z',
      manifestPath: '/mock/manifest.json',
      harnessReports: [],
    })
    captureConsole()
    await runInstall({ force: true })
    expect(installAgentPackMock).toHaveBeenCalledWith({ force: true })
  })

  it('defaults force to false when omitted', async () => {
    installAgentPackMock.mockReturnValue({
      installedAt: '2026-07-01T00:00:00.000Z',
      manifestPath: '/mock/manifest.json',
      harnessReports: [],
    })
    captureConsole()
    await runInstall()
    expect(installAgentPackMock).toHaveBeenCalledWith({ force: false })
  })
})

describe('agent install — error handling', () => {
  it('maps a thrown error to console.error + process.exit(1)', async () => {
    installAgentPackMock.mockImplementation(() => {
      throw new Error('disk full')
    })
    const cap = captureConsole()
    const exit = mockExit()

    await expect(agentInstallActionImpl({})).rejects.toThrow('process.exit(1)')

    expect(exit).toHaveBeenCalledWith(1)
    expect(cap.err.join('\n')).toContain('disk full')
  })
})

describe('agent uninstall — report rendering', () => {
  it('prints removed/restored/alreadyGone counts', async () => {
    const result: AgentUninstallResult = {
      removed: ['/a', '/b'],
      restored: ['/c'],
      alreadyGone: [],
      rejected: [],
    }
    uninstallAgentPackMock.mockReturnValue(result)

    const cap = captureConsole()
    await runUninstall()
    const output = cap.all().join('\n')

    expect(output).toContain('removed:       2')
    expect(output).toContain('restored:      1')
  })

  it('notes already-gone entries as a no-op, not an error', async () => {
    uninstallAgentPackMock.mockReturnValue({
      removed: [],
      restored: [],
      alreadyGone: ['/a'],
      rejected: [],
    })
    const cap = captureConsole()
    await runUninstall()
    expect(cap.all().join('\n')).toContain('already gone:  1')
  })

  it('reports nothing-to-uninstall when the pack was never installed', async () => {
    uninstallAgentPackMock.mockReturnValue({
      removed: [],
      restored: [],
      alreadyGone: [],
      rejected: [],
    })
    const cap = captureConsole()
    await runUninstall()
    expect(cap.all().join('\n')).toContain('Nothing to uninstall')
  })

  it('surfaces rejected entries (manifest pointing outside known install targets) as a warning', async () => {
    uninstallAgentPackMock.mockReturnValue({
      removed: [],
      restored: [],
      alreadyGone: [],
      rejected: ['/etc/passwd'],
    })
    const cap = captureConsole()
    await runUninstall()
    const output = cap.all().join('\n')
    expect(output).toContain('rejected:      1')
    expect(output).not.toContain('Nothing to uninstall')
  })
})

describe('agent uninstall — error handling', () => {
  it('maps a thrown error to console.error + process.exit(1)', async () => {
    uninstallAgentPackMock.mockImplementation(() => {
      throw new Error('manifest corrupt')
    })
    const cap = captureConsole()
    const exit = mockExit()

    await expect(agentUninstallActionImpl()).rejects.toThrow('process.exit(1)')

    expect(exit).toHaveBeenCalledWith(1)
    expect(cap.err.join('\n')).toContain('manifest corrupt')
  })
})
