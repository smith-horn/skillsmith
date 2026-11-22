/**
 * SMI-6531 (A1 step 8-i-a-1): R2 and Q7 for uninstall (A1 plan §3.8 row 3).
 *
 * R2: 10 runs per root type (a directory, a regular file, a symlink to a
 * directory, a dangling symlink). The three-family delete spy sees no delete
 * aimed at the entry or inside the parked area, and every file hash present
 * before is present after, at the origin or in the parked area.
 *
 * Q7: a park that fails (the parked area's mkdir `EROFS` or `EACCES`, or the
 * rename itself `EACCES`) ends `stopped/park-failed` with its errno, the entry
 * untouched at its origin, the manifest entry kept, and no delete call.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PARKED,
  cleanupFixture,
  contentSnapshot,
  entryOf,
  errnoError,
  lostContent,
  makeFixture,
  stubFs,
  subjectDeletes,
  uninstall,
  withDeleteSpy,
} from './uninstall-park.helpers.js'
import type { RootKind, UFixture } from './uninstall-park.helpers.js'

type AnyFn = (...args: unknown[]) => unknown
const fixtures: UFixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) cleanupFixture(f)
})

describe('R2 row 3: uninstall deletes nothing (10 runs per root type)', () => {
  for (const kind of ['dir', 'file', 'symlink-dir', 'dangling'] as RootKind[]) {
    it(`${kind}: parked whole, no delete call, no content lost`, async () => {
      for (let i = 0; i < 10; i++) {
        const f = makeFixture(`uninstall-r2-${kind}-`, kind)
        fixtures.push(f)
        const before = contentSnapshot(f.root)
        const linkText = kind.includes('symlink') || kind === 'dangling'
        const text = linkText ? fs.readlinkSync(f.installPath) : null
        const { value: r, deletes } = await withDeleteSpy(() => uninstall(f))
        expect(r.success, r.message).toBe(true)
        expect(subjectDeletes(f, deletes)).toEqual([])
        // The manifest is meant to change (its entry is dropped); every other file is checked.
        const lost = lostContent(before, contentSnapshot(f.root))
        expect(lost.filter((p) => p !== path.join('.', 'state', 'manifest.json'))).toEqual([])
        const parked = String(r.parkedPath)
        expect(parked.startsWith(path.join(f.skillsDir, PARKED))).toBe(true)
        // The link itself moves, with its text; its target is not touched.
        if (text !== null) expect(fs.readlinkSync(parked)).toBe(text)
        if (kind === 'symlink-dir') {
          expect(fs.readFileSync(path.join(f.root, 'target', 'SKILL.md'), 'utf8')).toBe(
            '# linked\n'
          )
        }
        expect(fs.existsSync(f.installPath)).toBe(false)
      }
    })
  }
})

describe('Q7 row 3: a failed park deletes nothing and is not done', () => {
  const parkedArea = (f: UFixture): string => path.join(f.skillsDir, PARKED)
  const cases: [string, string, (f: UFixture) => () => void][] = [
    [
      "the parked area's mkdir fails EROFS",
      'EROFS',
      (f) =>
        stubFs('mkdirSync', (orig: AnyFn) => (...a: unknown[]) => {
          if (a[0] === parkedArea(f)) throw errnoError('EROFS')
          return orig(...a)
        }),
    ],
    [
      "the parked area's mkdir fails EACCES",
      'EACCES',
      (f) =>
        stubFs('mkdirSync', (orig: AnyFn) => (...a: unknown[]) => {
          if (a[0] === parkedArea(f)) throw errnoError('EACCES')
          return orig(...a)
        }),
    ],
    [
      'the rename out of the skills root fails EACCES (reached rename(2))',
      'EACCES',
      (f) =>
        stubFs('renameSync', (orig: AnyFn) => (...a: unknown[]) => {
          if (a[0] === f.installPath) throw errnoError('EACCES')
          return orig(...a)
        }),
    ],
  ]
  for (const [label, errno, install] of cases) {
    it(`${label}: stopped/park-failed, tree untouched (10 runs)`, async () => {
      for (let i = 0; i < 10; i++) {
        const f = makeFixture('uninstall-q7-')
        fixtures.push(f)
        const before = contentSnapshot(f.installPath)
        let restore: (() => void) | null = null
        try {
          const { value: r, deletes } = await withDeleteSpy(() =>
            uninstall(f, { seams: { beforePark: () => void (restore = install(f)) } })
          )
          expect(r.success).toBe(false)
          expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'park-failed', errno })
          expect(subjectDeletes(f, deletes)).toEqual([])
        } finally {
          ;(restore as (() => void) | null)?.()
        }
        expect(contentSnapshot(f.installPath)).toEqual(before)
        expect(entryOf(f)).toBeDefined()
      }
    })
  }
})
