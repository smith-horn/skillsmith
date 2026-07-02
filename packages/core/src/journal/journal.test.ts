/**
 * @fileoverview Unit tests for the change-journal writer + reader
 *               (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/core/journal/journal.test
 *
 * Covers two of the three P-5 invariants named in
 * docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md's
 * "Shared-State / Coordination Audit" table for `~/.skillsmith/journal`:
 *   - "journal module: concurrent-apply serialization test" (below)
 *   - "journal module: chain-verification test" (below)
 * The third (undo round-trip / refusal / scope fence) lives in
 * `@skillsmith/mcp-server`'s `tests/unit/undo-apply.test.ts`, since it
 * needs the mcp-server apply-family tools to produce a realistic changeset.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { appendJournalRecord, isCorruptTailError } from './writer.js'
import { verifyJournalChain } from './reader.js'
import { getJournalFilePath, resetJournalSessionIdForTests } from './path.js'
import type { JournalRecordInput } from './types.js'

let TEST_DIR: string
let PREV_OVERRIDE: string | undefined

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-journal-'))
  PREV_OVERRIDE = process.env['SKILLSMITH_JOURNAL_DIR']
  process.env['SKILLSMITH_JOURNAL_DIR'] = TEST_DIR
  resetJournalSessionIdForTests()
})

afterEach(() => {
  if (PREV_OVERRIDE !== undefined) process.env['SKILLSMITH_JOURNAL_DIR'] = PREV_OVERRIDE
  else delete process.env['SKILLSMITH_JOURNAL_DIR']
  if (TEST_DIR && fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true })
  resetJournalSessionIdForTests()
})

function fixtureRecord(suggestionId: string): JournalRecordInput {
  return {
    schema: 1,
    ts: Date.now(),
    session_id: 'test-session',
    tool: 'apply_namespace_rename',
    action: 'apply',
    suggestion_id: suggestionId,
    target_path: `/tmp/skill-${suggestionId}.md`,
    before_hash: 'before-hash',
    after_hash: 'after-hash',
    approval: 'apply',
    backup_ref: '/tmp/backup',
    detail: null,
  }
}

describe('journal chain verification', () => {
  it('a valid chain (multiple sequential appends) passes verification', async () => {
    await appendJournalRecord(fixtureRecord('a'))
    await appendJournalRecord(fixtureRecord('b'))
    await appendJournalRecord(fixtureRecord('c'))

    const result = await verifyJournalChain()

    expect(result.valid).toBe(true)
    expect(result.records).toHaveLength(3)
    expect(result.breakAt).toBeUndefined()
    // The chain is genuinely linked, not just three independent records.
    expect(result.records[1]!.prev_hash).toBe(result.records[0]!.record_hash)
    expect(result.records[2]!.prev_hash).toBe(result.records[1]!.record_hash)
  })

  it('an empty / never-written journal is a valid, empty chain (never throws)', async () => {
    const result = await verifyJournalChain()
    expect(result).toEqual({ valid: true, records: [] })
  })

  it('a tampered middle record breaks the chain at the correct index', async () => {
    await appendJournalRecord(fixtureRecord('a'))
    await appendJournalRecord(fixtureRecord('b'))
    await appendJournalRecord(fixtureRecord('c'))

    const filePath = getJournalFilePath()
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
    const tampered = JSON.parse(lines[1]!) as Record<string, unknown>
    tampered.suggestion_id = 'TAMPERED'
    lines[1] = JSON.stringify(tampered)
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')

    const result = await verifyJournalChain()

    expect(result.valid).toBe(false)
    expect(result.breakAt).toBe(1)
    // Everything before the tamper is still reported as verified evidence.
    expect(result.records).toHaveLength(1)
    expect(result.records[0]!.suggestion_id).toBe('a')
  })

  it('a corrupt tail line is reported via breakAt, never thrown', async () => {
    await appendJournalRecord(fixtureRecord('a'))
    await appendJournalRecord(fixtureRecord('b'))

    const filePath = getJournalFilePath()
    fs.appendFileSync(filePath, 'this is not json\n', 'utf-8')

    const outcome = await verifyJournalChain()

    expect(outcome.valid).toBe(false)
    expect(outcome.breakAt).toBe(2)
    expect(outcome.records).toHaveLength(2)
  })
})

describe('journal writer refuses to append past a corrupt tail (governance follow-up, SMI-5456)', () => {
  it('rejects with a typed isCorruptTailError when the last line is unparseable', async () => {
    await appendJournalRecord(fixtureRecord('a'))
    const filePath = getJournalFilePath()
    fs.appendFileSync(filePath, 'this is not json\n', 'utf-8')

    let caught: unknown
    try {
      await appendJournalRecord(fixtureRecord('b'))
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    expect(isCorruptTailError(caught)).toBe(true)
    expect((caught as Error).message).toMatch(/corrupt|unverifiable/)

    // The writer never wrote 'b' past the corrupt tail — the file still
    // has exactly the original record plus the corrupt line.
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
  })

  it('does not wedge the write queue for subsequent callers — a fixed tail lets the next append through', async () => {
    await appendJournalRecord(fixtureRecord('a'))
    const filePath = getJournalFilePath()
    fs.appendFileSync(filePath, 'this is not json\n', 'utf-8')

    await expect(appendJournalRecord(fixtureRecord('b'))).rejects.toSatisfy(isCorruptTailError)

    // Repair the tail (what a real operator/future recovery tool would do)
    // and prove the queue moved forward rather than staying wedged on the
    // rejected promise.
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
    lines.pop()
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')

    const record = await appendJournalRecord(fixtureRecord('c'))
    expect(record.suggestion_id).toBe('c')

    const result = await verifyJournalChain()
    expect(result.valid).toBe(true)
    expect(result.records.map((r) => r.suggestion_id)).toEqual(['a', 'c'])
  })
})

describe('journal concurrent-apply serialization (P-5 single-writer invariant)', () => {
  it('N concurrent journal writes produce N well-formed, correctly-chained records with no interleaved/torn lines', async () => {
    const N = 25
    // Fire all N appends without awaiting between them — simulates
    // apply_namespace_rename and apply_recommended_edit racing inside the
    // same server process.
    await Promise.all(
      Array.from({ length: N }, (_, i) => appendJournalRecord(fixtureRecord(`concurrent-${i}`)))
    )

    const filePath = getJournalFilePath()
    const raw = fs.readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.length > 0)

    // No torn/interleaved lines: every line parses as JSON on its own.
    expect(lines).toHaveLength(N)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    const result = await verifyJournalChain()
    expect(result.valid).toBe(true)
    expect(result.records).toHaveLength(N)

    // Every suggestion_id we wrote shows up exactly once — no lost or
    // duplicated writes from the race.
    const seen = new Set(result.records.map((r) => r.suggestion_id))
    expect(seen.size).toBe(N)
  })
})
