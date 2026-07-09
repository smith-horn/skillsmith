/**
 * SMI-5615: Tests for the per-surface serialized JSONL writer (`rotation.ts`).
 *
 * Covers the plan's P-5 required test ("fire N concurrent large ...
 * writes ... assert every line parses as valid JSON with no
 * interleaved/torn content"), plus daily rollover, size-cap rollover, and
 * the 14-day retention sweep. All tests point `SKILLSMITH_LOG_DIR` at a temp
 * directory — never the real `~/.skillsmith/logs/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetLoggingStateForTests, pruneExpiredLogs, writeLogLine } from './rotation.js'

let tempDir: string
let originalLogDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skillsmith-log-rotation-'))
  originalLogDir = process.env.SKILLSMITH_LOG_DIR
  process.env.SKILLSMITH_LOG_DIR = tempDir
})

afterEach(async () => {
  await __resetLoggingStateForTests()
  if (originalLogDir === undefined) {
    delete process.env.SKILLSMITH_LOG_DIR
  } else {
    process.env.SKILLSMITH_LOG_DIR = originalLogDir
  }
  vi.useRealTimers()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('rotation.ts — write serialization (F2)', () => {
  it('serializes N concurrent large (>PIPE_BUF) writes without interleaving or tearing', async () => {
    const N = 25
    const PAYLOAD_SIZE = 6000 // > PIPE_BUF (4096 bytes)

    const writes = Array.from({ length: N }, (_, i) =>
      writeLogLine('mcp', JSON.stringify({ id: i, blob: 'x'.repeat(PAYLOAD_SIZE) }))
    )
    await Promise.all(writes)

    const files = readdirSync(tempDir).filter((f) => f.startsWith('skillsmith-mcp-'))
    expect(files).toHaveLength(1)

    const content = readFileSync(join(tempDir, files[0]), 'utf8')
    const lines = content.split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(N)

    const seenIds = new Set<number>()
    for (const line of lines) {
      // JSON.parse throws on a torn/interleaved line — this is the actual
      // no-tearing assertion, not just the id-uniqueness check below.
      const parsed = JSON.parse(line) as { id: number; blob: string }
      expect(parsed.blob).toHaveLength(PAYLOAD_SIZE)
      seenIds.add(parsed.id)
    }
    expect(seenIds.size).toBe(N)
  })

  it('keeps concurrent writes to different surfaces independent', async () => {
    await Promise.all([
      writeLogLine('mcp', JSON.stringify({ surface: 'mcp' })),
      writeLogLine('cli', JSON.stringify({ surface: 'cli' })),
      writeLogLine('vscode', JSON.stringify({ surface: 'vscode' })),
    ])

    const files = readdirSync(tempDir)
    expect(files.some((f) => f.startsWith('skillsmith-mcp-'))).toBe(true)
    expect(files.some((f) => f.startsWith('skillsmith-cli-'))).toBe(true)
    expect(files.some((f) => f.startsWith('skillsmith-vscode-'))).toBe(true)
  })
})

describe('rotation.ts — daily rollover', () => {
  it('rolls to a new dated file when the calendar date changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T23:59:00Z'))
    await writeLogLine('cli', JSON.stringify({ day: 1 }))

    vi.setSystemTime(new Date('2026-01-02T00:01:00Z'))
    await writeLogLine('cli', JSON.stringify({ day: 2 }))

    const files = readdirSync(tempDir)
      .filter((f) => f.startsWith('skillsmith-cli-'))
      .sort()
    expect(files).toEqual(['skillsmith-cli-2026-01-01.jsonl', 'skillsmith-cli-2026-01-02.jsonl'])

    const day1 = readFileSync(join(tempDir, 'skillsmith-cli-2026-01-01.jsonl'), 'utf8').trim()
    const day2 = readFileSync(join(tempDir, 'skillsmith-cli-2026-01-02.jsonl'), 'utf8').trim()
    expect(JSON.parse(day1)).toEqual({ day: 1 })
    expect(JSON.parse(day2)).toEqual({ day: 2 })
  })
})

describe('rotation.ts — size-cap rollover', () => {
  it('rolls to a .1 continuation file once the current file reaches the ~10MB cap', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-01T12:00:00Z'))

    // First write pushes the base file to (just over) the 10MB cap in one
    // shot — far faster than looping thousands of small writes to get there,
    // and exercises the same in-memory size-tracking path either way.
    const bigPayload = 'x'.repeat(10 * 1024 * 1024)
    await writeLogLine('cli', JSON.stringify({ big: bigPayload }))

    // Second write, same day: resolveStream sees sizeBytes >= cap and rolls
    // to a `.1` continuation file instead of continuing to grow the base file.
    await writeLogLine('cli', JSON.stringify({ rolled: true }))

    const baseName = 'skillsmith-cli-2026-02-01.jsonl'
    expect(existsSync(join(tempDir, `${baseName}.1`))).toBe(true)

    const rolledContent = readFileSync(join(tempDir, `${baseName}.1`), 'utf8').trim()
    expect(JSON.parse(rolledContent)).toEqual({ rolled: true })

    const baseLines = readFileSync(join(tempDir, baseName), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    expect(baseLines).toHaveLength(1)
  }, 15000)
})

describe('rotation.ts — retention sweep', () => {
  it('deletes files older than 14 days and keeps recent ones', async () => {
    const oldFile = join(tempDir, 'skillsmith-mcp-2020-01-01.jsonl')
    const recentFile = join(tempDir, 'skillsmith-mcp-2026-01-01.jsonl')
    writeFileSync(oldFile, '{}\n')
    writeFileSync(recentFile, '{}\n')

    const fifteenDaysAgoSec = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000
    const oneDayAgoSec = (Date.now() - 1 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(oldFile, fifteenDaysAgoSec, fifteenDaysAgoSec)
    utimesSync(recentFile, oneDayAgoSec, oneDayAgoSec)

    await pruneExpiredLogs()

    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(recentFile)).toBe(true)
  })

  it('does not delete directories, only files', async () => {
    const oldDir = join(tempDir, 'not-a-log-file')
    mkdirSync(oldDir)
    const fifteenDaysAgoSec = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(oldDir, fifteenDaysAgoSec, fifteenDaysAgoSec)

    await expect(pruneExpiredLogs()).resolves.toBeUndefined()
    expect(existsSync(oldDir)).toBe(true)
  })

  it('is a no-op (never throws) when the log directory does not exist', async () => {
    process.env.SKILLSMITH_LOG_DIR = join(tempDir, 'does-not-exist')
    await expect(pruneExpiredLogs()).resolves.toBeUndefined()
  })
})
