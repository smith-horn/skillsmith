/**
 * SMI-7260 D2: re-read before a corruption verdict.
 *
 * A sql.js open that races a native checkpoint can read a torn image of an
 * intact file. To reproduce that deterministically, `readFileSync` for the
 * database path is replaced by a queue of byte images; the driver, sql.js and
 * both ADR-175 probes are real. Once the queue is empty the real file is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqlJsDatabase } from '../../src/db/drivers/sqljsDriver.js'
import { RETRY_DELAYS_MS } from '../../src/db/drivers/sqljsDriver.read.js'
import { DB_CORRUPT_CODE, DB_READ_UNSTABLE_CODE } from '../../src/db/db-errors.js'

const reads = vi.hoisted(() => ({ path: '', queue: [] as Buffer[], count: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] === reads.path) {
      reads.count += 1
      const substitute = reads.queue.shift()
      if (substitute !== undefined) return substitute
    }
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync }
})

let dir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smi7260-d2-'))
  reads.path = join(dir, 'skills.db')
  reads.queue = []
  reads.count = 0
})

afterEach(() => {
  reads.path = ''
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A healthy database image with enough rows to span several pages. */
async function goodImage(): Promise<Buffer> {
  const db = await createSqlJsDatabase(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
  const insert = db.prepare('INSERT INTO t (val) VALUES (?)')
  for (let i = 0; i < 400; i += 1) insert.run(`row-${i}`)
  const bytes = Buffer.from(db.export())
  db.close()
  return bytes
}

/** A copy whose later pages are damaged with `fill`; header and schema page intact. */
function damaged(good: Buffer, fill: number): Buffer {
  const copy = Buffer.from(good)
  for (let o = 4096; o < copy.length; o += 1) copy[o] = fill
  return copy
}

/** The file's real bytes: interception off, so a leftover substitute cannot answer. */
function bytesOnDisk(path: string): Buffer {
  const intercepted = reads.path
  reads.path = ''
  try {
    return readFileSync(path)
  } finally {
    reads.path = intercepted
  }
}

async function openError(path: string): Promise<{ code?: unknown } | undefined> {
  try {
    const db = await createSqlJsDatabase(path)
    db.close()
    return undefined
  } catch (error) {
    return error as { code?: unknown }
  }
}

describe('SMI-7260 D2: sql.js re-reads before refusing a database as corrupt', () => {
  it('accepts a torn first read once a re-read is healthy', async () => {
    const good = await goodImage()
    writeFileSync(reads.path, good)
    reads.queue = [damaged(good, 0xff)]

    const db = await createSqlJsDatabase(reads.path)
    try {
      expect(db.prepare<{ c: number }>('SELECT count(*) AS c FROM t').get()?.c).toBe(400)
    } finally {
      db.close()
    }
    // The torn image was read, refused, and then the real file was read.
    expect(reads.count).toBe(2)
  })

  it('still refuses a stably corrupt file as corrupt, without touching it', async () => {
    const corrupt = damaged(await goodImage(), 0xff)
    writeFileSync(reads.path, corrupt)

    const error = await openError(reads.path)
    expect(error?.code).toBe(DB_CORRUPT_CODE)
    // Two byte-identical failing reads are the verdict; no more reads after that.
    expect(reads.count).toBe(2)
    expect(bytesOnDisk(reads.path).equals(corrupt)).toBe(true)
  })

  it('refuses a file that changes on every read as unstable, not as corrupt', async () => {
    const good = await goodImage()
    const corrupt = damaged(good, 0xff)
    writeFileSync(reads.path, corrupt)
    // Every read differs from the one before it, and every one fails.
    reads.queue = [damaged(good, 0x11), damaged(good, 0x22), damaged(good, 0x33)]

    const error = await openError(reads.path)
    expect(error?.code).toBe(DB_READ_UNSTABLE_CODE)
    expect(error?.code).not.toBe(DB_CORRUPT_CODE)
    // The bound: one read plus one per retry, then it stops.
    expect(reads.count).toBe(RETRY_DELAYS_MS.length + 1)
    expect(bytesOnDisk(reads.path).equals(corrupt)).toBe(true)
  })
})
