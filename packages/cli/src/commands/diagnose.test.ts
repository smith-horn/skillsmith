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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  vi.restoreAllMocks()
})

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
