/**
 * SMI-6531 (A1 step 4c review round 2, owner decision): the park makes its
 * destination's ancestry durable before the rename. It `fsync`s
 * `.skillsmith-parked` (which holds the op directory's entry) and then the
 * parent (which holds `.skillsmith-parked`'s), through directory descriptors,
 * after the op directory is made and before `rename(2)`. A failure there stops
 * `park-failed` with nothing moved and leaves what a failed rename leaves: the
 * op directory as it was (empty when this park made it). Round 3 runs each
 * case from three starting states: fresh, the parked area already there with
 * a new op dir, and both already there (`opDirCreated: false`).
 *
 * Every fs call is observed on the `node:fs` default object, which the park
 * looks up at call time; each stub counts that it fired.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanup,
  errnoError,
  exists,
  guardOf,
  park,
  PARKED,
  simpleFixture,
} from './park-tree.helpers.js'

type AnyFn = (...a: unknown[]) => unknown
const table = fs as unknown as Record<string, AnyFn>

const roots: string[] = []
const restores: Array<() => void> = []
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r()
  for (const r of roots.splice(0)) cleanup(r)
})

function stub(name: string, impl: (orig: AnyFn) => AnyFn): void {
  const orig = table[name]!
  table[name] = impl(orig.bind(fs) as AnyFn)
  restores.push(() => {
    table[name] = orig
  })
}

/** Records `openSync` paths, `fsyncSync` of those, and `renameSync` sources, in order. */
function recordSyncs(): string[] {
  const events: string[] = []
  const fds = new Map<number, string>()
  stub('openSync', (orig) => (...a: unknown[]) => {
    const fd = orig(...a) as number
    fds.set(fd, String(a[0]))
    return fd
  })
  stub('fsyncSync', (orig) => (...a: unknown[]) => {
    events.push(`fsync ${fds.get(Number(a[0])) ?? '?'}`)
    return orig(...a)
  })
  stub('renameSync', (orig) => (...a: unknown[]) => {
    events.push(`rename ${String(a[0])}`)
    return orig(...a)
  })
  return events
}

const fixture = () => {
  const f = simpleFixture('park-presync-', 'bytes')
  roots.push(f.root)
  return f
}

type Pre = 'fresh' | 'parked area exists, op dir new' | 'both exist'
const OP = 'op-presync'

/**
 * Round 3 (governance mutation M1: syncing only when the op dir was created
 * passed every test): the destination's starting state, made by an earlier
 * park of a sibling tree. `both exist` reuses this test's opId, so the op dir
 * is already there with the sibling's copy in it.
 */
function arrange(f: ReturnType<typeof fixture>, pre: Pre): void {
  if (pre === 'fresh') return
  fs.mkdirSync(path.join(f.parent, 'other'))
  fs.writeFileSync(path.join(f.parent, 'other', 'o.txt'), 'other')
  const opId = pre === 'both exist' ? OP : 'op-earlier'
  const r = park(f.parent, 'other', { guardHash: guardOf(path.join(f.parent, 'other')), opId })
  expect(r.status).toBe('parked')
}

const PRES: Pre[] = ['fresh', 'parked area exists, op dir new', 'both exist']

describe('the park syncs its destination ancestry before the rename', () => {
  for (const pre of PRES) {
    it(`${pre}: fsyncs .skillsmith-parked, then the parent, then renames; reports both and opDirCreated`, () => {
      const f = fixture()
      arrange(f, pre)
      const events = recordSyncs()
      const r = park(f.parent, 'tree', { guardHash: guardOf(f.origin), opId: OP })
      expect(r.status).toBe('parked')
      const parked = path.join(f.parent, PARKED)
      expect(events.slice(0, 3)).toEqual([
        `fsync ${parked}`,
        `fsync ${f.parent}`,
        `rename ${f.origin}`,
      ])
      expect(r.preMoveSynced).toEqual([parked, f.parent])
      expect(r.opDirCreated).toBe(pre !== 'both exist')
      expect(exists(f.origin)).toBe(false)
      expect(path.dirname(String(r.path))).toBe(path.join(parked, OP))
    })

    for (const which of ['.skillsmith-parked', 'the parent'] as const) {
      it(`${pre}, a failed fsync of ${which}: stopped/park-failed with its errno, nothing moved`, () => {
        const f = fixture()
        arrange(f, pre)
        const parked = path.join(f.parent, PARKED)
        const target = which === 'the parent' ? f.parent : parked
        const opDir = path.join(parked, OP)
        const before = fs.existsSync(opDir) ? fs.readdirSync(opDir).sort() : []
        const fds = new Map<number, string>()
        let fired = 0
        let renamed = 0
        stub('openSync', (orig) => (...a: unknown[]) => {
          const fd = orig(...a) as number
          fds.set(fd, String(a[0]))
          return fd
        })
        stub('fsyncSync', (orig) => (...a: unknown[]) => {
          if (fds.get(Number(a[0])) === target) {
            fired++
            throw errnoError('EIO')
          }
          return orig(...a)
        })
        stub('renameSync', (orig) => (...a: unknown[]) => {
          renamed++
          return orig(...a)
        })
        const bytes = fs.readFileSync(path.join(f.origin, 'sub', 'f.txt'), 'utf8')
        const r = park(f.parent, 'tree', { guardHash: guardOf(f.origin), opId: OP })
        expect(fired).toBe(1)
        expect(r).toMatchObject({ status: 'stopped', reason: 'park-failed', errno: 'EIO' })
        expect(String(r.detail)).toContain(`${target} could not be synced before the move`)
        expect(r.preMoveSynced).toEqual(which === 'the parent' ? [parked] : [])
        expect(r.opDirCreated).toBe(pre !== 'both exist')
        expect(renamed).toBe(0)
        expect(exists(f.origin)).toBe(true)
        expect(fs.readFileSync(path.join(f.origin, 'sub', 'f.txt'), 'utf8')).toBe(bytes)
        // The op dir holds exactly what it held before: nothing of this tree moved into it.
        expect(fs.readdirSync(opDir).sort()).toEqual(before)
      })
    }
  }

  it('control: a failed rename leaves the same state (the empty op dir), so the sync failure matches it', () => {
    const f = fixture()
    stub('renameSync', () => () => {
      throw errnoError('EACCES')
    })
    const r = park(f.parent, 'tree', { guardHash: guardOf(f.origin), opId: 'op-rename' })
    expect(r).toMatchObject({ status: 'stopped', reason: 'park-failed', errno: 'EACCES' })
    expect(fs.readdirSync(path.join(f.parent, PARKED, 'op-rename'))).toEqual([])
    expect(exists(f.origin)).toBe(true)
  })
})
