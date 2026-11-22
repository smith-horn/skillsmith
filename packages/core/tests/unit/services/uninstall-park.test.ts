/**
 * SMI-6531 (A1 step 8-i-a-1): uninstall parks (A1 plan §3.8 row 3). Q3, the
 * edit between read and park, the guard hash under `force` (UD27), T-X17's
 * not-done outcomes, T-W4c, SMI-7249's birthtime refusal, and T-PW1's
 * park-caller half (the space warning from the park-result path).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BigIntStats } from 'node:fs'
import { parkTreeIndexed } from '../../../src/install/park-call.js'
import { measure as realMeasure } from '../../../src/install/prune.measure.js'
import { removeIfSame } from '../../../src/install/remove-if-same.js'
import { createParkReporter } from '../../../src/services/park-report.js'
import { dropManifestEntry } from '../../../src/services/skill-installation.uninstall.park.js'
import type { SkillManifestEntry } from '../../../src/services/skill-installation.types.js'
import {
  PARKED,
  cleanupFixture,
  contentSnapshot,
  entryOf,
  errnoError,
  makeFixture,
  parkedEntries,
  stubFs,
  subjectDeletes,
  uninstall,
  withDeleteSpy,
} from './uninstall-park.helpers.js'
import type { UFixture } from './uninstall-park.helpers.js'

// UD27: counts every guard-hash bind uninstall makes (the gate, then the hash).
const gateCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../../src/install/park-clock-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/install/park-clock-gate.js')>()
  return {
    ...actual,
    gateAndBind: (...args: Parameters<typeof actual.gateAndBind>) => {
      gateCalls.n += 1
      return actual.gateAndBind(...args)
    },
  }
})

type AnyFn = (...args: unknown[]) => unknown
const fixtures: UFixture[] = []
afterEach(() => {
  gateCalls.n = 0
  for (const f of fixtures.splice(0)) cleanupFixture(f)
})
const fixture = (prefix = 'uninstall-park-'): UFixture => {
  const f = makeFixture(prefix)
  fixtures.push(f)
  return f
}
const sidecarOf = (p: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(`${p}.json`, 'utf8')) as Record<string, unknown>
/** Another program moves the folder aside and puts its own at the path (no delete). */
const replaceFolder = (f: UFixture): void => {
  fs.renameSync(f.installPath, `${f.installPath}-aside`)
  fs.mkdirSync(f.installPath)
  fs.writeFileSync(path.join(f.installPath, 'SUBSTITUTE.md'), 'not the skill')
}

describe('Q3: uninstall parks the folder (10 runs)', () => {
  it('lands at <skillsDir>/.skillsmith-parked/<opId>/<dirName>-<rnd>, guarded, entry dropped, nothing deleted', async () => {
    const opIds = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const f = fixture()
      const before = contentSnapshot(f.installPath)
      const { value: r, deletes } = await withDeleteSpy(() => uninstall(f))
      expect(r.success, r.message).toBe(true)
      const parkedPath = String(r.parkedPath)
      const area = path.join(f.skillsDir, PARKED)
      expect(path.dirname(path.dirname(parkedPath))).toBe(area)
      const opId = path.basename(path.dirname(parkedPath))
      expect(opId).toMatch(/^[0-9a-f]{32}$/)
      expect(path.basename(parkedPath).startsWith(`${f.name}-`)).toBe(true)
      opIds.add(opId)
      const sidecar = sidecarOf(parkedPath)
      expect(sidecar['postMoveVerified']).toBe(true)
      expect(sidecar['kind']).toBe('uninstall')
      expect(typeof sidecar['treeHash']).toBe('string')
      expect(entryOf(f)).toBeUndefined()
      expect(r.claimedByAnotherInstall).toBeUndefined()
      expect(fs.existsSync(f.installPath)).toBe(false)
      expect(contentSnapshot(parkedPath)).toEqual(before)
      expect(r.message).toMatch(/to reclaim about \d+(\.\d)? (B|KB|MB|GB)/)
      expect(r.message).toContain(`skillsmith doctor backups --prune --op ${opId}`)
      expect(r.message).toContain(`\`skillsmith restore ${opId}\` puts it back`)
      expect(subjectDeletes(f, deletes)).toEqual([])
    }
    // The opId is random per run, not a constant that happens to be hex.
    expect(opIds.size).toBe(10)
  })

  it('computes the guard hash with force and a modified folder (UD27)', async () => {
    const f = fixture()
    const later = new Date(Date.now() + 3_600_000)
    fs.utimesSync(path.join(f.installPath, 'SKILL.md'), later, later)
    const forced = await uninstall(f, { force: true })
    expect(forced.success, forced.message).toBe(true)
    expect(gateCalls.n).toBe(1)
    expect(typeof sidecarOf(String(forced.parkedPath))['treeHash']).toBe('string')
  })

  it('a refused non-force uninstall of a modified folder makes nothing (no staging, no probe)', async () => {
    const g = fixture()
    const later = new Date(Date.now() + 3_600_000)
    fs.utimesSync(path.join(g.installPath, 'SKILL.md'), later, later)
    const refused = await uninstall(g, { force: false })
    expect(refused.success).toBe(false)
    expect(refused.notDone).toBeUndefined()
    expect(refused.message).toContain('has been modified since installation')
    expect(refused.warning).toContain('sets the folder aside (it is not deleted)')
    expect(gateCalls.n).toBe(0)
    expect(fs.readdirSync(g.skillsDir)).toEqual([g.name])
    expect(entryOf(g)).toBeDefined()
  })

  // 8-i-a-1 gate Major 1: an in-place edit after the modification check and
  // before the gate keeps the folder's identity, and the gate would hash the
  // edited tree; the hash uninstall took when it read the folder catches it.
  for (const force of [false, true]) {
    it(`an edit after the checks and before the gate is refused (force: ${force})`, async () => {
      const f = fixture()
      const target = path.join(f.installPath, 'sub', 'a.txt')
      const before = fs.lstatSync(f.installPath, { bigint: true })
      const r = await uninstall(f, {
        force,
        seams: { afterRefusals: () => fs.writeFileSync(target, 'edited after the checks\n') },
      })
      expect(r.success).toBe(false)
      expect(r.notDone).toMatchObject({ status: 'kept', reason: 'identity-changed' })
      expect(r.notDone?.detail).toContain('changed after uninstall checked it')
      // The edit kept the folder's identity, so only the hash could tell.
      expect(fs.lstatSync(f.installPath, { bigint: true }).ino).toBe(before.ino)
      expect(fs.readFileSync(target, 'utf8')).toBe('edited after the checks\n')
      expect(entryOf(f)).toBeDefined()
      expect(parkedEntries(f)).toEqual([])
    })
  }

  // The hash uninstall takes when it reads the folder cannot be taken: it stops
  // with the walk's own reason and creates nothing (no staging, no probe, no copy).
  it('a folder the read hash cannot walk stops guard-unreadable, creating nothing', async () => {
    const f = fixture()
    const sub = path.join(f.installPath, 'sub')
    const before = contentSnapshot(f.installPath)
    let restore: () => void
    if (process.getuid?.() !== 0) {
      fs.chmodSync(sub, 0o000)
      restore = () => fs.chmodSync(sub, 0o755)
    } else {
      // Root reads a mode-000 directory anyway, so the unreadable entry is
      // simulated where the walk lists it: readdirSync of `sub` fails EACCES.
      restore = stubFs('readdirSync', (orig: AnyFn) => (...a: unknown[]) => {
        if (a[0] === sub) throw errnoError('EACCES')
        return orig(...a)
      })
    }
    let r: Awaited<ReturnType<typeof uninstall>>
    try {
      r = await uninstall(f)
    } finally {
      restore()
    }
    expect(r.success).toBe(false)
    expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'guard-unreadable' })
    expect(r.notDone?.errno).toBe('EACCES')
    // Presence: the folder (byte for byte) and its manifest entry are still there.
    expect(contentSnapshot(f.installPath)).toEqual(before)
    expect(entryOf(f)).toBeDefined()
    // Absence, from the same run: nothing else was made in the skills root.
    expect(fs.readdirSync(f.skillsDir)).toEqual([f.name])
    expect(gateCalls.n).toBe(0)
  })

  it('an edit between read and park ends kept/identity-changed; the edit and the entry stay', async () => {
    const f = fixture()
    const target = path.join(f.installPath, 'sub', 'a.txt')
    const r = await uninstall(f, {
      seams: { afterBind: () => fs.writeFileSync(target, 'edited after the read\n') },
    })
    expect(r.success).toBe(false)
    expect(r.notDone).toMatchObject({ status: 'kept', reason: 'identity-changed' })
    expect(fs.readFileSync(target, 'utf8')).toBe('edited after the read\n')
    expect(entryOf(f)).toBeDefined()
    expect(parkedEntries(f)).toEqual([])
  })

  it('control: the unported removeIfSame deletes the folder (callback-family spy)', async () => {
    const f = fixture()
    const seen = fs.lstatSync(f.installPath, { bigint: true })
    const { value, deletes } = await withDeleteSpy(() => removeIfSame(f.installPath, seen))
    expect(value.removed).toBe(true)
    // Its recursive `fsp.rm` is seen at its entry (the promise family). The
    // callback family sees the walk only when Node's internal rimraf was first
    // loaded under the spy: it destructures `fs` once, at load (measured).
    expect(deletes.filter((d) => d.family !== 'sync').length).toBeGreaterThan(0)
  })
})

describe('T-X17 row 3: a park that does not finish is not done, and the entry stays', () => {
  const cases: [string, (f: UFixture) => Parameters<typeof uninstall>[1], string, string][] = [
    [
      'kept (the folder replaced after the bind)',
      (f) => ({ seams: { afterBind: () => replaceFolder(f) } }),
      'kept',
      'identity-changed',
    ],
    [
      'held (a write lands in the parked copy before the post-move check)',
      (f) => ({
        seams: {
          beforePark: () => {
            const restore = stubFs('renameSync', (orig: AnyFn) => (...a: unknown[]) => {
              const out = orig(...a)
              if (a[0] === f.installPath) {
                restore()
                fs.writeFileSync(path.join(String(a[1]), 'late.txt'), 'late')
              }
              return out
            })
          },
        },
      }),
      'held',
      'changed-during-move',
    ],
    [
      'stopped (the rename fails EACCES)',
      (f) => ({
        seams: {
          beforePark: () => {
            const restore = stubFs('renameSync', (orig: AnyFn) => (...a: unknown[]) => {
              if (a[0] !== f.installPath) return orig(...a)
              restore()
              throw errnoError('EACCES')
            })
          },
        },
      }),
      'stopped',
      'park-failed',
    ],
  ]
  for (const [label, seamsOf, status, reason] of cases) {
    it(label, async () => {
      const f = fixture()
      const { value: r, deletes } = await withDeleteSpy(() => uninstall(f, seamsOf(f)))
      expect(r.success).toBe(false)
      expect(r.notDone).toMatchObject({ path: f.installPath, status, reason })
      if (status === 'held') {
        // The restore line names the op that holds the parked copy.
        const opId = path.basename(path.dirname(String(r.notDone?.parkedPath)))
        expect(opId).toMatch(/^[0-9a-f]{32}$/)
        expect(r.notDone?.restoreCommand).toBe(`skillsmith restore ${opId}`)
      } else {
        // Nothing moved, so there is nothing to restore.
        expect(r.notDone).not.toHaveProperty('restoreCommand')
        expect(r.notDone).not.toHaveProperty('parkedPath')
      }
      expect(entryOf(f)).toBeDefined()
      // One line naming the path, the status and the reason.
      expect(r.message).not.toContain('\n')
      for (const word of [f.installPath, status, reason]) expect(r.message).toContain(word)
      expect(subjectDeletes(f, deletes)).toEqual([])
      if (status === 'held') {
        expect(fs.existsSync(String(r.notDone?.parkedPath))).toBe(true)
        expect(r.parkedPath).toBe(r.notDone?.parkedPath)
      } else {
        expect(fs.existsSync(f.installPath)).toBe(true)
      }
    })
  }

  it('control: a caller that ignores the park result drops the entry', async () => {
    const f = fixture()
    const loaded = entryOf(f) as SkillManifestEntry
    const r = await uninstall(f, { seams: { afterBind: () => replaceFolder(f) } })
    expect(r.notDone?.status).toBe('kept')
    // What an ignoring caller does next: drop the record anyway.
    expect((await dropManifestEntry(f.manifest, f.name, loaded)).kind).toBe('dropped')
    expect(entryOf(f)).toBeUndefined()
  })
})

describe('T-W4c row 3: per-writer identity', () => {
  it('the skills root swapped before the park: root-changed, nothing moved', async () => {
    const f = fixture()
    const moved = `${f.skillsDir}-old`
    // The substituted root holds a folder of the skill's name: the bound folder
    // itself, moved in, so its identity and hash still match and only the root
    // check can refuse it. With that check off (the red-test control) the park
    // lands in the substituted root.
    const r = await uninstall(f, {
      seams: {
        beforePark: () => {
          fs.renameSync(f.skillsDir, moved)
          fs.mkdirSync(f.skillsDir)
          fs.renameSync(path.join(moved, f.name), f.installPath)
        },
      },
    })
    expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'root-changed' })
    expect(fs.existsSync(path.join(f.installPath, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(f.skillsDir, PARKED))).toBe(false)
    expect(fs.existsSync(path.join(moved, PARKED))).toBe(false)
    expect(fs.readdirSync(f.skillsDir)).toEqual([f.name])
    expect(entryOf(f)).toBeDefined()
  })

  it('the folder replaced before the park: kept, the replacement untouched', async () => {
    const f = fixture()
    const r = await uninstall(f, { seams: { beforePark: () => replaceFolder(f) } })
    expect(r.notDone).toMatchObject({ status: 'kept', reason: 'identity-changed' })
    expect(fs.readFileSync(path.join(f.installPath, 'SUBSTITUTE.md'), 'utf8')).toBe('not the skill')
    expect(parkedEntries(f)).toEqual([])
  })
})

describe('SMI-7249: a substitute with the same dev and ino but another birthtime', () => {
  const restamp =
    (target: string) =>
    (orig: AnyFn): AnyFn =>
    (...a: unknown[]) => {
      const st = orig(...a) as BigIntStats
      if (a[0] !== target || typeof st.birthtimeNs !== 'bigint') return st
      const out = Object.create(st) as BigIntStats
      Object.defineProperty(out, 'birthtimeNs', { value: st.birthtimeNs + 1n })
      return out
    }

  it('the park refuses it (kept/identity-changed), nothing moved', async () => {
    const f = fixture()
    let restore: (() => void) | null = null
    try {
      const r = await uninstall(f, {
        seams: { beforePark: () => void (restore = stubFs('lstatSync', restamp(f.installPath))) },
      })
      expect(r.notDone).toMatchObject({ status: 'kept', reason: 'identity-changed' })
    } finally {
      ;(restore as (() => void) | null)?.()
    }
    expect(fs.existsSync(path.join(f.installPath, 'SKILL.md'))).toBe(true)
    expect(entryOf(f)).toBeDefined()
  })

  it('known-positive: removeIfSame with a number {dev, ino} deletes that same substitute', async () => {
    const f = fixture()
    const st = fs.lstatSync(f.installPath, { bigint: true })
    const r = await removeIfSame(f.installPath, { dev: Number(st.dev), ino: Number(st.ino) })
    expect(r.removed).toBe(true)
    expect(fs.existsSync(f.installPath)).toBe(false)
  })
})

describe('T-PW1 (park-caller half): the space warning comes from the park-result path', () => {
  const overThreshold = { statfs: () => ({ bavail: 1, bsize: 1 }) }

  it('names the largest copy in the words "set-aside folders"', async () => {
    const f = fixture()
    const r = await uninstall(f, { seams: { usage: { usage: overThreshold } } })
    expect(r.success, r.message).toBe(true)
    expect(r.usageWarning).toContain("Skillsmith's set-aside folders")
    expect(r.usageWarning).not.toMatch(/trash/i)
    expect(r.usageWarning).toContain(`${f.name} `)
    expect(r.usageWarning).toContain(String(r.parkedPath))
    // Real measure: the parked area and the op directory count toward the total
    // but are not copies, so the "Largest" list never names them.
    expect(r.usageWarning).not.toContain(`(${path.join(f.skillsDir, PARKED)})`)
    expect(r.usageWarning).not.toContain(`(${path.dirname(String(r.parkedPath))})`)
  })

  it('control: only a park made through the reporter produces a warning', async () => {
    const opts = { client: 'claude-code', caller: 'uninstall', kind: 'uninstall' } as const
    const bypassed = fixture()
    const bypass = createParkReporter()
    const r = await parkTreeIndexed(bypassed.skillsDir, bypassed.name, opts)
    expect(r.status).toBe('parked')
    const listingOf = (f: UFixture) => ({ usage: overThreshold, roots: [f.skillsDir] })
    // Same over-threshold listing, same kind of park: the reporter never saw it.
    expect(await bypass.finish({ listing: listingOf(bypassed) })).toBeNull()

    const through = fixture()
    const reporter = createParkReporter()
    const r2 = await reporter.park(through.skillsDir, through.name, opts)
    expect(r2.status).toBe('parked')
    expect(await reporter.finish({ listing: listingOf(through) })).toContain(
      "Skillsmith's set-aside folders"
    )
  })

  it('one unmeasured entry far below the threshold still prints (SMI-7127)', async () => {
    const f = fixture()
    // The parked copy alone is unreadable; everything else is measured for real.
    const measure = (abs: string) =>
      path.basename(abs).startsWith(`${f.name}-`) && !abs.endsWith('.json')
        ? { allocatedBytes: 0, apparentBytes: 0, unmeasured: 1, units: new Map<string, number>() }
        : realMeasure(abs)
    const roomy = { statfs: () => ({ bavail: 1e12, bsize: 1 }) }
    const r = await uninstall(f, { seams: { usage: { usage: roomy, measure } } })
    expect(r.success, r.message).toBe(true)
    expect(r.usageWarning).toContain('1 entry could not be measured')
  })

  it('a refused uninstall moves nothing and evaluates no warning', async () => {
    const f = fixture()
    const r = await uninstall(f, {
      seams: { usage: { usage: overThreshold }, afterBind: () => replaceFolder(f) },
    })
    expect(r.notDone?.status).toBe('kept')
    expect(r.usageWarning).toBeUndefined()
  })
})
