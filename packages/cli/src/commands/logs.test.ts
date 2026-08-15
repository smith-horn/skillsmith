/**
 * @fileoverview Tests for `skillsmith logs`.
 * @module @skillsmith/cli/commands/logs.test
 * @see SMI-5615 Wave 3 Step 1
 *
 * Follows `packages/core/src/logging/rotation.test.ts`'s pattern — a real
 * `mkdtempSync` temp directory pointed at by `SKILLSMITH_LOG_DIR`, never the
 * real `~/.skillsmith/logs/` — plus `pin.test.ts`'s `process.exit` spy
 * convention.
 *
 * Covers: zero-log-files graceful message; chronological printing without
 * `--tail`; `--level` filtering; invalid `--level` exits cleanly; Commander
 * wiring; a reasonable-effort `--tail` live-follow test (write a line, await
 * pickup within a timeout — no existing live-file-watch test pattern in this
 * repo to otherwise match).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLogsCommand, runLogs, startTail } from './logs.js'

let tempLogDir: string
let originalLogDir: string | undefined
let exitSpy: ReturnType<typeof vi.spyOn>

function captureConsole(): string[] {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return lines
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

function writeRecord(surface: string, date: string, overrides: Record<string, unknown>): void {
  const record = {
    ts: `${date}T09:00:00.000Z`,
    level: 'info',
    surface,
    event: 'info',
    msg: 'placeholder',
    version: '1.0.0',
    pid: 1,
    ...overrides,
  }
  const path = join(tempLogDir, `skillsmith-${surface}-${date}.jsonl`)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, `${existing}${JSON.stringify(record)}\n`)
}

beforeEach(() => {
  tempLogDir = mkdtempSync(join(tmpdir(), 'skillsmith-logs-test-'))
  originalLogDir = process.env['SKILLSMITH_LOG_DIR']
  process.env['SKILLSMITH_LOG_DIR'] = tempLogDir

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
})

afterEach(() => {
  if (originalLogDir === undefined) delete process.env['SKILLSMITH_LOG_DIR']
  else process.env['SKILLSMITH_LOG_DIR'] = originalLogDir
  rmSync(tempLogDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('skillsmith logs', () => {
  it('prints a graceful "no logs found" message with zero log files, without crashing', async () => {
    const lines = captureConsole()
    await runLogs({})
    expect(exitSpy).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('No logs found')
  })

  it('prints existing lines chronologically (oldest first) without --tail', async () => {
    const date = '2026-07-01'
    writeRecord('cli', date, { ts: `${date}T09:00:00.000Z`, msg: 'oldest-line' })
    writeRecord('cli', date, { ts: `${date}T10:00:00.000Z`, msg: 'newest-line' })

    const lines = captureConsole()
    await runLogs({})
    const output = lines.join('\n')

    expect(output).toContain('oldest-line')
    expect(output).toContain('newest-line')
    expect(output.indexOf('oldest-line')).toBeLessThan(output.indexOf('newest-line'))
  })

  it('--level filters to records at or above the given level', async () => {
    const date = '2026-07-01'
    writeRecord('cli', date, { ts: `${date}T09:00:00.000Z`, level: 'debug', msg: 'debug-line' })
    writeRecord('cli', date, { ts: `${date}T09:01:00.000Z`, level: 'warn', msg: 'warn-line' })
    writeRecord('cli', date, { ts: `${date}T09:02:00.000Z`, level: 'error', msg: 'error-line' })

    const lines = captureConsole()
    await runLogs({ level: 'warn' })
    const output = lines.join('\n')

    expect(output).not.toContain('debug-line')
    expect(output).toContain('warn-line')
    expect(output).toContain('error-line')
  })

  it('--level info excludes only debug', async () => {
    const date = '2026-07-01'
    writeRecord('cli', date, { ts: `${date}T09:00:00.000Z`, level: 'debug', msg: 'debug-line' })
    writeRecord('cli', date, { ts: `${date}T09:01:00.000Z`, level: 'info', msg: 'info-line' })

    const lines = captureConsole()
    await runLogs({ level: 'info' })
    const output = lines.join('\n')

    expect(output).not.toContain('debug-line')
    expect(output).toContain('info-line')
  })

  it('exits(1) with a clear error for an invalid --level value, without crashing the process', async () => {
    await expect(runLogs({ level: 'not-a-level' })).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('is wired into Commander as `logs` with --tail and --level options', () => {
    const cmd = createLogsCommand()
    expect(cmd.name()).toBe('logs')
    const optionNames = cmd.options.map((o) => o.long)
    expect(optionNames).toContain('--tail')
    expect(optionNames).toContain('--level')
  })

  describe('--tail', () => {
    it('prints an already-appended line for today, then picks up a newly appended line within a timeout', async () => {
      const date = todayDateString()
      writeRecord('cli', date, { ts: new Date().toISOString(), msg: 'already-there' })

      const lines = captureConsole()

      let resolveRecord: () => void
      const recordSeen = new Promise<void>((resolve) => {
        resolveRecord = resolve
      })

      const handle = await startTail(tempLogDir, undefined, {
        onRecord: () => resolveRecord(),
      })

      try {
        // Existing content is printed synchronously as part of startTail.
        expect(lines.join('\n')).toContain('already-there')

        writeRecord('cli', date, { ts: new Date().toISOString(), msg: 'live-line' })

        // GH #2335: this races chokidar's real `usePolling`/`interval: 100`
        // fs poll (see `startTail` in logs.ts) against a wall-clock deadline —
        // there's no deterministic alternative to await here (no existing
        // live-file-watch test pattern in this repo, per this file's header
        // comment). This failed once in `post-merge-verify.yml` (one of
        // ~9500 tests in a single `vitest run` on native `ubuntu-latest`,
        // right after several CPU-heavy setup steps) with the original 8s
        // budget. UNCONFIRMED HYPOTHESIS, not established fact: scheduler
        // contention on that runner starved the 100ms poll past 8s — a
        // dedicated repro (20+15 solo repeats, 4x-parallel contention, a
        // full ~9500-test run under a matched 2-vCPU Docker constraint, and
        // an extreme-stress run at 40-60x slowdown) never reproduced the
        // failure, so this widening is a reasoned margin increase, not a
        // confirmed fix — see SMI-6028 for the follow-up if it recurs.
        // `vitest.preset.ts`'s `retry: { count: 1, condition: /timeout/i }`
        // already re-runs this exact failure mode once as a second line of
        // defense. Widened 8s -> 15s, outer 15s -> 22s, preserving the
        // original 7s inner/outer buffer (do not shrink this gap — a
        // smaller buffer risks a slow `handle.close()` masking this test's
        // specific diagnostic error behind Vitest's generic timeout).
        await Promise.race([
          recordSeen,
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('timeout waiting for tailed line')), 15000)
          ),
        ])

        expect(lines.join('\n')).toContain('live-line')
      } finally {
        await handle.close()
      }
    }, 22000)

    it('prints "no logs found" then keeps watching when nothing exists for today yet', async () => {
      const lines = captureConsole()
      const handle = await startTail(tempLogDir, undefined)
      try {
        expect(lines.join('\n')).toContain('No logs found')
      } finally {
        await handle.close()
      }
    })
  })
})
