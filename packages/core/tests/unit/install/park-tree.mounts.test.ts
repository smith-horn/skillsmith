/**
 * SMI-6531: mounts inside the tree (ADR-166 D-10 item 5), ported from the
 * SMI-6676 spike's `harness/quarantine-mounts.selftest.mjs` (the mountinfo
 * parser) and `harness/test-quarantine-mounts.mjs` (R9-R13).
 *
 * Real mounts need root with CAP_SYS_ADMIN (a throwaway privileged container);
 * the dev container has neither, so those cases skip with that reason. The
 * same code paths are also driven deterministically: a different `st_dev` is
 * reported for one entry, or a mount point is added to the mountinfo text the
 * park reads, both through the fs default object the park calls.
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { computePathTreeHash } from '../../../src/install/park-tree.js'
import {
  MOUNTINFO_APPLIES,
  mountPointsAtOrUnder,
  parseMountInfo,
} from '../../../src/install/park-tree.mounts.js'
import {
  CLIENT,
  buildFixture,
  cleanup,
  exists,
  guardOf,
  park,
  readText,
  runWithHooks,
  withFsStub,
  CALLER,
  KIND,
} from './park-tree.helpers.js'
import type { Fixture } from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = (): Fixture => {
  const f = buildFixture('park-mnt-')
  roots.push(f.root)
  return f
}

/** Root with CAP_SYS_ADMIN on Linux: the only place a real mount can be made. */
const CAN_MOUNT = (() => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false
  try {
    const m = /CapEff:\s*([0-9a-f]+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))
    return m !== null && (BigInt(`0x${m[1]}`) & (1n << 21n)) !== 0n
  } catch {
    return false
  }
})()

describe('the mountinfo parser (spike quarantine-mounts.selftest)', () => {
  const TEXT = [
    '22 1 0:21 / / rw,relatime master:1 - overlay overlay rw',
    '85 22 0:21 /work/src /work/tree/sub rw,relatime shared:1 - overlay overlay rw',
    '99 22 0:45 / /work/tree/tm rw,relatime - tmpfs tmpfs rw',
    '100 22 0:46 / /work/tree/with\\040space rw - tmpfs tmpfs rw',
    '101 22 0:47 / /work/tree/back\\134slash rw - tmpfs tmpfs rw',
    '102 22 0:48 / /work/tree2/sibling rw - tmpfs tmpfs rw',
    '103 22 0:49 / /work/tree rw - tmpfs tmpfs rw',
    '',
  ].join('\n')
  const DOTDOT = [
    '110 22 0:21 /work/src /work/tree/..foo rw - overlay overlay rw',
    '111 22 0:21 /work/src /work/tree/... rw - overlay overlay rw',
    '112 22 0:21 /work/src /work/..escape rw - overlay overlay rw',
    '',
  ].join('\n')

  it('M1-M3: every mount point is parsed and octal escapes are undone', () => {
    expect(parseMountInfo(TEXT)).toHaveLength(7)
    expect(parseMountInfo(TEXT)).toContain('/work/tree/with space')
    expect(parseMountInfo(TEXT)).toContain('/work/tree/back\\slash')
  })

  it('M4-M6: at-or-under includes the root and entries below, never a name-prefix sibling', () => {
    expect(mountPointsAtOrUnder('/work/tree', TEXT).sort()).toEqual(
      [
        '/work/tree',
        '/work/tree/back\\slash',
        '/work/tree/sub',
        '/work/tree/tm',
        '/work/tree/with space',
      ].sort()
    )
    expect(mountPointsAtOrUnder('/elsewhere', TEXT)).toEqual([])
    expect(mountPointsAtOrUnder('/', TEXT)).toHaveLength(7)
  })

  it('M7: a malformed line is skipped, not thrown on', () => {
    expect(parseMountInfo('garbage\n\n')).toEqual([])
  })

  it('M8: a child named ..foo or ... is under the tree; a sibling ..escape is not', () => {
    expect(mountPointsAtOrUnder('/work/tree', DOTDOT).sort()).toEqual(
      ['/work/tree/...', '/work/tree/..foo'].sort()
    )
  })
})

/** Reports a different st_dev for `p`, as a mount there would. */
const devStub =
  (p: () => string) =>
  (orig: (...a: unknown[]) => unknown) =>
  (...args: unknown[]) => {
    const st = orig(...args) as BigIntStats
    if (String(args[0]) === p() && typeof st.dev === 'bigint') {
      return new Proxy(st, {
        get: (t, k) => {
          if (k === 'dev') return t.dev + 1n
          const v = Reflect.get(t, k) as unknown
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
        },
      })
    }
    return st
  }

/** Adds a mount point at `mp()` to the mountinfo text the park reads. */
const mountinfoStub =
  (mp: () => string | null) =>
  (orig: (...a: unknown[]) => unknown) =>
  (...args: unknown[]) => {
    const out = orig(...args)
    const at = mp()
    if (args[0] === '/proc/self/mountinfo' && at !== null) {
      return `${String(out)}999 22 0:99 / ${at.replace(/ /g, '\\040')} rw - tmpfs tmpfs rw\n`
    }
    return out
  }

describe('a mount below the root before the park is refused, nothing moved (R9/R11)', () => {
  it('st_dev differs below the root: kept/mount-inside-tree', () => {
    const f = fixture()
    const guardHash = guardOf(f.origin)
    const r = withFsStub(
      'lstatSync',
      devStub(() => f.target),
      () => park(f.parent, f.name, { guardHash })
    )
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('mount-inside-tree')
    expect(String(r.detail)).toContain('target')
    expect(readText(path.join(f.target, 'orig-f1'))).toBe('original-content-f1')
  })

  it('R13: the caller hash stays mount-tolerant through the same st_dev difference', () => {
    const f = fixture()
    const h = withFsStub(
      'lstatSync',
      devStub(() => f.target),
      () => computePathTreeHash(f.origin)
    )
    expect(h.ok).toBe(true)
  })

  it.skipIf(!MOUNTINFO_APPLIES)(
    'Linux: a mountinfo-only mount (a same-filesystem bind) below the root: kept/mount-inside-tree',
    () => {
      const f = fixture()
      const guardHash = guardOf(f.origin)
      const r = withFsStub(
        'readFileSync',
        mountinfoStub(() => f.target),
        () => park(f.parent, f.name, { guardHash })
      )
      expect(r.status).toBe('kept')
      expect(r.reason).toBe('mount-inside-tree')
      expect(String(r.detail)).toContain(`mount point ${f.target}`)
      expect(exists(f.origin)).toBe(true)
    }
  )

  it.skipIf(!MOUNTINFO_APPLIES)(
    'Linux: an unreadable mountinfo fails closed (kept), never reads as no mounts',
    () => {
      const f = fixture()
      const guardHash = guardOf(f.origin)
      const r = withFsStub(
        'readFileSync',
        (orig) =>
          (...args: unknown[]) => {
            if (args[0] === '/proc/self/mountinfo') {
              const e = new Error('forced') as NodeJS.ErrnoException
              e.code = 'EACCES'
              throw e
            }
            return orig(...args)
          },
        () => park(f.parent, f.name, { guardHash })
      )
      expect(r.status).toBe('kept')
      expect(r.reason).toBe('mount-inside-tree')
      expect(String(r.detail)).toContain('mountinfo unreadable (EACCES)')
      expect(exists(f.origin)).toBe(true)
    }
  )

  it('an unguarded park runs no mount check (UD27 makes every automatic caller guarded)', () => {
    const f = fixture()
    const r = withFsStub(
      'lstatSync',
      devStub(() => f.target),
      () => park(f.parent, f.name)
    )
    expect(r.status).toBe('parked')
  })
})

describe('a mount that appears during the move is held (R10)', () => {
  it('st_dev differs below the root at the destination: held/mount-appeared-during-move', () => {
    const f = fixture()
    let destTarget: string | null = null
    const run = withFsStub(
      'lstatSync',
      devStub(() => destTarget ?? '\0none'),
      () =>
        runWithHooks({
          parentAbs: f.parent,
          name: f.name,
          options: {
            client: CLIENT,
            caller: CALLER,
            kind: KIND,
            opId: 'op-r10',
            guardHash: guardOf(f.origin),
          },
          onAfterRename: ({ destPath }) => {
            destTarget = path.join(destPath, 'target')
          },
        })
    )
    expect(run.fired.afterRename).toBe(true)
    expect(run.result.status).toBe('held')
    expect(run.result.reason).toBe('mount-appeared-during-move')
    expect(String(run.result.detail)).toContain('mount at target')
    expect(exists(f.origin)).toBe(false)
  })

  it.skipIf(!MOUNTINFO_APPLIES)(
    'Linux: a mountinfo mount below the parked copy: held/mount-appeared-during-move',
    () => {
      const f = fixture()
      let destTarget: string | null = null
      const run = withFsStub(
        'readFileSync',
        mountinfoStub(() => destTarget),
        () =>
          runWithHooks({
            parentAbs: f.parent,
            name: f.name,
            options: {
              client: CLIENT,
              caller: CALLER,
              kind: KIND,
              opId: 'op-r10m',
              guardHash: guardOf(f.origin),
            },
            onAfterRename: ({ destPath }) => {
              destTarget = path.join(destPath, 'target')
            },
          })
      )
      expect(run.result.status).toBe('held')
      expect(run.result.reason).toBe('mount-appeared-during-move')
      expect(String(run.result.detail)).toContain('mount point')
    }
  )
})

describe.skipIf(!CAN_MOUNT)('real mounts (Linux root with CAP_SYS_ADMIN only)', () => {
  const detach = (mp: string) => {
    for (const args of [[mp], ['-l', mp]]) {
      try {
        execFileSync('umount', args, { stdio: 'pipe' })
        return
      } catch {
        /* try the next form */
      }
    }
  }
  for (const kind of ['tmpfs', 'bind'] as const) {
    it(`R11 ${kind}: a mount present before the park is refused and stays at the origin`, () => {
      const f = fixture()
      if (kind === 'tmpfs')
        execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=4m', 'none', f.target])
      else {
        const src = path.join(f.root, 'bind-src')
        fs.mkdirSync(src)
        execFileSync('mount', ['--bind', src, f.target])
      }
      try {
        fs.writeFileSync(path.join(f.target, 'mounted-user.txt'), 'mounted-user-bytes')
        const r = park(f.parent, f.name, { guardHash: guardOf(f.origin) })
        expect(r.status).toBe('kept')
        expect(r.reason).toBe('mount-inside-tree')
        expect(readText(path.join(f.target, 'mounted-user.txt'))).toBe('mounted-user-bytes')
      } finally {
        detach(f.target)
      }
    })
  }
})
