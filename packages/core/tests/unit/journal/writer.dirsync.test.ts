/**
 * SMI-6531 (A1 step 4a): the journal append makes the entries it creates
 * durable. When an append creates the journal file, the journal directory is
 * synced; when it also created directories, each created directory's parent is
 * synced first, top-down. A `failed` sync rejects the append; `unsupported`
 * does not. An append that creates nothing syncs no directory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/install/dir-sync.js', () => ({ syncDirectory: vi.fn() }))

const { syncDirectory } = await import('../../../src/install/dir-sync.js')
const { appendJournalRecord } = await import('../../../src/journal/writer.js')
const { resetJournalSessionIdForTests } = await import('../../../src/journal/path.js')
import type { JournalRecordInput } from '../../../src/journal/types.js'

const syncMock = vi.mocked(syncDirectory)
let base: string
let prevOverride: string | undefined

beforeEach(() => {
  syncMock.mockReset()
  syncMock.mockResolvedValue({ outcome: 'synced' })
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-journal-dirsync-'))
  prevOverride = process.env['SKILLSMITH_JOURNAL_DIR']
  resetJournalSessionIdForTests()
})

afterEach(() => {
  if (prevOverride !== undefined) process.env['SKILLSMITH_JOURNAL_DIR'] = prevOverride
  else delete process.env['SKILLSMITH_JOURNAL_DIR']
  fs.rmSync(base, { recursive: true, force: true })
  resetJournalSessionIdForTests()
})

function record(id: string): JournalRecordInput {
  return {
    schema: 1,
    ts: Date.now(),
    session_id: 'test-session',
    tool: 'apply_namespace_rename',
    action: 'apply',
    suggestion_id: id,
    target_path: `/tmp/skill-${id}.md`,
    before_hash: 'before-hash',
    after_hash: 'after-hash',
    approval: 'apply',
    backup_ref: '/tmp/backup',
    detail: null,
  }
}

function syncedDirs(): string[] {
  return syncMock.mock.calls.map((c) => c[0])
}

function lines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
}

describe('journal append: directory sync on create', () => {
  it('the first append syncs each created directory parent top-down, then the journal directory and its parent', async () => {
    const a = path.join(base, 'a')
    const b = path.join(a, 'b')
    const journalDir = path.join(b, 'journal')
    process.env['SKILLSMITH_JOURNAL_DIR'] = journalDir

    await appendJournalRecord(record('one'))

    expect(syncedDirs()).toEqual([base, a, b, journalDir, b])
    expect(lines(path.join(journalDir, 'journal.jsonl'))).toHaveLength(1)
  })

  it('a second append syncs no directory', async () => {
    const journalDir = path.join(base, 'a', 'journal')
    process.env['SKILLSMITH_JOURNAL_DIR'] = journalDir
    await appendJournalRecord(record('one'))
    syncMock.mockClear()

    await appendJournalRecord(record('two'))

    expect(syncMock).not.toHaveBeenCalled()
    expect(lines(path.join(journalDir, 'journal.jsonl'))).toHaveLength(2)
  })

  it('an existing journal directory without the file syncs that directory and its parent', async () => {
    // Another process made the directory and may not have synced its parent:
    // creating the file syncs both (A1 plan §3.3 step 11).
    const journalDir = path.join(base, 'journal')
    fs.mkdirSync(journalDir)
    process.env['SKILLSMITH_JOURNAL_DIR'] = journalDir

    await appendJournalRecord(record('one'))

    expect(syncedDirs()).toEqual([journalDir, base])
  })
})

describe('journal append: a directory sync that does not succeed', () => {
  it('a failed sync of a created directory parent rejects the append before the file is written', async () => {
    const journalDir = path.join(base, 'a', 'journal')
    process.env['SKILLSMITH_JOURNAL_DIR'] = journalDir
    // An uncommon code, so a hard-coded message cannot pass for propagation.
    syncMock.mockResolvedValueOnce({
      outcome: 'failed',
      code: 'EDQUOT',
      error: new Error('EDQUOT'),
    })

    await expect(appendJournalRecord(record('one'))).rejects.toThrow(/EDQUOT/)

    expect(fs.existsSync(path.join(journalDir, 'journal.jsonl'))).toBe(false)
  })

  it('a failed sync of the journal directory rejects the append, with the record kept in the file', async () => {
    const journalDir = path.join(base, 'journal')
    fs.mkdirSync(journalDir)
    process.env['SKILLSMITH_JOURNAL_DIR'] = journalDir
    syncMock.mockResolvedValueOnce({
      outcome: 'failed',
      code: 'EDQUOT',
      error: new Error('EDQUOT'),
    })

    await expect(appendJournalRecord(record('one'))).rejects.toThrow(/EDQUOT/)

    expect(lines(path.join(journalDir, 'journal.jsonl'))).toHaveLength(1)
    // The queue is not wedged: the next append runs (the file exists now, so no sync).
    await appendJournalRecord(record('two'))
    expect(lines(path.join(journalDir, 'journal.jsonl'))).toHaveLength(2)
  })

  it("a failed sync of the journal directory's parent rejects the append, with the record kept in the file", async () => {
    const journalDir = path.join(base, 'journal')
    fs.mkdirSync(journalDir)
    process.env['SKILLSMITH_JOURNAL_DIR'] = journalDir
    syncMock.mockResolvedValueOnce({ outcome: 'synced' }).mockResolvedValueOnce({
      outcome: 'failed',
      code: 'EDQUOT',
      error: new Error('EDQUOT'),
    })

    await expect(appendJournalRecord(record('one'))).rejects.toThrow(new RegExp(`${base}.*EDQUOT`))

    expect(syncedDirs()).toEqual([journalDir, base])
    expect(lines(path.join(journalDir, 'journal.jsonl'))).toHaveLength(1)
  })

  it('an unsupported sync does not reject the append', async () => {
    const journalDir = path.join(base, 'a', 'journal')
    process.env['SKILLSMITH_JOURNAL_DIR'] = journalDir
    syncMock.mockResolvedValue({ outcome: 'unsupported', code: 'EINVAL' })

    const written = await appendJournalRecord(record('one'))

    expect(written.suggestion_id).toBe('one')
    expect(syncedDirs()).toEqual([base, path.join(base, 'a'), journalDir, path.join(base, 'a')])
  })
})
