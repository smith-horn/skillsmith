/**
 * SMI-6531: the file type in identity (SMI-7130) and the post-move location
 * checks (SMI-7132), ported from the SMI-6676 spike's
 * `harness/test-quarantine-identity-type.mjs`, plus T-X18 (f)'s SMI-7130 row
 * run against the real filesystem.
 *
 * On Linux overlayfs a symlink created where the op directory was just deleted
 * reuses the inode number and, within a tick, the birthtime, so identity
 * without the file type accepted it and rename(2) moved the tree through it.
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParkIdentity } from '../../../src/install/park-result.js'
import {
  CLIENT,
  PARKED,
  cleanup,
  exists,
  guardOf,
  park,
  readText,
  runWithHooks,
  simpleFixture,
  withFsStub,
  CALLER,
  KIND,
} from './park-tree.helpers.js'

const S_IFMT = 0o170000n
const S_IFLNK = 0o120000n
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = (prefix: string) => {
  const f = simpleFixture(prefix)
  roots.push(f.root)
  return f
}
const countEntries = (d: string): number => (exists(d) ? fs.readdirSync(d).length : -1)

describe('the rebind compares the file type (SMI-7130)', () => {
  it('A: a same-identity symlink reported at the op directory rebind is refused', () => {
    const f = fixture('park-a-')
    const opDir = path.join(f.parent, PARKED, 'op-forged')
    let opCalls = 0
    let forged = false
    let validated: BigIntStats | null = null
    const r = withFsStub(
      'lstatSync',
      (orig) =>
        (...args: unknown[]) => {
          const out = orig(...args) as BigIntStats
          const opts = args[1] as { bigint?: boolean } | undefined
          if (String(args[0]) === opDir && opts?.bigint === true) {
            opCalls += 1
            if (opCalls === 1) validated = out
            if (opCalls === 2 && validated !== null) {
              forged = true
              const v: BigIntStats = validated
              return {
                ...v,
                dev: v.dev,
                ino: v.ino,
                birthtimeNs: v.birthtimeNs,
                uid: v.uid,
                mode: (v.mode & ~S_IFMT) | S_IFLNK,
                isSymbolicLink: () => true,
                isDirectory: () => false,
              }
            }
          }
          return out
        },
      () => park(f.parent, 'tree', { opId: 'op-forged' })
    )
    expect(forged).toBe(true)
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('park-destination-changed')
    expect(r.detail).toBe('op directory was substituted between validation and rename')
    expect(readText(path.join(f.origin, 'sub', 'f.txt'))).toBe('USERBYTES')
    expect(countEntries(opDir)).toBe(0)
  })

  it('A-real: on a filesystem that recycles inode and birthtime, a symlink swapped in for the op directory never receives the tree', (ctx) => {
    // T-X18 (f): the real overlayfs attack, not a stub. Fails if any trial ends
    // `parked`; skipped (never-ran, not a pass) if this filesystem never forged
    // the full identity, since then the type comparison was never the thing
    // that refused.
    const TRIALS = 40
    let forgedTrials = 0
    const outcomes: Record<string, number> = {}
    let landedInLoot = 0
    for (let i = 0; i < TRIALS; i++) {
      const f = fixture('park-areal-')
      const loot = path.join(f.root, 'attacker-storage')
      fs.mkdirSync(loot)
      const area = path.join(f.parent, PARKED)
      const opDir = path.join(area, `op-real-${i}`)
      let before: BigIntStats | null = null
      let swapped = false
      let seenOp = false
      const r = withFsStub(
        'lstatSync',
        (orig) =>
          (...args: unknown[]) => {
            // The first lstat after the op directory's validation is the parked
            // area's rebind: swap the op directory for a symlink right then.
            if (seenOp && !swapped && String(args[0]) === area) {
              swapped = true
              before = orig(opDir, { bigint: true }) as BigIntStats
              fs.rmdirSync(opDir)
              fs.symlinkSync(loot, opDir)
              const after = orig(opDir, { bigint: true }) as BigIntStats
              if (
                after.ino === before.ino &&
                after.dev === before.dev &&
                after.birthtimeNs === before.birthtimeNs
              ) {
                forgedTrials += 1
              }
            }
            const out = orig(...args)
            if (String(args[0]) === opDir) seenOp = true
            return out
          },
        () => park(f.parent, 'tree', { opId: `op-real-${i}` })
      )
      const key = `${r.status}/${r.reason ?? '-'}`
      outcomes[key] = (outcomes[key] ?? 0) + 1
      if (fs.readdirSync(loot).length > 0) landedInLoot += 1
      expect(swapped).toBe(true)
    }
    expect(landedInLoot).toBe(0)
    expect(outcomes['parked/-'] ?? 0).toBe(0)
    if (forgedTrials === 0) {
      ctx.skip(
        `never-ran: ${os.tmpdir()} did not recycle inode+birthtime in ${TRIALS} trials ` +
          `(outcomes ${JSON.stringify(outcomes)})`
      )
    }
    expect(outcomes['kept/park-destination-changed']).toBe(TRIALS)
  })
})

describe('post-move location checks (SMI-7132)', () => {
  it('B0: an honest guarded park is parked', () => {
    const f = fixture('park-b0-')
    expect(park(f.parent, 'tree', { opId: 'op-ok', guardHash: guardOf(f.origin) }).status).toBe(
      'parked'
    )
  })

  it('B: an op directory moved out of the parked area after the rename is held, nothing moved back', () => {
    const f = fixture('park-b-')
    const outside = path.join(f.root, 'attacker-storage')
    const opDir = path.join(f.parent, PARKED, 'op-out')
    const run = runWithHooks({
      parentAbs: f.parent,
      name: 'tree',
      options: {
        client: CLIENT,
        caller: CALLER,
        kind: KIND,
        opId: 'op-out',
        guardHash: guardOf(f.origin),
      },
      onAfterRename: () => {
        fs.renameSync(opDir, outside)
        fs.symlinkSync(outside, opDir)
      },
    })
    const r = run.result
    expect(run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
    expect(r.status).toBe('held')
    expect(r.reason).toBe('changed-during-move')
    expect(r.detail ?? '').toMatch(/op directory resolves elsewhere/)
    const moved = fs.readdirSync(outside).filter((n) => !n.endsWith('.json'))
    expect(moved).toHaveLength(1)
    expect(readText(path.join(outside, moved[0] as string, 'sub', 'f.txt'))).toBe('USERBYTES')
    expect(exists(f.origin)).toBe(false)
  })

  it('C1: a type-less expectIdentity is refused (fmt is required); C2: with its type it is accepted', () => {
    const f = fixture('park-c-')
    const st = fs.lstatSync(f.origin, { bigint: true })
    const typeless = { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs }
    expect(() =>
      park(f.parent, 'tree', { opId: 'op-c1', expectIdentity: typeless as ParkIdentity })
    ).toThrow(TypeError)
    expect(readText(path.join(f.origin, 'sub', 'f.txt'))).toBe('USERBYTES')
    const g = fixture('park-c2-')
    const st2 = fs.lstatSync(g.origin, { bigint: true })
    const r2 = park(g.parent, 'tree', {
      opId: 'op-c2',
      expectIdentity: {
        dev: st2.dev,
        ino: st2.ino,
        birthtimeNs: st2.birthtimeNs,
        fmt: st2.mode & S_IFMT,
      },
    })
    expect(r2.status).toBe('parked')
  })

  it('D: a guarded symlink skill root parks the link itself; its target is untouched', () => {
    const f = fixture('park-d-')
    const target = path.join(f.root, 'devcheckout')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'TARGETBYTES')
    const link = path.join(f.parent, 'linked')
    fs.symlinkSync(target, link)
    const r = park(f.parent, 'linked', { opId: 'op-d', guardHash: guardOf(link) })
    expect(r.status).toBe('parked')
    expect(fs.readlinkSync(r.path as string)).toBe(target)
    expect(path.dirname(r.path as string)).toBe(path.join(f.parent, PARKED, 'op-d'))
    expect(readText(path.join(target, 'SKILL.md'))).toBe('TARGETBYTES')
    expect(exists(link)).toBe(false)
  })

  it('E1: a parked area swapped for a symlink after the rename is held', () => {
    const f = fixture('park-e1-')
    const area = path.join(f.parent, PARKED)
    const outside = path.join(f.root, 'attacker-storage')
    const run = runWithHooks({
      parentAbs: f.parent,
      name: 'tree',
      options: {
        client: CLIENT,
        caller: CALLER,
        kind: KIND,
        opId: 'op-e1',
        guardHash: guardOf(f.origin),
      },
      onAfterRename: () => {
        fs.renameSync(area, outside)
        fs.symlinkSync(outside, area)
      },
    })
    expect(run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
    expect(run.result.status).toBe('held')
    expect(run.result.reason).toBe('changed-during-move')
    expect(run.result.detail ?? '').toMatch(/op directory resolves elsewhere/)
    expect(exists(f.origin)).toBe(false)
  })

  it('E2: a different directory renamed in as the parked area (same path text) is held by its identity', () => {
    const f = fixture('park-e2-')
    const area = path.join(f.parent, PARKED)
    const aside = path.join(f.root, 'aside')
    const run = runWithHooks({
      parentAbs: f.parent,
      name: 'tree',
      options: {
        client: CLIENT,
        caller: CALLER,
        kind: KIND,
        opId: 'op-e2',
        guardHash: guardOf(f.origin),
      },
      onAfterRename: () => {
        fs.renameSync(area, aside)
        fs.mkdirSync(area, { mode: 0o700 })
        fs.renameSync(path.join(aside, 'op-e2'), path.join(area, 'op-e2'))
      },
    })
    expect(run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
    expect(run.result.status).toBe('held')
    expect(run.result.reason).toBe('changed-during-move')
    expect(run.result.detail ?? '').toMatch(/parked area is no longer the one the park validated/)
    expect(exists(f.origin)).toBe(false)
  })
})
