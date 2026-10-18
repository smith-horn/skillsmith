/**
 * SMI-6531 review round 1, F2/F3: `parkTree` reads the barrel's VERSION once,
 * before any filesystem work. If it is unavailable (undefined, or in its
 * temporal dead zone during a barrel initialization cycle), the park throws
 * and nothing moves (ADR-166 D-4). The sidecar's version itself is pinned in
 * park-tree.guard-hash.test.ts.
 */
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLIENT,
  CALLER,
  KIND,
  cleanup,
  exists,
  readText,
  simpleFixture,
  withAllFsTrapped,
} from './park-tree.helpers.js'

const BARREL = '../../../src/index.js'
const roots: string[] = []
afterEach(() => {
  vi.doUnmock(BARREL)
  vi.resetModules()
  for (const r of roots.splice(0)) cleanup(r)
})

async function parkWithBarrel(factory: () => Record<string, unknown>) {
  vi.resetModules()
  vi.doMock(BARREL, factory)
  const { parkTree } = await import('../../../src/install/park-tree.js')
  const f = simpleFixture('park-verread-')
  roots.push(f.root)
  // Calls pass through, so a park that touched the filesystem before reading
  // the version would really move the tree: the record and the origin show it.
  const run = withAllFsTrapped(
    () => {
      try {
        parkTree(f.parent, 'tree', { client: CLIENT, caller: CALLER, kind: KIND })
        return 'returned'
      } catch (e) {
        return (e as Error).message
      }
    },
    { passThrough: true }
  )
  return { f, ...run }
}

describe('an unavailable core version moves nothing', () => {
  for (const [label, factory] of [
    ['(b) VERSION undefined', () => ({ VERSION: undefined })],
    [
      '(c) VERSION in its TDZ (the getter throws ReferenceError)',
      () => ({
        get VERSION(): string {
          throw new ReferenceError("Cannot access 'VERSION' before initialization")
        },
      }),
    ],
  ] as const) {
    it(`${label}: parkTree throws "nothing was moved" with zero fs calls`, async () => {
      const { f, value, touched, deletes } = await parkWithBarrel(factory)
      expect(touched).toEqual([])
      expect(deletes).toEqual([])
      expect(value).toMatch(/core version was unavailable .*nothing was moved/)
      expect(readText(path.join(f.origin, 'sub', 'f.txt'))).toBe('USERBYTES')
      expect(exists(path.join(f.parent, '.skillsmith-parked'))).toBe(false)
    })
  }
})
