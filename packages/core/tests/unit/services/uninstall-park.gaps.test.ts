/**
 * SMI-6531 (A1 step 8-i-a-1, confirmation round): tests that pin what the
 * uninstall park derives, against the mutants that survived the earlier set.
 *
 * - `claimedByAnotherInstall` comes from the manifest drop's claim, never from
 *   a warning's words (`doneResult` unit tests).
 * - A read-hash walk failure keeps the walk's own reason for every reason, not
 *   only `guard-unreadable` (a FIFO: `guard-unsupported-type`).
 * - The read-hash comparison is not special to one file: a root-level edit and
 *   a new file are refused too.
 * - The comparison covers the whole hash: a guard hash that differs from the
 *   read hash in its last character alone is refused (through the gate mock).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { doneResult } from '../../../src/services/skill-installation.uninstall.result.js'
import {
  cleanupFixture,
  contentSnapshot,
  entryOf,
  makeFixture,
  parkedEntries,
  uninstall,
} from './uninstall-park.helpers.js'
import type { UFixture } from './uninstall-park.helpers.js'

// The gate as shipped, except that one test asks it to return a guard hash
// whose last character differs from the real one.
const gate = vi.hoisted(() => ({ flipLast: false, calls: 0 }))
vi.mock('../../../src/install/park-clock-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/install/park-clock-gate.js')>()
  return {
    ...actual,
    gateAndBind: async (...args: Parameters<typeof actual.gateAndBind>) => {
      gate.calls += 1
      const g = await actual.gateAndBind(...args)
      if (!gate.flipLast || !g.ok) return g
      const last = g.guardHash.slice(-1)
      return { ...g, guardHash: `${g.guardHash.slice(0, -1)}${last === '0' ? '1' : '0'}` }
    },
  }
})

const fixtures: UFixture[] = []
afterEach(() => {
  gate.flipLast = false
  gate.calls = 0
  for (const f of fixtures.splice(0)) cleanupFixture(f)
})
const fixture = (prefix = 'uninstall-gaps-'): UFixture => {
  const f = makeFixture(prefix)
  fixtures.push(f)
  return f
}

describe('claimedByAnotherInstall comes from the drop, not from the warning text', () => {
  const base = (f: UFixture) => ({
    skillName: f.name,
    installPath: f.installPath,
    parkedPath: undefined,
    extras: {},
    doneLine: null,
    adopted: false,
  })

  it('a claimed drop sets the flag', async () => {
    const f = fixture()
    const r = await doneResult({ ...base(f), drop: { kind: 'claimed' }, listenerProblems: [] })
    expect(r.claimedByAnotherInstall).toBe(true)
  })

  it('a dropped record with a warning in the same words does not', async () => {
    const f = fixture()
    const r = await doneResult({
      ...base(f),
      drop: { kind: 'dropped' },
      listenerProblems: [
        'Another install claimed this name while this one was being removed, so that record was left alone.',
      ],
    })
    expect(r.warning).toContain('Another install claimed this name')
    expect(r).not.toHaveProperty('claimedByAnotherInstall')
  })
})

describe('a read-hash walk failure keeps its own reason', () => {
  it('a FIFO inside the folder: stopped/guard-unsupported-type, nothing created', async () => {
    const f = fixture()
    // A real FIFO (mkfifo); the walk refuses an entry that is not a directory,
    // file or symlink, whoever runs it, so no stub is needed as root.
    execFileSync('mkfifo', [path.join(f.installPath, 'sub', 'pipe')])
    const before = fs.readdirSync(path.join(f.installPath, 'sub')).sort()
    const r = await uninstall(f)
    expect(r.success).toBe(false)
    expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'guard-unsupported-type' })
    // Presence: the folder, its FIFO and its manifest entry are still there.
    expect(fs.readdirSync(path.join(f.installPath, 'sub')).sort()).toEqual(before)
    expect(fs.lstatSync(path.join(f.installPath, 'sub', 'pipe')).isFIFO()).toBe(true)
    expect(entryOf(f)).toBeDefined()
    // Absence, from the same run: nothing else in the skills root, no gate.
    expect(fs.readdirSync(f.skillsDir)).toEqual([f.name])
    expect(gate.calls).toBe(0)
  })
})

describe('the read-hash comparison covers the whole folder (force: true)', () => {
  const cases: [string, (f: UFixture) => () => void, (f: UFixture) => void][] = [
    [
      'a root-level file edited in place',
      (f) => () => fs.writeFileSync(path.join(f.installPath, 'SKILL.md'), '# edited after\n'),
      (f) =>
        expect(fs.readFileSync(path.join(f.installPath, 'SKILL.md'), 'utf8')).toBe(
          '# edited after\n'
        ),
    ],
    [
      'a new file added',
      (f) => () => fs.writeFileSync(path.join(f.installPath, 'NEW.md'), 'new'),
      (f) => expect(fs.readFileSync(path.join(f.installPath, 'NEW.md'), 'utf8')).toBe('new'),
    ],
  ]
  for (const [label, edit, kept] of cases) {
    it(`${label} after the checks: kept/identity-changed, the edit preserved`, async () => {
      const f = fixture()
      const r = await uninstall(f, { force: true, seams: { afterRefusals: edit(f) } })
      expect(r.success).toBe(false)
      expect(r.notDone).toMatchObject({ status: 'kept', reason: 'identity-changed' })
      expect(r.notDone?.detail).toContain('changed after uninstall checked it')
      kept(f)
      expect(entryOf(f)).toBeDefined()
      expect(parkedEntries(f)).toEqual([])
    })
  }
})

describe('the read-hash comparison is of the whole hash', () => {
  it('a guard hash that differs only in its last character is refused before the park', async () => {
    const f = fixture()
    const before = contentSnapshot(f.installPath)
    gate.flipLast = true
    const r = await uninstall(f)
    expect(gate.calls).toBe(1)
    expect(r.notDone).toMatchObject({ status: 'kept', reason: 'identity-changed' })
    // The prepare's own refusal, not the park's later one.
    expect(r.notDone?.detail).toContain('changed after uninstall checked it')
    expect(contentSnapshot(f.installPath)).toEqual(before)
    expect(entryOf(f)).toBeDefined()
    expect(parkedEntries(f)).toEqual([])
  })
})
