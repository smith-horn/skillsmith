/**
 * SMI-6531 (A1 step 3a): the parked-area helper reports whether its mkdir
 * created the area, and every park result after the area step carries it as
 * `parkedAreaCreated` (A1 plan §3.2: only a creating mkdir prints the
 * `.gitignore` hint; park-caller rows 13 and 14 run the helper first).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureParkedRoot } from '../../../src/install/park-tree.destination.js'
import {
  PARKED,
  cleanup,
  errnoError,
  exists,
  guardOf,
  park,
  simpleFixture,
  withAllFsTrapped,
  withFsStub,
  writeAfterRename,
} from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = () => {
  const f = simpleFixture('park-area-')
  roots.push(f.root)
  return f
}
const addTree = (parent: string, name: string) => {
  fs.mkdirSync(path.join(parent, name), { recursive: true })
  fs.writeFileSync(path.join(parent, name, 'f.txt'), name)
}

describe('parkedAreaCreated', () => {
  it('true for the park whose mkdir made the area, false for the next park into it', () => {
    const f = fixture()
    addTree(f.parent, 'second')
    expect(exists(path.join(f.parent, PARKED))).toBe(false)
    const first = park(f.parent, 'tree')
    expect(first.status).toBe('parked')
    expect(first.parkedAreaCreated).toBe(true)
    const second = park(f.parent, 'second')
    expect(second.status).toBe('parked')
    expect(second.parkedAreaCreated).toBe(false)
  })

  it('a caller that runs the helper first gets created true, and the park then reports false', () => {
    const f = fixture()
    const area = ensureParkedRoot(f.parent)
    expect(area.ok && area.created).toBe(true)
    const again = ensureParkedRoot(f.parent)
    expect(again.ok && again.created).toBe(false)
    const r = park(f.parent, 'tree')
    expect(r.status).toBe('parked')
    expect(r.parkedAreaCreated).toBe(false)
  })

  it('a park that fails after creating the area still reports it created', () => {
    const f = fixture()
    const r = withFsStub(
      'renameSync',
      (orig) =>
        (...args: unknown[]) => {
          if (args[0] === f.origin) throw errnoError('EXDEV')
          return orig(...args)
        },
      () => park(f.parent, 'tree')
    )
    expect(r.status).toBe('stopped')
    expect(r.errno).toBe('EXDEV')
    expect(r.parkedAreaCreated).toBe(true)
    expect(exists(path.join(f.parent, PARKED))).toBe(true)
  })

  it('held and kept results after the area step carry it too', () => {
    const f = fixture()
    const held = withFsStub('renameSync', writeAfterRename(f.origin), () =>
      park(f.parent, 'tree', { guardHash: guardOf(f.origin) })
    )
    expect(held.status).toBe('held')
    expect(held.parkedAreaCreated).toBe(true)
    // A pre-made op directory that is a symlink: kept/park-destination-changed,
    // after the (now existing) area was validated.
    addTree(f.parent, 'other')
    fs.symlinkSync(f.root, path.join(f.parent, PARKED, 'op-link'))
    const kept = park(f.parent, 'other', { opId: 'op-link' })
    expect(kept.status).toBe('kept')
    expect(kept.reason).toBe('park-destination-changed')
    expect(kept.parkedAreaCreated).toBe(false)
  })

  it('a refusal at the area step reports false when the area already existed', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.parent, PARKED), 'a file')
    const r = park(f.parent, 'tree')
    expect(r.status).toBe('stopped')
    expect(r.detail).toBe('trash-unusable')
    expect(r.parkedAreaCreated).toBe(false)
  })

  it('a refusal at the area step after its own mkdir still reports true', () => {
    const f = fixture()
    const area = path.join(f.parent, PARKED)
    const failLstat =
      (orig: (...a: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        if (args[0] === area) throw errnoError('EIO')
        return orig(...args)
      }
    const r = withFsStub('lstatSync', failLstat, () => park(f.parent, 'tree'))
    expect(r.status).toBe('stopped')
    expect(r.errno).toBe('EIO')
    expect(r.parkedAreaCreated).toBe(true)
    expect(exists(area)).toBe(true)
    expect(exists(f.origin)).toBe(true)
  })

  it('null when the park stops before the area step, and no area is made', () => {
    const f = fixture()
    const r = park(f.parent, 'no-such-entry')
    expect(r.status).toBe('stopped')
    expect(r.parkedAreaCreated).toBe(null)
    expect(exists(path.join(f.parent, PARKED))).toBe(false)
  })
})

describe('ensureParkedRoot', () => {
  it('refuses a relative parent with a TypeError before any filesystem work', () => {
    const f = fixture()
    const rel = path.relative(process.cwd(), f.parent)
    const { value, touched } = withAllFsTrapped(() => {
      try {
        ensureParkedRoot(rel)
        return 'returned'
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`
      }
    })
    expect(value).toBe(
      `TypeError: ensureParkedRoot: parentAbs must be an absolute path, got ${JSON.stringify(rel)}`
    )
    expect(touched).toEqual([])
  })

  it('refuses a non-string parent, rendering only its type', () => {
    expect(() => ensureParkedRoot(undefined as never)).toThrow(
      'ensureParkedRoot: parentAbs must be an absolute path, got undefined'
    )
  })

  it('an existing non-directory at the area path is refused, not reported as created', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.parent, PARKED), 'a file')
    expect(ensureParkedRoot(f.parent)).toEqual({
      ok: false,
      errno: null,
      detail: 'trash-unusable',
      created: false,
    })
  })
})
