/**
 * @fileoverview Tests for `skillsmith diagnose`.
 * @module @skillsmith/cli/commands/diagnose.test
 * @see SMI-5615 Wave 3 Step 1
 *
 * Follows `packages/core/src/logging/rotation.test.ts`'s pattern — a real
 * `mkdtempSync` temp directory pointed at by `SKILLSMITH_LOG_DIR`, never the
 * real `~/.skillsmith/logs/` — plus `pin.test.ts`'s `process.exit` spy
 * convention so a failure path never actually kills the test runner.
 *
 * Covers: zero-log-files graceful message; parsing + printing real seeded
 * JSONL records (most-recent-first, `--limit`); env summary reflecting
 * SKILLSMITH_ERROR_LOG_DISABLE/SKILLSMITH_LOG_LEVEL; `--bundle` (default
 * path and an explicit path) producing a readable output file; Commander
 * wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SMI-6279 Wave 9: the "global" Cursor MCP config check reads
// AGENT_MCP_TARGETS.cursor.path, which `@skillsmith/core/install` bakes in
// at MODULE LOAD time from the REAL os.homedir() (agent-harness-targets.ts —
// mocking `homedir()` after the fact wouldn't help, it's an already-computed
// constant). Mock the target path itself, pointed at a real temp dir. Uses
// `require()` (not this file's own top-level `node:fs`/`node:os`/`node:path`
// imports) inside `vi.hoisted` — Vitest's hoist transform moves `vi.hoisted`/
// `vi.mock` calls ABOVE the transformed import bindings too, so referencing
// them here throws `Cannot access '...' before initialization`; `require()`
// sidesteps that entirely (same pattern already used elsewhere in this repo,
// e.g. packages/doc-retrieval-mcp/src/retrieval-log/writer.test.ts). Never
// touches the real `~/.cursor/mcp.json`.
const { globalCursorMcpPath } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before this file's own transformed ESM import bindings are initialized (see comment above); require() is the only way to reach node:fs/os/path from inside it.
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-diagnose-global-cursor-'))
  return { globalCursorMcpPath: path.join(dir, 'mcp.json') }
})
vi.mock('@skillsmith/core/install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core/install')>()
  return {
    ...actual,
    AGENT_MCP_TARGETS: {
      ...actual.AGENT_MCP_TARGETS,
      cursor: { ...actual.AGENT_MCP_TARGETS.cursor, path: globalCursorMcpPath },
    },
  }
})

import { createDiagnoseCommand, runDiagnose } from './diagnose.js'

let tempLogDir: string
let tempCwd: string
let cwdBefore: string
let originalLogDir: string | undefined
let originalDisable: string | undefined
let originalLevel: string | undefined
let exitSpy: ReturnType<typeof vi.spyOn>

function captureConsole(): string[] {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return lines
}

function seedRecord(surface: string, date: string, overrides: Record<string, unknown> = {}): void {
  const record = {
    ts: `${date}T10:00:00.000Z`,
    level: 'error',
    surface,
    event: 'error',
    msg: 'Something failed',
    version: '1.0.0',
    pid: 123,
    ...overrides,
  }
  const path = join(tempLogDir, `skillsmith-${surface}-${date}.jsonl`)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, `${existing}${JSON.stringify(record)}\n`)
}

beforeEach(() => {
  tempLogDir = mkdtempSync(join(tmpdir(), 'skillsmith-diagnose-test-'))
  tempCwd = mkdtempSync(join(tmpdir(), 'skillsmith-diagnose-cwd-'))
  cwdBefore = process.cwd()
  process.chdir(tempCwd)

  originalLogDir = process.env['SKILLSMITH_LOG_DIR']
  originalDisable = process.env['SKILLSMITH_ERROR_LOG_DISABLE']
  originalLevel = process.env['SKILLSMITH_LOG_LEVEL']
  process.env['SKILLSMITH_LOG_DIR'] = tempLogDir

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
})

afterEach(() => {
  process.chdir(cwdBefore)

  if (originalLogDir === undefined) delete process.env['SKILLSMITH_LOG_DIR']
  else process.env['SKILLSMITH_LOG_DIR'] = originalLogDir
  if (originalDisable === undefined) delete process.env['SKILLSMITH_ERROR_LOG_DISABLE']
  else process.env['SKILLSMITH_ERROR_LOG_DISABLE'] = originalDisable
  if (originalLevel === undefined) delete process.env['SKILLSMITH_LOG_LEVEL']
  else process.env['SKILLSMITH_LOG_LEVEL'] = originalLevel

  rmSync(tempLogDir, { recursive: true, force: true })
  rmSync(tempCwd, { recursive: true, force: true })
  // SMI-6279 Wave 9: reset the mocked "global" Cursor MCP path between
  // tests — the temp dir itself is shared for the whole file (created once
  // via vi.hoisted), only the file inside it is per-test state.
  rmSync(globalCursorMcpPath, { force: true })
  vi.restoreAllMocks()
})

const STALE_NPX_ENTRY = {
  mcpServers: {
    skillsmith: {
      command: 'npx',
      args: ['-y', '@skillsmith/mcp-server'],
      env: { SKILLSMITH_TOOL_PROFILE: 'agent' },
    },
  },
}

const FRESH_BINARY_ENTRY = {
  mcpServers: {
    '@skillsmith/mcp-server': {
      command: '/usr/local/bin/skillsmith-mcp',
      env: { SKILLSMITH_TOOL_PROFILE: 'agent', SKILLSMITH_CLIENT: 'cursor' },
    },
  },
}

function writeProjectCursorMcpJson(content: unknown): void {
  mkdirSync(join(tempCwd, '.cursor'), { recursive: true })
  writeFileSync(join(tempCwd, '.cursor', 'mcp.json'), JSON.stringify(content, null, 2))
}

function writeGlobalCursorMcpJson(content: unknown): void {
  writeFileSync(globalCursorMcpPath, JSON.stringify(content, null, 2))
}

describe('skillsmith diagnose', () => {
  it('prints a graceful "no logs found" message with zero log files, without crashing', async () => {
    const lines = captureConsole()
    await runDiagnose({})
    expect(exitSpy).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('No logs found')
  })

  it('parses and prints real seeded JSONL records, most-recent-first', async () => {
    seedRecord('cli', '2026-07-01', { ts: '2026-07-01T09:00:00.000Z', msg: 'first-record' })
    seedRecord('mcp', '2026-07-02', {
      ts: '2026-07-02T09:00:00.000Z',
      msg: 'second-record',
      correlationId: 'corr-123',
    })

    const lines = captureConsole()
    await runDiagnose({})
    const output = lines.join('\n')

    expect(output).toContain('first-record')
    expect(output).toContain('second-record')
    expect(output).toContain('corr-123')
    // most-recent-first ordering
    expect(output.indexOf('second-record')).toBeLessThan(output.indexOf('first-record'))
  })

  it('respects --limit', async () => {
    for (let i = 0; i < 5; i++) {
      seedRecord('cli', '2026-07-01', {
        ts: `2026-07-01T09:0${i}:00.000Z`,
        msg: `msg-${i}`,
      })
    }
    const lines = captureConsole()
    await runDiagnose({ limit: '2' })
    const output = lines.join('\n')

    expect(output).toContain('msg-4')
    expect(output).toContain('msg-3')
    expect(output).not.toContain('msg-0')
    expect(output).not.toContain('msg-1')
  })

  it('reflects SKILLSMITH_ERROR_LOG_DISABLE / SKILLSMITH_LOG_LEVEL in the environment summary', async () => {
    process.env['SKILLSMITH_ERROR_LOG_DISABLE'] = '1'
    process.env['SKILLSMITH_LOG_LEVEL'] = 'debug'

    const lines = captureConsole()
    await runDiagnose({})
    const output = lines.join('\n')

    expect(output).toContain('SKILLSMITH_ERROR_LOG_DISABLE: 1')
    expect(output).toContain('SKILLSMITH_LOG_LEVEL: debug')
  })

  it('shows "(unset)" when the env vars are not configured', async () => {
    delete process.env['SKILLSMITH_ERROR_LOG_DISABLE']
    delete process.env['SKILLSMITH_LOG_LEVEL']

    const lines = captureConsole()
    await runDiagnose({})
    const output = lines.join('\n')

    expect(output).toContain('SKILLSMITH_ERROR_LOG_DISABLE: (unset)')
    expect(output).toMatch(/SKILLSMITH_LOG_LEVEL: \(unset/)
  })

  describe('--bundle', () => {
    it('writes a .txt bundle at the default path containing env summary + log content', async () => {
      seedRecord('cli', '2026-07-01', { msg: 'bundle-me' })

      const lines = captureConsole()
      await runDiagnose({ bundle: true })
      const output = lines.join('\n')

      const match = output.match(/Diagnostic bundle written to (\S+)/)
      expect(match).not.toBeNull()
      const bundlePath = match?.[1]
      if (!bundlePath) throw new Error('bundle path not found in output')

      expect(bundlePath.endsWith('.txt')).toBe(true)
      expect(existsSync(bundlePath)).toBe(true)

      const content = readFileSync(bundlePath, 'utf8')
      expect(content).toContain('Environment')
      expect(content).toContain('CLI version:')
      expect(content).toContain('bundle-me')
    })

    it('writes to an explicit --bundle <path> when given', async () => {
      seedRecord('cli', '2026-07-01', { msg: 'explicit-bundle' })
      const explicitPath = join(tempCwd, 'custom-bundle.txt')

      await runDiagnose({ bundle: explicitPath })

      expect(existsSync(explicitPath)).toBe(true)
      const content = readFileSync(explicitPath, 'utf8')
      expect(content).toContain('explicit-bundle')
    })

    it('still writes a bundle (env summary only) when there are zero log files', async () => {
      const explicitPath = join(tempCwd, 'empty-bundle.txt')

      await runDiagnose({ bundle: explicitPath })

      expect(existsSync(explicitPath)).toBe(true)
      const content = readFileSync(explicitPath, 'utf8')
      expect(content).toContain('no log files found')
    })
  })

  it('is wired into Commander as `diagnose` with --limit and --bundle options', () => {
    const cmd = createDiagnoseCommand()
    expect(cmd.name()).toBe('diagnose')
    const optionNames = cmd.options.map((o) => o.long)
    expect(optionNames).toContain('--limit')
    expect(optionNames).toContain('--bundle')
  })
})

// SMI-6279 Wave 9: GH#2368 V3's actual broken config was project-scoped —
// nothing before this checked that location at all. Covers both required
// cases (stale npx-form flagged, fresh binary-path form passes) plus
// independence between the global and project-scoped locations.
describe('skillsmith diagnose — Cursor MCP registration check', () => {
  it('flags a stale project-scoped .cursor/mcp.json with the old npx form', async () => {
    writeProjectCursorMcpJson(STALE_NPX_ENTRY)

    const lines = captureConsole()
    await runDiagnose({})
    const output = lines.join('\n')

    expect(output).toContain('Cursor MCP registration')
    const projectPath = join(tempCwd, '.cursor', 'mcp.json')
    expect(output).toContain(projectPath)
    expect(output).toContain('STALE')
    expect(output).toContain("npx' command form")
    expect(output).toContain('missing SKILLSMITH_CLIENT=cursor')
    expect(output).toContain('skillsmith agent install')
  })

  it('passes a fresh binary-path .cursor/mcp.json', async () => {
    writeProjectCursorMcpJson(FRESH_BINARY_ENTRY)

    const lines = captureConsole()
    await runDiagnose({})
    const output = lines.join('\n')

    const projectPath = join(tempCwd, '.cursor', 'mcp.json')
    const projectLine = output.split('\n').find((line) => line.includes(projectPath))
    expect(projectLine).toBeDefined()
    expect(projectLine).toContain('OK')
    expect(projectLine).not.toContain('STALE')
  })

  it('checks the global and project-scoped locations independently', async () => {
    writeGlobalCursorMcpJson(STALE_NPX_ENTRY)
    writeProjectCursorMcpJson(FRESH_BINARY_ENTRY)

    const lines = captureConsole()
    await runDiagnose({})
    const output = lines.join('\n')
    const outputLines = output.split('\n')

    const globalLine = outputLines.find((line) => line.includes(globalCursorMcpPath))
    const projectPath = join(tempCwd, '.cursor', 'mcp.json')
    const projectLine = outputLines.find((line) => line.includes(projectPath))

    expect(globalLine).toBeDefined()
    expect(projectLine).toBeDefined()
    // Different files, different verdicts — proves each location is
    // evaluated on its own content, not short-circuited by the other.
    expect(globalLine).toContain('STALE')
    expect(projectLine).toContain('OK')
    expect(projectLine).not.toContain('STALE')
  })

  it('reports "(not found)" for a location with no mcp.json at all', async () => {
    // Neither global nor project-scoped file written this test.
    const lines = captureConsole()
    await runDiagnose({})
    const output = lines.join('\n')

    expect(output).toContain(`${globalCursorMcpPath}: (not found)`)
    const projectPath = join(tempCwd, '.cursor', 'mcp.json')
    expect(output).toContain(`${projectPath}: (not found)`)
  })
})
