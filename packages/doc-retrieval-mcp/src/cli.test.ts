/**
 * SMI-5793 — doc-retrieval reindex observability: cli.ts reindex branch tests.
 *
 * Exercises the real persistence wiring end-to-end: the actual SMI-5615
 * logger (rotation.ts) writes real JSONL lines, and the actual
 * reindex-state.ts read/write/recordRun functions persist a real
 * reindex.state file — both pointed at one shared per-file temp dir via
 * SKILLSMITH_STATE_DIR_OVERRIDE. Only the genuinely external/expensive
 * collaborators are mocked: runIndexer (real vector-db indexing),
 * probeEmbeddingCapability (model warm-up), `git rev-parse` (determinism),
 * and resolveMainRepoKey (isolates each test's state entry from both the
 * ambient repo's real worktree list AND from every other test in this file,
 * via a unique per-test key — see beforeEach).
 *
 * One shared SKILLSMITH_STATE_DIR_OVERRIDE for the whole file, not reset
 * per-test: packages/core/src/logging/rotation.ts's per-surface write
 * stream is a module-level singleton, and its test-only reset hook
 * (`__resetLoggingStateForTests`) isn't part of the public
 * `@skillsmith/core/logging` export surface, so a cross-package consumer
 * like this file can't reach it — re-pointing the override mid-file would
 * silently leave the open stream writing into an already-removed directory
 * (rotation.ts only reopens on a calendar-day change or a size-cap
 * rollover). Log-content assertions therefore poll for the LAST matching
 * line in the shared file (vi.waitFor) rather than assuming an exact line
 * count or an immediate synchronous write — logger.info()/error() hand the
 * disk write off fire-and-forget (see logger.ts's F2/F3 doc comment).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(() => 'deadbeefcafefeed1234\n') }
})

vi.mock('./indexer.js', () => ({
  runIndexer: vi.fn(),
}))

vi.mock('@skillsmith/core/embeddings/probe', () => ({
  probeEmbeddingCapability: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./retrieval-log/reindex-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retrieval-log/reindex-state.js')>()
  return { ...actual, resolveMainRepoKey: vi.fn() }
})

import { runIndexer, type IndexResult } from './indexer.js'
import {
  readEntry,
  resolveMainRepoKey,
  resolveReindexStatePath,
} from './retrieval-log/reindex-state.js'

let tempDir: string
let originalStateOverride: string | undefined
let originalLogLevel: string | undefined

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skillsmith-cli-reindex-test-'))
  originalStateOverride = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
  originalLogLevel = process.env.SKILLSMITH_LOG_LEVEL
  process.env.SKILLSMITH_STATE_DIR_OVERRIDE = tempDir
})

afterAll(() => {
  if (originalStateOverride === undefined) delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
  else process.env.SKILLSMITH_STATE_DIR_OVERRIDE = originalStateOverride
  if (originalLogLevel === undefined) delete process.env.SKILLSMITH_LOG_LEVEL
  else process.env.SKILLSMITH_LOG_LEVEL = originalLogLevel
  rmSync(tempDir, { recursive: true, force: true })
})

let currentKey: string

beforeEach(() => {
  // Unique key per test — isolates each test's reindex.state entry from
  // every other test sharing the same on-disk state file.
  currentKey = `test-key-${randomUUID()}`
  vi.mocked(resolveMainRepoKey).mockReturnValue(currentKey)
})

afterEach(() => {
  vi.mocked(runIndexer).mockReset()
})

function readLastLogRecord(): Record<string, unknown> {
  const logDir = join(tempDir, 'logs')
  const files = readdirSync(logDir).filter((f) => f.startsWith('skillsmith-doc-retrieval-'))
  expect(files.length).toBeGreaterThan(0)
  const content = readFileSync(join(logDir, files[0]), 'utf8')
  const lines = content.split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
}

async function waitForLastLogRecordEvent(event: string): Promise<Record<string, unknown>> {
  return vi.waitFor(
    () => {
      const record = readLastLogRecord()
      expect(record.event).toBe(event)
      return record
    },
    { timeout: 2000, interval: 20 }
  )
}

describe('cli.ts — reindex branch (SMI-5793)', () => {
  it('success: persists a reindex_run JSONL record and a success:true reindex.state entry', async () => {
    const result: IndexResult = {
      mode: 'incremental',
      filesScanned: 4,
      chunksUpserted: 4,
      chunksDeleted: 0,
      durationMs: 321,
    }
    vi.mocked(runIndexer).mockResolvedValueOnce(result)

    const { main } = await import('./cli.js')
    await main(['node', 'cli.js', 'reindex'])

    const record = await waitForLastLogRecordEvent('reindex_run')
    expect(record.surface).toBe('doc-retrieval')
    expect(record.level).toBe('info')
    const details = record.details as Record<string, unknown>
    expect(details.filesScanned).toBe(4)
    expect(details.chunksUpserted).toBe(4)
    expect(details.mode).toBe('incremental')

    const stateEntry = readEntry(currentKey, resolveReindexStatePath())
    expect(stateEntry?.success).toBe(true)
    expect(stateEntry?.filesScanned).toBe(4)
    expect(stateEntry?.consecutiveZeroTouchRuns).toBe(0)
  })

  it('failure: mocked runIndexer throw persists a success:false record to both JSONL and state, and main() rejects (preserving the exit-1 contract)', async () => {
    vi.mocked(runIndexer).mockRejectedValueOnce(new Error('vector db locked'))

    const { main } = await import('./cli.js')
    await expect(main(['node', 'cli.js', 'reindex'])).rejects.toThrow('vector db locked')

    const record = await waitForLastLogRecordEvent('reindex_run_failed')
    expect(record.level).toBe('error')

    const stateEntry = readEntry(currentKey, resolveReindexStatePath())
    expect(stateEntry?.success).toBe(false)
    expect(stateEntry?.errorReason).toBe('vector db locked')
    expect(stateEntry?.filesScanned).toBe(0)
  })

  it('--quiet suppresses console output but not persistence', async () => {
    const result: IndexResult = {
      mode: 'incremental',
      filesScanned: 1,
      chunksUpserted: 1,
      chunksDeleted: 0,
      durationMs: 10,
    }
    vi.mocked(runIndexer).mockResolvedValueOnce(result)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      const { main } = await import('./cli.js')
      await main(['node', 'cli.js', 'reindex', '--quiet'])

      expect(logSpy).not.toHaveBeenCalled()

      await waitForLastLogRecordEvent('reindex_run')
      const stateEntry = readEntry(currentKey, resolveReindexStatePath())
      expect(stateEntry?.success).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('--full sets mode to full on both the JSONL record and the state entry', async () => {
    const result: IndexResult = {
      mode: 'full',
      filesScanned: 20,
      chunksUpserted: 20,
      chunksDeleted: 5,
      durationMs: 999,
    }
    vi.mocked(runIndexer).mockResolvedValueOnce(result)

    const { main } = await import('./cli.js')
    await main(['node', 'cli.js', 'reindex', '--full'])
    expect(runIndexer).toHaveBeenCalledWith('full', { quiet: false })

    await waitForLastLogRecordEvent('reindex_run')
    const stateEntry = readEntry(currentKey, resolveReindexStatePath())
    expect(stateEntry?.mode).toBe('full')
  })

  it('holds the zero-touch streak steady across two runs with an unchanged sha (execFileSync is mocked to a fixed sha)', async () => {
    vi.mocked(runIndexer).mockResolvedValueOnce({
      mode: 'incremental',
      filesScanned: 0,
      chunksUpserted: 0,
      chunksDeleted: 0,
      durationMs: 10,
    })
    const { main } = await import('./cli.js')
    await main(['node', 'cli.js', 'reindex'])
    await waitForLastLogRecordEvent('reindex_run')
    const first = readEntry(currentKey, resolveReindexStatePath())
    // First-ever run for this key — no prior sha to advance from, so
    // recordRun's "unchanged sha" branch holds the streak at 0.
    expect(first?.consecutiveZeroTouchRuns).toBe(0)

    vi.mocked(runIndexer).mockResolvedValueOnce({
      mode: 'incremental',
      filesScanned: 0,
      chunksUpserted: 0,
      chunksDeleted: 0,
      durationMs: 10,
    })
    await main(['node', 'cli.js', 'reindex'])
    await waitForLastLogRecordEvent('reindex_run')
    const second = readEntry(currentKey, resolveReindexStatePath())
    // execFileSync is mocked to always return the same sha, so this second
    // run's sha equals the first's — no advancement, streak holds steady
    // rather than incrementing (see reindex-state.test.ts's recordRun suite
    // for the full transition table with distinct shas).
    expect(second?.consecutiveZeroTouchRuns).toBe(0)
  })
})
