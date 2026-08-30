/**
 * Cursor `mcp.json` entry-shape + key-alignment regression coverage
 * (SMI-6279 Wave 9, GH#2368 V3).
 *
 * Split from agent-pack-installer.test.ts, mirroring the existing
 * agent-pack-installer.cursor-hooks.test.ts split (same temp-HOME +
 * manifest-env fixture shape). Covers the two independent things
 * `agent-pack-installer.cursor-mcp.ts` fixes:
 *   1. Entry SHAPE: a resolved `skillsmith-mcp` binary path (or the
 *      documented paste-here placeholder when resolution fails) instead of
 *      the `npx`/`args` form two live UAT passes proved ENOENTs inside
 *      Cursor's bundled Node, plus `SKILLSMITH_CLIENT=cursor`.
 *   2. Entry KEY: `@skillsmith/mcp-server` (matching the website/CLI docs
 *      snippet) instead of `skillsmith`, with a legacy-key cleanup step for
 *      a pre-fix install that still has the old key.
 *
 * `node:child_process`'s `execFileSync` is mocked so `resolveSkillsmithMcpBinPath`
 * never depends on whether `skillsmith-mcp` happens to be on the test
 * runner's real PATH.
 *
 * @module @skillsmith/core/install/agent-pack-installer.cursor-mcp.test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: execFileSyncMock }
})

// Defaults to the real writeFileSync so every test in this file gets real
// disk writes unmodified; only the one PR-07-regression test below swaps in
// a conditional throw, keyed by path so it can't accidentally intercept the
// unrelated skill-pack-file writes installAgentPack also performs in the
// same run (confirmed necessary: a naive call-order-based override fired on
// one of those instead, on the first pass at writing this test).
const { writeFileSyncMock, realWriteFileSyncRef } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
  realWriteFileSyncRef: { current: null as null | ((...args: unknown[]) => void) },
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  realWriteFileSyncRef.current = actual.writeFileSync as unknown as (...args: unknown[]) => void
  writeFileSyncMock.mockImplementation(actual.writeFileSync)
  return { ...actual, writeFileSync: writeFileSyncMock }
})

import { installAgentPack } from './agent-pack-installer.js'
import { AGENT_INSTALL_DIR_ENV_VAR } from './agent-manifest.js'

let homeDir: string
let manifestDir: string
let prevInstallDirEnv: string | undefined

const RESOLVED_BIN_PATH = '/usr/local/bin/skillsmith-mcp'

function mcpJsonPath(home: string): string {
  return join(home, '.cursor', 'mcp.json')
}

interface CursorMcpDoc {
  mcpServers: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> } | undefined
  >
}

function readCursorMcpJson(home: string): CursorMcpDoc {
  return JSON.parse(readFileSync(mcpJsonPath(home), 'utf-8')) as CursorMcpDoc
}

function seedCursorPresent(): void {
  mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-home-'))
  manifestDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-manifest-'))
  prevInstallDirEnv = process.env[AGENT_INSTALL_DIR_ENV_VAR]
  process.env[AGENT_INSTALL_DIR_ENV_VAR] = manifestDir
  execFileSyncMock.mockReset()
  // Reset to the real passthrough (see the vi.mock('node:fs', ...) setup
  // above) in case a prior test overrode it to simulate a write failure.
  writeFileSyncMock.mockClear()
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(manifestDir, { recursive: true, force: true })
  if (prevInstallDirEnv !== undefined) process.env[AGENT_INSTALL_DIR_ENV_VAR] = prevInstallDirEnv
  else delete process.env[AGENT_INSTALL_DIR_ENV_VAR]
  vi.restoreAllMocks()
})

describe('installAgentPack — cursor mcp.json entry shape (SMI-6279 Wave 9)', () => {
  it('writes the entry under the @skillsmith/mcp-server key with a resolved binary path + SKILLSMITH_CLIENT=cursor', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()

    const result = installAgentPack({ homeDir })

    const doc = readCursorMcpJson(homeDir)
    const entry = doc.mcpServers['@skillsmith/mcp-server']
    expect(entry?.command).toBe(RESOLVED_BIN_PATH)
    expect(entry?.env?.SKILLSMITH_CLIENT).toBe('cursor')
    expect(entry?.env?.SKILLSMITH_TOOL_PROFILE).toBe('agent')
    // No `args` — unlike the broken npx form, Cursor's entry invokes the
    // resolved binary directly.
    expect(entry?.args).toBeUndefined()
    // No stray legacy key on a first-ever install.
    expect(doc.mcpServers.skillsmith).toBeUndefined()

    const report = result.harnessReports.find((r) => r.harness === 'cursor')
    expect(report?.mcpConfig?.status).toBe('created')
  })

  it('falls back to the documented paste-here placeholder when the binary cannot be resolved', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found')
    })
    seedCursorPresent()

    installAgentPack({ homeDir })

    const doc = readCursorMcpJson(homeDir)
    const entry = doc.mcpServers['@skillsmith/mcp-server']
    expect(entry?.command).toContain('which skillsmith-mcp')
    expect(entry?.command).toContain('where skillsmith-mcp')
  })

  it('falls back to the placeholder (never hangs) when the which/where lookup times out — code-review finding, GPT-5.6-Sol / SMI-6279', () => {
    // execFileSync throws a synchronous ETIMEDOUT-shaped error when its own
    // `timeout` option elapses — the existing blanket catch already handles
    // this the same as "not found", so simulating that error is sufficient
    // to prove the timeout-case fallback without an actual hung process.
    const timeoutError = Object.assign(new Error('spawnSync which ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      killed: true,
      signal: 'SIGTERM',
    })
    execFileSyncMock.mockImplementation(() => {
      throw timeoutError
    })
    seedCursorPresent()

    installAgentPack({ homeDir })

    const doc = readCursorMcpJson(homeDir)
    const entry = doc.mcpServers['@skillsmith/mcp-server']
    expect(entry?.command).toContain('which skillsmith-mcp')

    // And the bound is actually wired to the real execFileSync call, not
    // just documented — a `timeout` option keeps a hung/substituted
    // which/where from blocking `agent install` indefinitely.
    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      ['skillsmith-mcp'],
      expect.objectContaining({ timeout: expect.any(Number) })
    )
    const [, , options] = execFileSyncMock.mock.calls[0] as [string, string[], { timeout: number }]
    expect(options.timeout).toBeGreaterThan(0)
    // A few seconds is plenty for a local PATH lookup — not a network call.
    expect(options.timeout).toBeLessThanOrEqual(5000)
  })

  it('does not regress claude-code’s own entry — still the npx form under the "skillsmith" key', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()

    installAgentPack({ homeDir })

    const claudeDoc = JSON.parse(
      readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf-8')
    ) as CursorMcpDoc
    expect(claudeDoc.mcpServers.skillsmith?.command).toBe('npx')
    expect(claudeDoc.mcpServers.skillsmith?.env?.SKILLSMITH_TOOL_PROFILE).toBe('agent')
    expect(claudeDoc.mcpServers.skillsmith?.env?.SKILLSMITH_CLIENT).toBeUndefined()
  })
})

describe('installAgentPack — cursor mcp.json idempotency (SMI-6279 Wave 9)', () => {
  it('re-install does not create a duplicate second server entry', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()

    installAgentPack({ homeDir })
    const second = installAgentPack({ homeDir })

    const doc = readCursorMcpJson(homeDir)
    expect(Object.keys(doc.mcpServers)).toEqual(['@skillsmith/mcp-server'])

    const report = second.harnessReports.find((r) => r.harness === 'cursor')
    expect(report?.mcpConfig?.status).toBe('unchanged')
  })
})

describe('installAgentPack — cursor mcp.json stale legacy-key cleanup (SMI-6279 Wave 9)', () => {
  it('removes a stale "skillsmith"-keyed entry from a pre-fix install, leaving exactly one entry', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()
    writeFileSync(
      mcpJsonPath(homeDir),
      JSON.stringify(
        {
          mcpServers: {
            skillsmith: {
              command: 'npx',
              args: ['-y', '@skillsmith/mcp-server'],
              env: { SKILLSMITH_TOOL_PROFILE: 'agent' },
            },
          },
        },
        null,
        2
      )
    )

    installAgentPack({ homeDir })

    const doc = readCursorMcpJson(homeDir)
    expect(doc.mcpServers.skillsmith).toBeUndefined()
    expect(doc.mcpServers['@skillsmith/mcp-server']?.command).toBe(RESOLVED_BIN_PATH)
    expect(Object.keys(doc.mcpServers)).toEqual(['@skillsmith/mcp-server'])
  })

  it('preserves a foreign entry under the legacy "skillsmith" key — never deletes a user-owned unrelated entry', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()
    const foreignEntry = { command: 'some-other-tool', args: ['--flag'] }
    writeFileSync(
      mcpJsonPath(homeDir),
      JSON.stringify({ mcpServers: { skillsmith: foreignEntry } }, null, 2)
    )

    installAgentPack({ homeDir })

    const doc = readCursorMcpJson(homeDir)
    expect(doc.mcpServers.skillsmith).toEqual(foreignEntry)
    expect(doc.mcpServers['@skillsmith/mcp-server']?.command).toBe(RESOLVED_BIN_PATH)
  })

  it('preserves a near-miss entry that references the package name in an extra description field (code-review finding, GPT-5.6-Sol / SMI-6279)', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()
    // Structurally close to our own legacy shape (same command/args/env
    // value) but NOT byte-identical — one extra key. The old loose
    // `looksLikeOurMcpEntry` heuristic (substring-matches args, checks only
    // key presence) would have matched this and deleted it; the tightened
    // exact-shape check must not.
    const nearMissEntry = {
      command: 'npx',
      args: ['-y', '@skillsmith/mcp-server'],
      env: { SKILLSMITH_TOOL_PROFILE: 'agent' },
      description: 'Custom wrapper — see @skillsmith/mcp-server docs for context',
    }
    writeFileSync(
      mcpJsonPath(homeDir),
      JSON.stringify({ mcpServers: { skillsmith: nearMissEntry } }, null, 2)
    )

    installAgentPack({ homeDir })

    const doc = readCursorMcpJson(homeDir)
    expect(doc.mcpServers.skillsmith).toEqual(nearMissEntry)
    expect(doc.mcpServers['@skillsmith/mcp-server']?.command).toBe(RESOLVED_BIN_PATH)
  })

  it('preserves a near-miss "skillsmith"-keyed entry whose SKILLSMITH_TOOL_PROFILE value differs from what we would have written (code-review finding, GPT-5.6-Sol / SMI-6279)', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()
    // Same command/args/key SET as our legacy shape, but a different env
    // VALUE — the old loose heuristic only checked key presence, not value,
    // and would have matched+deleted this too.
    const nearMissEntry = {
      command: 'npx',
      args: ['-y', '@skillsmith/mcp-server'],
      env: { SKILLSMITH_TOOL_PROFILE: 'debug' },
    }
    writeFileSync(
      mcpJsonPath(homeDir),
      JSON.stringify({ mcpServers: { skillsmith: nearMissEntry } }, null, 2)
    )

    installAgentPack({ homeDir })

    const doc = readCursorMcpJson(homeDir)
    expect(doc.mcpServers.skillsmith).toEqual(nearMissEntry)
    expect(doc.mcpServers['@skillsmith/mcp-server']?.command).toBe(RESOLVED_BIN_PATH)
  })

  it('is idempotent: a second install run on an already-migrated file makes no further legacy-key change', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()
    writeFileSync(
      mcpJsonPath(homeDir),
      JSON.stringify(
        {
          mcpServers: {
            skillsmith: {
              command: 'npx',
              args: ['-y', '@skillsmith/mcp-server'],
              env: { SKILLSMITH_TOOL_PROFILE: 'agent' },
            },
          },
        },
        null,
        2
      )
    )

    installAgentPack({ homeDir }) // first run: writes the new key, cleans the legacy one
    const afterFirst = readFileSync(mcpJsonPath(homeDir), 'utf-8')
    const second = installAgentPack({ homeDir }) // second run: nothing left to clean
    const afterSecond = readFileSync(mcpJsonPath(homeDir), 'utf-8')

    expect(afterSecond).toBe(afterFirst)
    const report = second.harnessReports.find((r) => r.harness === 'cursor')
    expect(report?.mcpConfig?.status).toBe('unchanged')
  })

  it('reports a cleanup write failure via report.notes instead of swallowing it as "nothing to clean up" (PR-07 finding, GPT-5.6-Sol / SMI-6279)', () => {
    execFileSyncMock.mockReturnValue(`${RESOLVED_BIN_PATH}\n`)
    seedCursorPresent()
    // Seed BOTH the already-correct new entry and the stale legacy entry, so
    // the main merge sees 'unchanged' (no write attempted there) and only
    // the cleanup step's own write is exercised below.
    writeFileSync(
      mcpJsonPath(homeDir),
      JSON.stringify(
        {
          mcpServers: {
            skillsmith: {
              command: 'npx',
              args: ['-y', '@skillsmith/mcp-server'],
              env: { SKILLSMITH_TOOL_PROFILE: 'agent' },
            },
            '@skillsmith/mcp-server': {
              command: RESOLVED_BIN_PATH,
              env: { SKILLSMITH_TOOL_PROFILE: 'agent', SKILLSMITH_CLIENT: 'cursor' },
            },
          },
        },
        null,
        2
      )
    )

    // Target only the cleanup's write to THIS file — installAgentPack also
    // writes several unrelated skill-pack files earlier in the same run, and
    // must keep writing those for real.
    const targetPath = mcpJsonPath(homeDir)
    writeFileSyncMock.mockImplementation((...args: unknown[]) => {
      if (args[0] === targetPath) {
        throw new Error('EACCES: permission denied (simulated)')
      }

      return realWriteFileSyncRef.current!(...args)
    })

    const result = installAgentPack({ homeDir })

    // The legacy key must still be on disk — the failed write must not have
    // corrupted or partially applied the delete.
    const doc = readCursorMcpJson(homeDir)
    expect(doc.mcpServers.skillsmith).toBeDefined()

    const report = result.harnessReports.find((r) => r.harness === 'cursor')
    expect(report?.notes.some((n) => n.includes('could not remove it'))).toBe(true)
    expect(report?.notes.some((n) => n.includes('EACCES'))).toBe(true)
  })
})
