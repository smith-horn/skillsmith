/**
 * SMI-6531 (A1 step 6c-ii-b): `assignLocks` (UD62, UD63; D12, D13). Real
 * directories; the listing is built with `listingOf`, holding only what
 * `assignLocks` reads.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parkedLockPath } from '../../../src/config/file-lock.parked.js'
import { rootKeyFor } from '../../../src/install/prune.classify.js'
import { assignLocks } from '../../../src/services/skill-backups.locks.js'
import { mkBase } from './skill-backups.helpers.js'
import { EMOJI, FF5A, listingOf, orderingRoots } from './skill-backups.locks.fixtures.js'

let base: string
let state: string
beforeEach(() => {
  base = mkBase('sbk-locks-')
  state = path.join(base, 'state')
  fs.mkdirSync(state, { recursive: true })
})
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

const mkdir = (...p: string[]): string => {
  const d = path.join(...p)
  fs.mkdirSync(d, { recursive: true })
  return fs.realpathSync(d)
}

/** `<state>/backups/update/claude-code/<rootKey>/<dirName>`, created. */
const backupArea = (
  rootKey: string,
  dirName = 'foo',
  client = 'claude-code'
): { keyDir: string; area: string } => {
  const area = mkdir(state, 'backups', 'update', client, rootKey, dirName)
  return { keyDir: path.dirname(area), area }
}

describe('assignLocks: parked copies in a discovered root', () => {
  it('takes lock 1 of that root', async () => {
    const root = mkdir(base, 'skills')
    const copy = path.join(root, '.skillsmith-parked', 'op', 'foo-aaaaaaaa')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        parked: [
          {
            copyPath: copy,
            kind: 'uninstall',
            skillsRoot: root,
            areaDir: path.dirname(path.dirname(copy)),
          },
        ],
      })
    )
    expect(m.get(copy)).toEqual({
      kind: 'lock1',
      path: path.join(root, '.skillsmith-writes.lock'),
      root,
    })
  })

  it('a root that cannot be resolved is unknown, never lock 1 of an unresolved spelling', async () => {
    const root = path.join(base, 'gone-root')
    const copy = path.join(root, '.skillsmith-parked', 'op', 'foo-aaaaaaaa')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        parked: [
          {
            copyPath: copy,
            kind: 'uninstall',
            skillsRoot: root,
            areaDir: path.dirname(path.dirname(copy)),
          },
        ],
      })
    )
    expect(m.get(copy)).toMatchObject({ kind: 'unknown' })
  })
})

describe('assignLocks: backup copies (UD62, D12)', () => {
  it('M-L1: a gone root takes lock 1prime of <client>/<rootKey>/, not of <dirName>', async () => {
    const gone = path.join(base, 'gone-root')
    const { keyDir, area } = backupArea(rootKeyFor(gone))
    const copy = path.join(area, 'op1')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        backups: [{ copyPath: copy, skillsDir: gone, areaPath: area }],
      })
    )
    const got = m.get(copy)
    expect(got).toEqual({
      kind: 'lock1prime',
      path: parkedLockPath(state, keyDir),
      areaReal: keyDir,
    })
    expect(got).not.toMatchObject({ path: parkedLockPath(state, area) })
  })

  it('a root that binds takes lock 1 of the root', async () => {
    const root = mkdir(base, 'skills')
    const { area } = backupArea(rootKeyFor(root))
    const copy = path.join(area, 'op1')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        backups: [{ copyPath: copy, skillsDir: root, areaPath: area }],
      })
    )
    expect(m.get(copy)).toEqual({
      kind: 'lock1',
      path: path.join(root, '.skillsmith-writes.lock'),
      root,
    })
  })

  it('D12: a staging-unsafe root is unknown, not lock 1prime', async () => {
    const root = mkdir(base, 'skills')
    fs.writeFileSync(path.join(root, '.skillsmith-staging'), 'a file where ST should be')
    const { area } = backupArea(rootKeyFor(root))
    const copy = path.join(area, 'op1')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        backups: [{ copyPath: copy, skillsDir: root, areaPath: area }],
      })
    )
    expect(m.get(copy)).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('staging-unsafe'),
    })
  })

  it('D12: a root whose realpath no longer equals the sidecar skillsDir is unknown', async () => {
    const elsewhere = mkdir(base, 'elsewhere')
    const link = path.join(base, 'link')
    fs.symlinkSync(elsewhere, link)
    const { area } = backupArea(rootKeyFor(link))
    const copy = path.join(area, 'op1')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        backups: [{ copyPath: copy, skillsDir: link, areaPath: area }],
      })
    )
    expect(m.get(copy)).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('now resolves'),
    })
  })

  it('D12: a root that is a file, and a copy with no sidecar skillsDir, are unknown', async () => {
    const file = path.join(base, 'a-file')
    fs.writeFileSync(file, 'x')
    const { area } = backupArea(rootKeyFor(file))
    const c1 = path.join(area, 'op1')
    const c2 = path.join(area, 'op2')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        backups: [
          { copyPath: c1, skillsDir: file, areaPath: area },
          { copyPath: c2, skillsDir: null, areaPath: area },
        ],
      })
    )
    expect(m.get(c1)?.kind).toBe('unknown')
    expect(m.get(c2)?.kind).toBe('unknown')
  })
})

describe("Major 2: a backup tree's lock follows its sidecar root only when the sidecar matches its area", () => {
  it("control: a sidecar naming the area's own root and client takes lock 1 of that root", async () => {
    const rootA = mkdir(base, 'rootA')
    const { area } = backupArea(rootKeyFor(rootA))
    const copy = path.join(area, 'op-M')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        backups: [{ copyPath: copy, skillsDir: rootA, areaPath: area }],
      })
    )
    expect(m.get(copy)).toEqual({
      kind: 'lock1',
      path: path.join(rootA, '.skillsmith-writes.lock'),
      root: rootA,
    })
  })

  it("P4: a tree in rootA's area whose sidecar names rootB is unknown, never lock 1 of rootB", async () => {
    const rootA = mkdir(base, 'rootA')
    const rootB = mkdir(base, 'rootB')
    const { area } = backupArea(rootKeyFor(rootA))
    const copy = path.join(area, 'op-M')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        backups: [{ copyPath: copy, skillsDir: rootB, areaPath: area }],
      })
    )
    expect(m.get(copy)).toEqual({
      kind: 'unknown',
      reason: expect.stringContaining('its root does not pick the lock'),
    })
  })

  it("a sidecar naming another client than the area's is unknown, and so is one naming no client", async () => {
    const rootA = mkdir(base, 'rootA')
    const { area } = backupArea(rootKeyFor(rootA))
    const c1 = path.join(area, 'op-1')
    const c2 = path.join(area, 'op-2')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        backups: [
          { copyPath: c1, skillsDir: rootA, areaPath: area, sidecarClient: 'cursor' },
          { copyPath: c2, skillsDir: rootA, areaPath: area, sidecarClient: null },
        ],
      })
    )
    expect(m.get(c1)).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('"cursor"'),
    })
    expect(m.get(c2)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('null') })
  })
})

describe('assignLocks: index-only parked areas (UD63, D13)', () => {
  const area = (): string => mkdir(base, 'author-init', '.skillsmith-parked')
  const copyIn = (a: string): string => path.join(a, 'op', 'foo-aaaaaaaa')
  const run = async (
    indexKind: string | null,
    sidecarKind: string | null
  ): ReturnType<typeof assignLocks> => {
    const a = area()
    const c = copyIn(a)
    return assignLocks(
      listingOf({
        stateRoot: state,
        parked: [{ copyPath: c, kind: sidecarKind, skillsRoot: null, areaDir: a }],
        index: [{ copyPath: c, kind: indexKind, stateRoot: state }],
      })
    )
  }

  it('M-L2: init-rollback takes lock 1prime of the area', async () => {
    const m = await run('init-rollback', 'init-rollback')
    const a = area()
    expect(m.get(copyIn(a))).toEqual({
      kind: 'lock1prime',
      path: parkedLockPath(state, a),
      areaReal: a,
    })
  })

  it('companion-rollback takes lock 1prime of the area', async () => {
    const m = await run('companion-rollback', 'companion-rollback')
    expect([...m.values()][0]?.kind).toBe('lock1prime')
  })

  it('agent-uninstall takes lock 1prime of the area (UD63, PLAN:235)', async () => {
    const m = await run('agent-uninstall', 'agent-uninstall')
    const a = area()
    expect(m.get(copyIn(a))).toEqual({
      kind: 'lock1prime',
      path: parkedLockPath(state, a),
      areaReal: a,
    })
  })

  it("UD63: any other kind takes lock 1 of the area's parent, bound read-only", async () => {
    const m = await run('install-rollback', 'install-rollback')
    const root = path.dirname(area())
    expect([...m.values()][0]).toEqual({
      kind: 'lock1',
      path: path.join(root, '.skillsmith-writes.lock'),
      root,
    })
  })

  it('UD63: an area under <root>/.skillsmith-staging/ takes lock 1 of <root>', async () => {
    const root = mkdir(base, 'ws-root')
    const a = mkdir(root, '.skillsmith-staging', '.skillsmith-parked')
    const c = copyIn(a)
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        parked: [{ copyPath: c, kind: 'uninstall', skillsRoot: null, areaDir: a }],
        index: [{ copyPath: c, kind: 'uninstall', stateRoot: state }],
      })
    )
    expect(m.get(c)).toEqual({
      kind: 'lock1',
      path: path.join(root, '.skillsmith-writes.lock'),
      root,
    })
  })

  it('UD63: a parent root that does not bind read-only is unknown, kept and named', async () => {
    const a = area()
    fs.writeFileSync(path.join(path.dirname(a), '.skillsmith-staging'), 'a file where ST should be')
    const c = copyIn(a)
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        parked: [{ copyPath: c, kind: 'install-rollback', skillsRoot: null, areaDir: a }],
        index: [{ copyPath: c, kind: 'install-rollback', stateRoot: state }],
      })
    )
    expect(m.get(c)).toEqual({
      kind: 'unknown',
      reason: expect.stringContaining('does not bind read-only (staging-unsafe'),
    })
  })

  it('D13: a null, unknown or disputed index kind is unknown', async () => {
    expect([...(await run(null, 'init-rollback')).values()][0]?.kind).toBe('unknown')
    expect([...(await run('bogus-kind', 'bogus-kind')).values()][0]?.kind).toBe('unknown')
    expect([...(await run('init-rollback', 'install-rollback')).values()][0]?.kind).toBe('unknown')
    expect([...(await run('init-rollback', null)).values()][0]?.kind).toBe('unknown')
  })

  it('an area copy with no index line is unknown', async () => {
    const a = area()
    const c = copyIn(a)
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        parked: [{ copyPath: c, kind: 'init-rollback', skillsRoot: null, areaDir: a }],
      })
    )
    expect(m.get(c)?.kind).toBe('unknown')
  })

  it('index lines for one copy from two state roots are unknown: no single locks/ directory applies', async () => {
    const a = area()
    const c = copyIn(a)
    const other = mkdir(base, 'state-two')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        parked: [{ copyPath: c, kind: 'init-rollback', skillsRoot: null, areaDir: a }],
        index: [
          { copyPath: c, kind: 'init-rollback', stateRoot: state },
          { copyPath: c, kind: 'init-rollback', stateRoot: other },
        ],
      })
    )
    expect(m.get(c)).toMatchObject({ kind: 'unknown' })
  })
})

describe('assignLocks: coverage and order', () => {
  it('gives every listed copy exactly one entry', async () => {
    const root = mkdir(base, 'skills')
    const { area: ba } = backupArea('eeeeeeeeeeeeeeee')
    const pc = path.join(root, '.skillsmith-parked', 'op', 'foo-aaaaaaaa')
    const bc = path.join(ba, 'op1')
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        parked: [
          {
            copyPath: pc,
            kind: 'uninstall',
            skillsRoot: root,
            areaDir: path.dirname(path.dirname(pc)),
          },
        ],
        backups: [{ copyPath: bc, skillsDir: null, areaPath: ba }],
      })
    )
    expect([...m.keys()].sort()).toEqual([bc, pc].sort())
  })

  it('a copy listed twice is unknown, never silently one of its two entries', async () => {
    const root = mkdir(base, 'skills')
    const pc = path.join(root, '.skillsmith-parked', 'op', 'foo-aaaaaaaa')
    const one = {
      copyPath: pc,
      kind: 'uninstall',
      skillsRoot: root,
      areaDir: path.dirname(path.dirname(pc)),
    }
    const m = await assignLocks(listingOf({ stateRoot: state, parked: [one, one] }))
    expect(m.size).toBe(1)
    expect(m.get(pc)?.kind).toBe('unknown')
  })

  it('M-ORD fixture: the two roots sort differently bytewise and by default sort', async () => {
    const { ff5a, emoji } = orderingRoots(base)
    const lockPaths = [emoji, ff5a].map((r) => path.join(r, '.skillsmith-writes.lock'))
    const m = await assignLocks(
      listingOf({
        stateRoot: state,
        parked: [ff5a, emoji].map((r, i) => ({
          copyPath: path.join(r, '.skillsmith-parked', 'op', `foo-0000000${i}`),
          kind: 'uninstall',
          skillsRoot: r,
          areaDir: path.join(r, '.skillsmith-parked'),
        })),
      })
    )
    const paths = [...m.values()].map((a) => (a.kind === 'lock1' ? a.path : ''))
    expect(paths.sort()).toEqual([...lockPaths].sort())
    const bytewise = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    expect(bytewise[0]).toContain(FF5A)
    expect([...paths].sort()[0]).toContain(EMOJI)
  })
})
