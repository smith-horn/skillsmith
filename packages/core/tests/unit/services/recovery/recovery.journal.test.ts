/**
 * SMI-6531 (A1 step 6a-ii): `appendJournalRecordOnce` (T-J3's journal half,
 * A1 plan step 6): under lock 5 it scans every parseable line for this op's
 * `update` record, appends only when there is none, and syncs the journal
 * directory either way, including when this call did not create the file.
 * Control for the last part: a sync only when the append created the file
 * would sync nothing in the `present` and `existing file` cases below.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const synced: string[] = []
vi.mock('../../../../src/install/dir-sync.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/install/dir-sync.js')>()
  return {
    ...real,
    syncDirectory: async (dir: string) => {
      synced.push(dir)
      return real.syncDirectory(dir)
    },
  }
})

import { appendJournalRecordOnce } from '../../../../src/journal/writer.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  synced.length = 0
})

function journal(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'append-once-'))
  dirs.push(d)
  return path.join(d, 'journal', 'journal.jsonl')
}

const input = (opId: string) => ({
  schema: 1 as const,
  ts: 1,
  session_id: 's',
  tool: 'update',
  action: 'apply' as const,
  suggestion_id: opId,
  target_path: '/x',
  before_hash: 'a',
  after_hash: 'b',
  approval: 'update',
  backup_ref: '/b',
  detail: null,
})

const lines = (f: string) =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l !== '')

describe('appendJournalRecordOnce', () => {
  it('appends to an absent journal, then finds its own record: one line', async () => {
    const f = journal()
    expect((await appendJournalRecordOnce(input('op1'), { file: f })).outcome).toBe('appended')
    expect((await appendJournalRecordOnce(input('op1'), { file: f })).outcome).toBe('present')
    expect(lines(f)).toHaveLength(1)
  })

  it('syncs the journal directory when the file already existed (appended) and when present', async () => {
    const f = journal()
    await appendJournalRecordOnce(input('op0'), { file: f })
    synced.length = 0
    expect((await appendJournalRecordOnce(input('op1'), { file: f })).outcome).toBe('appended')
    expect(synced).toContain(path.dirname(f))
    synced.length = 0
    expect((await appendJournalRecordOnce(input('op1'), { file: f })).outcome).toBe('present')
    expect(synced).toContain(path.dirname(f))
    expect(lines(f)).toHaveLength(2)
  })

  it('a torn tail writes nothing and says so', async () => {
    const f = journal()
    await appendJournalRecordOnce(input('op0'), { file: f })
    fs.appendFileSync(f, '{"tool":"upd')
    const before = fs.readFileSync(f)
    expect((await appendJournalRecordOnce(input('op1'), { file: f })).outcome).toBe('torn-tail')
    expect(fs.readFileSync(f).equals(before)).toBe(true)
  })

  it('finds the record past a corrupt middle line (not only the verified chain)', async () => {
    const f = journal()
    await appendJournalRecordOnce(input('op1'), { file: f })
    fs.appendFileSync(f, 'not json at all\n')
    await appendJournalRecordOnce(input('op2'), { file: f }).catch(() => undefined)
    expect((await appendJournalRecordOnce(input('op1'), { file: f })).outcome).toBe('present')
    expect(lines(f).filter((l) => l.includes('"op1"'))).toHaveLength(1)
  })
})
