/**
 * SMI-6531 (A1 step 1): a `LockOrderError` raised inside a parked-index call
 * is a programming error and must propagate. `compactParkedIndexLocked` used
 * to return it as `{ ok: false, errno }` and `parkTreeIndexed` recorded it as
 * `indexError`; both now rethrow it. Every other error keeps its handling.
 *
 * The inner index call is replaced by a hook (pass-through unless a test sets
 * one), so the error is raised exactly where a lock-order refusal would be.
 */
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  compact: null as null | (() => never),
  append: null as null | (() => never),
}))

vi.mock('../../../src/install/parked-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/install/parked-index.js')>()
  return {
    ...actual,
    compactParkedIndex: (...args: Parameters<typeof actual.compactParkedIndex>) =>
      hooks.compact ? hooks.compact() : actual.compactParkedIndex(...args),
    appendParkedIndex: (...args: Parameters<typeof actual.appendParkedIndex>) =>
      hooks.append ? hooks.append() : actual.appendParkedIndex(...args),
  }
})

import { LockOrderError } from '../../../src/config/lock-tracker.js'
import { compactParkedIndexLocked } from '../../../src/install/park-call.js'
import { cleanup, parkIndexed, simpleFixture } from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  hooks.compact = null
  hooks.append = null
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = () => {
  const f = simpleFixture('park-call-lock-order-')
  roots.push(f.root)
  return f
}
const lockOrderError = () => new LockOrderError('held-while-planning', 'x')

describe('compactParkedIndexLocked', () => {
  it('rethrows a LockOrderError instead of returning it as an errno', async () => {
    const f = fixture()
    hooks.compact = () => {
      throw lockOrderError()
    }
    await expect(
      compactParkedIndexLocked(path.join(f.root, 'parked-index.jsonl'))
    ).rejects.toBeInstanceOf(LockOrderError)
  })

  it('control: an ordinary error is still returned as { ok: false, errno }', async () => {
    const f = fixture()
    hooks.compact = () => {
      throw new Error('boom')
    }
    const r = await compactParkedIndexLocked(path.join(f.root, 'parked-index.jsonl'))
    expect(r).toEqual({ ok: false, errno: 'boom' })
  })
})

describe('parkTreeIndexed', () => {
  it('rethrows a LockOrderError instead of recording it as indexError', async () => {
    const f = fixture()
    hooks.append = () => {
      throw lockOrderError()
    }
    await expect(
      parkIndexed(f.parent, 'tree', { indexPath: path.join(f.root, 'parked-index.jsonl') })
    ).rejects.toBeInstanceOf(LockOrderError)
  })

  it('control: an ordinary append error is still recorded as indexError on a parked result', async () => {
    const f = fixture()
    hooks.append = () => {
      throw new Error('boom')
    }
    const r = await parkIndexed(f.parent, 'tree', {
      indexPath: path.join(f.root, 'parked-index.jsonl'),
    })
    expect(r.status).toBe('parked')
    expect(r.indexError).toBe('boom')
  })
})
