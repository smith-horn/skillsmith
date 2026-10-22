/**
 * SMI-6531 (owner decision 2026-10-22): lock 5 makes the journal append
 * cross-process safe. Two processes appending at once each read a chain head
 * and append a record naming it; without a lock between them, two records can
 * name the same head (a fork) or interleave (a torn line). With lock 5 the
 * result is one unbroken chain holding every record.
 *
 * Control: with the lock removed (the red test), the same run breaks the chain.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StuckLockError } from '../../../src/config/owned-lock.js'
import { JOURNAL_DIR_ENV_VAR } from '../../../src/journal/path.js'
import { verifyJournalChain } from '../../../src/journal/reader.js'
import { appendJournalRecord } from '../../../src/journal/writer.js'

const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'writer.lock5.child.mjs')
const PER_CHILD = 200

let dir: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-lock5-')))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

interface ChildOut {
  name: string
  ok: number
  failed: number
  firstFailure: string | null
}

function runChild(name: string, journalDir: string, go: string): Promise<ChildOut> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', childPath, name, String(PER_CHILD), go],
      { env: { ...process.env, SKILLSMITH_JOURNAL_DIR: journalDir } }
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`child ${name} exited ${code}: ${err}`))
      resolve(JSON.parse(out.trim()) as ChildOut)
    })
  })
}

describe('lock 5: concurrent appends from two processes', () => {
  it('produce one unbroken hash chain holding every record', async () => {
    const journalDir = path.join(dir, 'journal')
    const go = path.join(dir, 'go')
    const running = Promise.all([runChild('a', journalDir, go), runChild('b', journalDir, go)])
    // Both children are up and polling before the start signal.
    const deadline = Date.now() + 30_000
    while (!fs.existsSync(`${go}.ready-a`) || !fs.existsSync(`${go}.ready-b`)) {
      if (Date.now() > deadline) throw new Error('children never got ready')
      await new Promise((r) => setTimeout(r, 10))
    }
    fs.writeFileSync(go, '1')
    const outs = await running

    for (const o of outs) expect(o).toMatchObject({ ok: PER_CHILD, failed: 0 })
    const chain = await verifyJournalChain(path.join(journalDir, 'journal.jsonl'))
    expect(chain.breakAt).toBeUndefined()
    expect(chain.valid).toBe(true)
    expect(chain.records).toHaveLength(2 * PER_CHILD)
    // Both processes really interleaved: neither ran all its appends first.
    const owners = chain.records.map((r) => r.session_id)
    const switches = owners.filter((o, i) => i > 0 && o !== owners[i - 1]).length
    expect(switches).toBeGreaterThan(1)
    // The lock file is released after every append.
    expect(fs.existsSync(path.join(journalDir, 'journal.jsonl.lock'))).toBe(false)
  }, 60_000)
})

describe('lock 5: a lock that cannot be taken rejects the append', () => {
  it('an unparseable journal.jsonl.lock: the append rejects with StuckLockError, the journal byte-identical', async () => {
    const journalDir = path.join(dir, 'journal')
    const prev = process.env[JOURNAL_DIR_ENV_VAR]
    process.env[JOURNAL_DIR_ENV_VAR] = journalDir
    try {
      const input = {
        schema: 2,
        ts: 1,
        session_id: 's',
        tool: 'probe',
        action: 'apply' as const,
        suggestion_id: 'one',
        target_path: null,
        before_hash: null,
        after_hash: null,
        approval: null,
        backup_ref: null,
        detail: null,
      }
      await appendJournalRecord(input)
      const journal = path.join(journalDir, 'journal.jsonl')
      const before = fs.readFileSync(journal)
      fs.writeFileSync(path.join(journalDir, 'journal.jsonl.lock'), 'not a lock claim')

      const err = await appendJournalRecord({ ...input, suggestion_id: 'two' }).then(
        () => null,
        (e: unknown) => e
      )

      expect(err).toBeInstanceOf(StuckLockError)
      expect((err as StuckLockError).reason).toBe('unreclaimable_unparseable')
      expect(fs.readFileSync(journal).equals(before)).toBe(true)
      expect(fs.readFileSync(path.join(journalDir, 'journal.jsonl.lock'), 'utf8')).toBe(
        'not a lock claim'
      )
    } finally {
      if (prev === undefined) delete process.env[JOURNAL_DIR_ENV_VAR]
      else process.env[JOURNAL_DIR_ENV_VAR] = prev
    }
  })
})
