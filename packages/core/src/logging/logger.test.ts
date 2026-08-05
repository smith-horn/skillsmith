/**
 * SMI-5615: Tests for the shared `logger.ts` factory — crash-proofing,
 * `SKILLSMITH_ERROR_LOG_DISABLE`, `SKILLSMITH_LOG_LEVEL` filtering,
 * redaction-on-disk, and the correlation-ID call-site invariant (F3). All
 * tests point `SKILLSMITH_LOG_DIR` at a temp directory — never the real
 * `~/.skillsmith/logs/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithCorrelationId } from './context.js'
import { createLogger } from './logger.js'
import { __resetLoggingStateForTests } from './rotation.js'

let tempDir: string
let originalLogDir: string | undefined
let originalDisable: string | undefined
let originalLevel: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skillsmith-logger-'))
  originalLogDir = process.env.SKILLSMITH_LOG_DIR
  originalDisable = process.env.SKILLSMITH_ERROR_LOG_DISABLE
  originalLevel = process.env.SKILLSMITH_LOG_LEVEL
  process.env.SKILLSMITH_LOG_DIR = tempDir
  delete process.env.SKILLSMITH_ERROR_LOG_DISABLE
  delete process.env.SKILLSMITH_LOG_LEVEL
})

afterEach(async () => {
  await __resetLoggingStateForTests()
  vi.restoreAllMocks()

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('SKILLSMITH_LOG_DIR', originalLogDir)
  restore('SKILLSMITH_ERROR_LOG_DISABLE', originalDisable)
  restore('SKILLSMITH_LOG_LEVEL', originalLevel)

  rmSync(tempDir, { recursive: true, force: true })
})

function findLogFile(surfacePrefix: string): string {
  const files = readdirSync(tempDir).filter((f) => f.startsWith(surfacePrefix))
  expect(files.length).toBeGreaterThan(0)
  return join(tempDir, files[0])
}

async function waitForLogFile(surfacePrefix: string): Promise<string[]> {
  return vi.waitFor(
    () => {
      const files = readdirSync(tempDir).filter((f) => f.startsWith(surfacePrefix))
      expect(files.length).toBeGreaterThan(0)
      // SMI-5837: `createWriteStream`'s `'open'` event (which makes the file
      // show up in `readdirSync` below) can fire — under I/O contention —
      // before the first `write()` callback actually lands the bytes; a
      // caller that immediately `readFileSync`s + `JSON.parse`s right after
      // this resolves would then observe a 0-byte file and fail with
      // "Unexpected end of JSON input", unrelated to whatever the test is
      // actually asserting. Requiring non-empty content here (not just
      // existence) closes that window for every call site at once, instead
      // of requiring each one to duplicate its own follow-up wait.
      const content = readFileSync(join(tempDir, files[0]), 'utf8')
      expect(content.length).toBeGreaterThan(0)
      return files
    },
    { timeout: 2000, interval: 20 }
  )
}

describe('logger.ts — redaction on disk', () => {
  it('writes a redacted message and never persists the raw secret', async () => {
    const logger = createLogger('mcp')
    logger.error('Failed with token sk_live_abcdefghijklmnopqrstuvwx')

    await waitForLogFile('skillsmith-mcp-')
    const content = await vi.waitFor(
      () => {
        const text = readFileSync(findLogFile('skillsmith-mcp-'), 'utf8')
        expect(text.length).toBeGreaterThan(0)
        return text
      },
      { timeout: 2000, interval: 20 }
    )

    expect(content).toContain('sk_live_[REDACTED]')
    expect(content).not.toContain('abcdefghijklmnopqrstuvwx')

    const record = JSON.parse(content.trim().split('\n')[0])
    expect(record.level).toBe('error')
    expect(record.surface).toBe('mcp')
    expect(record.msg).toContain('sk_live_[REDACTED]')
  })

  it('redacts secrets inside the `err` detail as well as the message', async () => {
    const logger = createLogger('cli')
    const err = new Error('token=ghp_1234567890abcdefghijklmnopqrstuvwxyz')
    logger.error('tool call failed', { err })

    await waitForLogFile('skillsmith-cli-')
    const content = await vi.waitFor(
      () => {
        const text = readFileSync(findLogFile('skillsmith-cli-'), 'utf8')
        expect(text.length).toBeGreaterThan(0)
        return text
      },
      { timeout: 2000, interval: 20 }
    )
    const record = JSON.parse(content.trim().split('\n')[0])
    expect(record.err.message).toContain('ghp_[REDACTED]')
    expect(record.err.message).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz')
  })

  it('strips chalk/ANSI codes from the disk record and redacts a secret that immediately follows one (Mode-B Wave 2 finding)', async () => {
    const logger = createLogger('cli')
    const secret = 'sk_live_' + 'd'.repeat(24)
    // Realistic CLI shape: chalk.red('Error:') directly adjacent to a secret,
    // no space — the exact pattern the diff-audit flagged as a latent gap.
    logger.error(`\x1b[31mError:\x1b[39m${secret} leaked`)

    await waitForLogFile('skillsmith-cli-')
    const content = readFileSync(findLogFile('skillsmith-cli-'), 'utf8')
    const record = JSON.parse(content.trim().split('\n')[0])

    expect(record.msg).not.toContain('\x1b[')
    expect(record.msg).not.toContain(secret)
    expect(record.msg).toContain('sk_live_[REDACTED]')
  })
})

describe('logger.ts — warn/error always mirror to console (plan §1, not just on write failure)', () => {
  // Regression coverage for a Mode-B-adjacent finding caught during Wave 2
  // wire-in: an earlier version of `persistRecord` only called
  // `consoleFallback` when the disk write FAILED. That silently broke the
  // whole point of swapping `console.error`/`warn` call sites in the MCP
  // server and CLI for `logger.error`/`warn` — on the (normal) successful
  // write path, callers would see NOTHING on screen, a regression from
  // today's always-visible `console.error`. The plan is explicit: "the
  // logger writes to disk AND still emits to stderr for warn/error" —
  // unconditionally, not as a failure fallback.

  it('mirrors error to console.error even when the disk write succeeds (writable dir)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger('mcp')

    logger.error('boom')

    // console mirror must be synchronous/immediate — a CLI user reading a
    // terminal cannot wait for an async disk write to decide whether to print.
    expect(errorSpy).toHaveBeenCalledWith('boom')

    // ...and the disk record still lands too (both, not either/or).
    await waitForLogFile('skillsmith-mcp-')
  })

  it('mirrors warn to console.warn (not console.error) even when the disk write succeeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger('cli')

    logger.warn('careful')

    expect(warnSpy).toHaveBeenCalledWith('careful')
    expect(errorSpy).not.toHaveBeenCalled()
    await waitForLogFile('skillsmith-cli-')
  })

  it('redacts the console-mirrored message too, not just the disk record', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger('mcp')
    const secret = 'sk_live_' + 'b'.repeat(24)

    logger.error(`auth failed with ${secret}`)

    const calledWith = errorSpy.mock.calls.map((call) => call[0]).join('\n')
    expect(calledWith).not.toContain(secret)
    expect(calledWith).toContain('sk_live_[REDACTED]')
  })

  it('does NOT mirror info/debug to console on the successful-write path (disk-only by design)', async () => {
    process.env.SKILLSMITH_LOG_LEVEL = 'debug'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logger = createLogger('mcp')

    logger.info('routine status')
    logger.debug('verbose detail')

    await waitForLogFile('skillsmith-mcp-')
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('logger.ts — SKILLSMITH_ERROR_LOG_DISABLE', () => {
  it('accepts "1" and skips writing entirely', async () => {
    process.env.SKILLSMITH_ERROR_LOG_DISABLE = '1'
    const logger = createLogger('mcp')
    logger.error('should not be written')

    // Give any accidental async write a chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(readdirSync(tempDir)).toHaveLength(0)
  })

  it('accepts "true" (case-insensitive)', async () => {
    process.env.SKILLSMITH_ERROR_LOG_DISABLE = 'TRUE'
    const logger = createLogger('mcp')
    logger.error('should not be written')

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(readdirSync(tempDir)).toHaveLength(0)
  })

  it('logs normally when unset', async () => {
    const logger = createLogger('mcp')
    logger.error('should be written')
    await waitForLogFile('skillsmith-mcp-')
  })
})

describe('logger.ts — SKILLSMITH_LOG_LEVEL filtering', () => {
  it('defaults to warn — info/debug are suppressed, warn/error are not', async () => {
    const logger = createLogger('mcp')
    logger.debug('debug message')
    logger.info('info message')
    logger.warn('warn message')

    await waitForLogFile('skillsmith-mcp-')
    const content = readFileSync(findLogFile('skillsmith-mcp-'), 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).msg).toBe('warn message')
  })

  it('SKILLSMITH_LOG_LEVEL=debug allows every level through', async () => {
    process.env.SKILLSMITH_LOG_LEVEL = 'debug'
    const logger = createLogger('mcp')
    logger.debug('debug message')
    logger.info('info message')
    logger.warn('warn message')
    logger.error('error message')

    await vi.waitFor(
      () => {
        const files = readdirSync(tempDir).filter((f) => f.startsWith('skillsmith-mcp-'))
        expect(files.length).toBeGreaterThan(0)
        const content = readFileSync(join(tempDir, files[0]), 'utf8')
        const lines = content.trim().split('\n').filter(Boolean)
        expect(lines).toHaveLength(4)
        return lines
      },
      { timeout: 2000, interval: 20 }
    )
  })

  it('SKILLSMITH_LOG_LEVEL=error suppresses everything but error', async () => {
    process.env.SKILLSMITH_LOG_LEVEL = 'error'
    const logger = createLogger('mcp')
    logger.warn('warn message')
    logger.error('error message')

    await waitForLogFile('skillsmith-mcp-')
    const content = await vi.waitFor(
      () => {
        const text = readFileSync(findLogFile('skillsmith-mcp-'), 'utf8')
        const lines = text.trim().split('\n').filter(Boolean)
        expect(lines).toHaveLength(1)
        return text
      },
      { timeout: 2000, interval: 20 }
    )
    expect(JSON.parse(content.trim())).toMatchObject({ level: 'error', msg: 'error message' })
  })
})

describe('logger.ts — crash-proofing', () => {
  it('never throws and falls back to console when the log directory is unwritable', async () => {
    // A regular FILE at the path where a directory is expected makes
    // `mkdir(..., { recursive: true })` fail with ENOTDIR — portable and
    // permission-independent (unlike relying on running as non-root).
    const blockerFile = join(tempDir, 'blocker')
    writeFileSync(blockerFile, '')
    process.env.SKILLSMITH_LOG_DIR = join(blockerFile, 'logs')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger('mcp')

    expect(() => logger.error('this must not throw')).not.toThrow()

    await vi.waitFor(
      () => {
        expect(errorSpy).toHaveBeenCalled()
      },
      { timeout: 2000, interval: 20 }
    )
    expect(errorSpy.mock.calls.some((call) => call[0] === 'this must not throw')).toBe(true)
  })

  it('routes the warn-level fallback through console.warn, not console.error', async () => {
    const blockerFile = join(tempDir, 'blocker')
    writeFileSync(blockerFile, '')
    process.env.SKILLSMITH_LOG_DIR = join(blockerFile, 'logs')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logger = createLogger('cli')

    expect(() => logger.warn('warn fallback')).not.toThrow()

    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalledWith('warn fallback')
      },
      { timeout: 2000, interval: 20 }
    )
  })

  it('never throws even when `details` contains a circular reference, and still persists the record (NEW-2)', async () => {
    const logger = createLogger('mcp')
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => logger.error('circular details', { blob: circular })).not.toThrow()

    // Before the cycle guard, `redactSensitiveObject` stack-overflowed on
    // `circular`, which aborted the whole record and silently dropped it to
    // the console-only fallback. With the guard, the record — including the
    // correlationId/msg that have nothing to do with the cycle — must still
    // reach disk, with only the offending branch marked `'[Circular]'`.
    await waitForLogFile('skillsmith-mcp-')
    const content = readFileSync(findLogFile('skillsmith-mcp-'), 'utf8')
    const record = JSON.parse(content.trim().split('\n')[0])
    expect(record.msg).toBe('circular details')
    expect(record.details.blob.self).toBe('[Circular]')
  })

  it('redacts the message before the console fallback, not just the disk record (NEW-1)', async () => {
    const blockerFile = join(tempDir, 'blocker')
    writeFileSync(blockerFile, '')
    process.env.SKILLSMITH_LOG_DIR = join(blockerFile, 'logs')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger('mcp')
    const secret = 'sk_live_' + 'a'.repeat(24)

    expect(() => logger.error(`auth failed with ${secret}`)).not.toThrow()

    await vi.waitFor(
      () => {
        expect(errorSpy).toHaveBeenCalled()
      },
      { timeout: 2000, interval: 20 }
    )
    const calledWith = errorSpy.mock.calls.map((call) => call[0]).join('\n')
    expect(calledWith).not.toContain(secret)
    expect(calledWith).toContain('sk_live_[REDACTED]')
  })
})

describe('logger.ts — SMI-5837 regression: write queue drains before test-state reset', () => {
  // Deterministic (not stress/probabilistic) regression coverage for the
  // actual root cause: `logger.error()` is fire-and-forget (F2's design —
  // callers never await the disk write), so immediately calling
  // `__resetLoggingStateForTests()` right after, with NO poll/wait in
  // between, exercises exactly the window the bug lived in. Before the fix,
  // `__resetLoggingStateForTests()` only closed whatever stream was
  // *currently* tracked and cleared state — it did not await the pending
  // write itself, so at this point in the test the write realistically
  // cannot have completed yet (`mkdir`+`open`+`write` all cross real event
  // loop turns), and the assertions below would reliably fail against the
  // old code. After the fix, `__resetLoggingStateForTests()` awaits every
  // surface's queue tail first, so the write is guaranteed complete by the
  // time it resolves — no waiting/polling needed here, and none of the
  // `vi.waitFor`-based tests elsewhere in this file would have caught a
  // regression here since they mask exactly this race by retrying.
  it('the write is durably on disk immediately after __resetLoggingStateForTests() resolves, with zero additional waiting', async () => {
    for (let i = 0; i < 10; i++) {
      const iterDir = mkdtempSync(join(tmpdir(), 'skillsmith-logger-drain-'))
      const priorLogDir = process.env.SKILLSMITH_LOG_DIR
      process.env.SKILLSMITH_LOG_DIR = iterDir
      try {
        const logger = createLogger('mcp')
        await runWithCorrelationId(`corr-drain-${i}`, async () => {
          logger.error(`drain iteration ${i}`)
        })

        // No waitForLogFile / vi.waitFor here — that's the point.
        await __resetLoggingStateForTests()

        const files = readdirSync(iterDir).filter((f) => f.startsWith('skillsmith-mcp-'))
        expect(files).toHaveLength(1)
        const content = readFileSync(join(iterDir, files[0]), 'utf8')
        expect(content.length).toBeGreaterThan(0)
        const record = JSON.parse(content.trim().split('\n')[0])
        expect(record.msg).toBe(`drain iteration ${i}`)
        expect(record.correlationId).toBe(`corr-drain-${i}`)
      } finally {
        if (priorLogDir === undefined) delete process.env.SKILLSMITH_LOG_DIR
        else process.env.SKILLSMITH_LOG_DIR = priorLogDir
        rmSync(iterDir, { recursive: true, force: true })
      }
    }
  })
})

describe('logger.ts — correlation ID (F3)', () => {
  it('stamps the correlation ID installed for the calling async continuation', async () => {
    const logger = createLogger('mcp')

    await runWithCorrelationId('corr-abc-123', async () => {
      logger.error('inside scope')
    })

    await waitForLogFile('skillsmith-mcp-')
    const content = readFileSync(findLogFile('skillsmith-mcp-'), 'utf8')
    const record = JSON.parse(content.trim().split('\n')[0])
    expect(record.correlationId).toBe('corr-abc-123')
  })

  it('omits correlationId when called outside any runWithCorrelationId scope', async () => {
    const logger = createLogger('cli')
    logger.error('outside scope')

    await waitForLogFile('skillsmith-cli-')
    const content = readFileSync(findLogFile('skillsmith-cli-'), 'utf8')
    const record = JSON.parse(content.trim().split('\n')[0])
    expect(record.correlationId).toBeUndefined()
  })

  it('keeps two concurrent, overlapping scopes from observing each others correlation ID', async () => {
    const logger = createLogger('vscode')
    const seen: Record<string, string | undefined> = {}

    await Promise.all([
      runWithCorrelationId('corr-A', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        logger.error('call A')
      }),
      runWithCorrelationId('corr-B', async () => {
        logger.error('call B')
      }),
    ])

    await vi.waitFor(
      () => {
        const files = readdirSync(tempDir).filter((f) => f.startsWith('skillsmith-vscode-'))
        expect(files.length).toBeGreaterThan(0)
        const content = readFileSync(join(tempDir, files[0]), 'utf8')
        const lines = content.trim().split('\n').filter(Boolean)
        expect(lines).toHaveLength(2)
        for (const line of lines) {
          const record = JSON.parse(line)
          seen[record.msg] = record.correlationId
        }
        return lines
      },
      { timeout: 2000, interval: 20 }
    )

    expect(seen['call A']).toBe('corr-A')
    expect(seen['call B']).toBe('corr-B')
  })
})
