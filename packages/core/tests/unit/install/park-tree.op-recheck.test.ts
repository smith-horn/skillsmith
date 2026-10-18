/**
 * SMI-6531: post-move verification of the op directory itself (SMI-7134),
 * ported from the SMI-6676 spike's `harness/test-quarantine-op-recheck.mjs`.
 *
 * The op directory's path resolving identically is not enough: after the
 * rename it can be renamed aside, a fresh directory made at the same path and
 * the entry moved in. Verification therefore also requires the op directory's
 * identity (type included) and the shared owner/mode check, and it runs the
 * location block after the walk and the hash.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIENT,
  PARKED,
  cleanup,
  exists,
  guardOf,
  readText,
  runWithHooks,
  simpleFixture,
  CALLER,
  KIND,
} from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = (prefix: string) => {
  const f = simpleFixture(prefix)
  roots.push(f.root)
  return f
}

/** Replaces the op directory with a fresh one at the same path, entry moved in. */
function swapOpDir(prefix: string, opId: string, mode: number, alsoAppend = false) {
  const f = fixture(prefix)
  const area = path.join(f.parent, PARKED)
  const opDir = path.join(area, opId)
  const run = runWithHooks({
    parentAbs: f.parent,
    name: 'tree',
    options: { client: CLIENT, caller: CALLER, kind: KIND, opId, guardHash: guardOf(f.origin) },
    onAfterRename: () => {
      const aside = path.join(area, `${opId}-aside`)
      fs.renameSync(opDir, aside)
      fs.mkdirSync(opDir)
      fs.chmodSync(opDir, mode)
      const entry = fs.readdirSync(aside).find((n) => n.startsWith('tree-')) as string
      fs.renameSync(path.join(aside, entry), path.join(opDir, entry))
      if (alsoAppend) fs.appendFileSync(path.join(opDir, entry, 'sub', 'f.txt'), 'X')
    },
  })
  return { f, run, opDir }
}

describe('the op directory must still be the one the park validated (SMI-7134)', () => {
  for (const [id, mode, label] of [
    ['G', 0o777, 'a fresh world-writable directory'],
    ['G2', 0o700, 'a fresh 0700 directory of ours'],
  ] as const) {
    it(`${id}: ${label} at the op path is held by the identity check`, () => {
      const { f, run, opDir } = swapOpDir(
        `park-${id.toLowerCase()}-`,
        `op-${id.toLowerCase()}`,
        mode
      )
      const r = run.result
      expect(run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
      expect(r.status).toBe('held')
      expect(r.reason).toBe('changed-during-move')
      expect(r.detail ?? '').toMatch(/op directory identity check failed/)
      const parked = fs
        .readdirSync(opDir)
        .filter((n) => n.startsWith('tree-') && !n.endsWith('.json'))
      expect(parked).toHaveLength(1)
      expect(readText(path.join(opDir, parked[0] as string, 'sub', 'f.txt'))).toBe('USERBYTES')
      expect(exists(f.origin)).toBe(false)
      fs.chmodSync(opDir, 0o700)
    })
  }

  it('H: the same op directory chmod 0777 after the rename is held by the owner/mode re-check', () => {
    const f = fixture('park-h-')
    const opDir = path.join(f.parent, PARKED, 'op-h')
    const run = runWithHooks({
      parentAbs: f.parent,
      name: 'tree',
      options: {
        client: CLIENT,
        caller: CALLER,
        kind: KIND,
        opId: 'op-h',
        guardHash: guardOf(f.origin),
      },
      onAfterRename: () => fs.chmodSync(opDir, 0o777),
    })
    const r = run.result
    expect(run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
    expect(r.status).toBe('held')
    expect(r.detail ?? '').toMatch(/op directory owner\/mode check failed/)
    expect(r.detail ?? '').toMatch(/mode 777/)
    expect(exists(f.origin)).toBe(false)
    // The location was confirmed, so the detail says where; it claims no safety.
    expect(r.detail ?? '').toMatch(/observed at '/)
    expect(/not private/.test(r.detail ?? '') && !/safe/i.test(r.detail ?? '')).toBe(true)
    fs.chmodSync(opDir, 0o700)
  })
})

describe('a held detail claims safety only when the location was confirmed', () => {
  it('I: after a containment failure the detail makes no safety claim', () => {
    const f = fixture('park-i-')
    const opDir = path.join(f.parent, PARKED, 'op-i')
    const outside = path.join(f.root, 'attacker-storage')
    const run = runWithHooks({
      parentAbs: f.parent,
      name: 'tree',
      options: {
        client: CLIENT,
        caller: CALLER,
        kind: KIND,
        opId: 'op-i',
        guardHash: guardOf(f.origin),
      },
      onAfterRename: () => {
        fs.renameSync(opDir, outside)
        fs.symlinkSync(outside, opDir)
      },
    })
    const r = run.result
    expect(r.status).toBe('held')
    expect(/safe/i.test(r.detail ?? '')).toBe(false)
    expect(r.detail ?? '').toMatch(/could not be confirmed/)
    expect((r.detail ?? '').includes(r.path as string)).toBe(true)
    expect(r.detail ?? '').toMatch(/reason: op directory resolves elsewhere/)
  })

  it('I5 control: a post-move content change with a confirmed location keeps "safe at"', () => {
    const f = fixture('park-i2-')
    const run = runWithHooks({
      parentAbs: f.parent,
      name: 'tree',
      options: {
        client: CLIENT,
        caller: CALLER,
        kind: KIND,
        opId: 'op-i2',
        guardHash: guardOf(f.origin),
      },
      onAfterRename: ({ destPath }) => fs.appendFileSync(path.join(destPath, 'sub', 'f.txt'), 'X'),
    })
    expect(run.result.status).toBe('held')
    expect(run.result.detail ?? '').toMatch(/your tree is safe at /)
  })

  it('I7: content AND location both fail: the location verdict wins and the content failure is still named', () => {
    const { run } = swapOpDir('park-i7-', 'op-i7', 0o700, true)
    const r = run.result
    expect(run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
    expect(r.status).toBe('held')
    expect(/safe at/.test(r.detail ?? '')).toBe(false)
    expect(r.detail ?? '').toMatch(/could not be confirmed/)
    expect(r.detail ?? '').toMatch(/op directory identity check failed/)
    expect(r.detail ?? '').toMatch(
      /content check also failed: changed-during-move: tree hash at the destination differs/
    )
  })
})

describe('location is checked after the walk and the hash (SMI-7134 gate)', () => {
  function runInjected(kind: 'j' | 'j2') {
    const f = fixture(`park-inj-${kind}-`)
    const opId = `op-inj-${kind}`
    const opDir = path.join(f.parent, PARKED, opId)
    let destLstats = 0
    let injected = false
    const run = runWithHooks({
      parentAbs: f.parent,
      name: 'tree',
      options: { client: CLIENT, caller: CALLER, kind: KIND, opId, guardHash: guardOf(f.origin) },
      onCall: ({ fn, p0, renameReturned, destPath }) => {
        if (!renameReturned || injected || destPath === null || p0 === null) return
        // J: before the 2nd lstat of destPath (the walk's root lstat is the 1st),
        // the bound tree moves aside and a byte-identical copy takes its place.
        if (kind === 'j' && fn === 'lstatSync' && p0 === destPath && ++destLstats === 2) {
          injected = true
          fs.renameSync(destPath, destPath + '.moved')
          fs.mkdirSync(path.join(destPath, 'sub'), { recursive: true })
          fs.writeFileSync(path.join(destPath, 'sub', 'f.txt'), 'USERBYTES')
        }
        // J2: the op directory turns 0777 during the walk.
        if (kind === 'j2' && fn === 'lstatSync' && p0.startsWith(destPath + path.sep)) {
          injected = true
          fs.chmodSync(opDir, 0o777)
        }
      },
    })
    return { f, opDir, run, injected }
  }

  it('J: a byte-identical copy swapped in during the walk is held by the destination identity', () => {
    const { f, run, injected } = runInjected('j')
    expect(injected && run.hookErrors.length === 0).toBe(true)
    expect(run.result.status).toBe('held')
    expect(run.result.detail ?? '').toMatch(/identity at destination does not match/)
    expect(/safe/i.test(run.result.detail ?? '')).toBe(false)
    expect(exists(f.origin)).toBe(false)
  })

  it('J2: an op directory made 0777 during the walk is held by the owner/mode check', () => {
    const { opDir, run, injected } = runInjected('j2')
    expect(injected && run.hookErrors.length === 0).toBe(true)
    expect(run.result.status).toBe('held')
    expect(run.result.detail ?? '').toMatch(/op directory owner\/mode check failed/)
    fs.chmodSync(opDir, 0o700)
  })
})
