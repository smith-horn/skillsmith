/**
 * SMI-6531 (A1 step 1): the parked index is lock 4, the top of the order.
 *
 * Nothing ranks above lock 4, so the tracker can't observe from outside which
 * rank `appendParkedIndexLocked` / `compactParkedIndexLocked` pass (a lower
 * rank would be allowed inside lock 3 just the same). These tests spy on
 * `withFileLock` and assert the rank option directly.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileLockOptions } from '../../../src/config/file-lock.js'

const calls: Array<{ target: string; options: FileLockOptions | undefined }> = []

vi.mock('../../../src/config/file-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/file-lock.js')>()
  return {
    ...actual,
    withFileLock: ((target: string, label: string, fn: () => Promise<unknown>, options: never) => {
      calls.push({ target, options })
      return actual.withFileLock(target, label, fn, options)
    }) as typeof actual.withFileLock,
  }
})

const { appendParkedIndexLocked, compactParkedIndexLocked } =
  await import('../../../src/install/park-call.js')

let dir: string

beforeEach(() => {
  calls.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-ranks-parked-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the parked index lock is rank 4', () => {
  it('appendParkedIndexLocked takes its lock at rank 4, on the index path', async () => {
    const indexPath = path.join(dir, 'parked-index.jsonl')
    await appendParkedIndexLocked(indexPath, {
      opId: 'op-1',
      path: path.join(dir, 'parked-tree'),
      client: null,
      rootKey: null,
      kind: null,
      bytes: null,
      createdAt: null,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.target).toBe(indexPath)
    expect(calls[0]?.options?.rank).toBe('4')
  })

  it('compactParkedIndexLocked takes its lock at rank 4, on the index path', async () => {
    const indexPath = path.join(dir, 'parked-index.jsonl')
    fs.writeFileSync(indexPath, '')
    const result = await compactParkedIndexLocked(indexPath)
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.target).toBe(indexPath)
    expect(calls[0]?.options?.rank).toBe('4')
  })
})
