/**
 * @fileoverview T-PW1's doctor half (SMI-6531 step 6c-ii-a, UD66, owner
 * decision D8): every `doctor recovery` action that sets a folder aside prints
 * the space warning on stderr, in the words "set-aside folders" and never
 * "trash", and one that sets nothing aside prints nothing. The threshold is
 * forced to one byte through the `parkedUsage` seam so that any held tree is
 * over it: a run that printed no warning for the wrong reason would show.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ discovery: {} as Record<string, unknown> }))
vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    discoverRoots: (o: Parameters<typeof actual.discoverRoots>[0]) =>
      actual.discoverRoots({ ...o, ...calls.discovery }),
  }
})

import type { RecoveryRunResult } from '@skillsmith/core'
import { runDoctorBackups } from './doctor.backups.js'
import { parked, runRecoveryAction } from './doctor.recovery.action.js'
import { hermeticDiscovery, plantCrashedUpdate } from './doctor.test-helpers.js'
import type { PlantedUpdate } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []
let err: string[] = []
const shm: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pw1-')))
  calls.discovery = hermeticDiscovery(base, true)
  process.env['SKILLSMITH_JOURNAL_DIR'] = path.join(base, 'journal')
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  delete process.env['SKILLSMITH_JOURNAL_DIR']
  fs.rmSync(base, { recursive: true, force: true })
  for (const d of shm.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const loud = { parkedUsage: { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 1 } }
const WORDS = "Skillsmith's set-aside folders on this disk hold"

/** A crashed update whose state root (and so its backup area) is on another device. */
function plantAcross(): PlantedUpdate {
  const stateRoot = fs.realpathSync(fs.mkdtempSync('/dev/shm/doctor-pw1-'))
  shm.push(stateRoot)
  const u = plantCrashedUpdate(base, 'a'.repeat(32), stateRoot)
  expect(fs.statSync(stateRoot).dev).not.toBe(fs.statSync(u.root).dev)
  return u
}

/** The same, with the op dir renamed so only `--abandon` acts on it. */
function plantMovedAcross(): PlantedUpdate {
  const u = plantAcross()
  const moved = 'b'.repeat(32)
  const to = path.join(path.dirname(u.opDir), moved)
  fs.renameSync(u.opDir, to)
  return { ...u, opId: moved, opDir: to }
}

/** A record that no longer verifies: unreadable, parked whole by `--park`. */
function plantUnreadable(): PlantedUpdate {
  const u = plantCrashedUpdate(base)
  const rec = path.join(u.opDir, 'record.json')
  const body = JSON.parse(fs.readFileSync(rec, 'utf8')) as { pid: number }
  body.pid += 1
  fs.writeFileSync(rec, JSON.stringify(body))
  return u
}

const CLEAN_OP = 'c'.repeat(32)
/** This host, every pid gone: injected through the request seam, so no reaped pid can be reused. */
const DEAD = { request: { ownerProbe: { host: os.hostname(), alive: (): boolean => false } } }

/** A no-record op dir as a swap leaves it before its record: `new/` and `owner.json`. */
function plantNoRecord(stateRoot: string): { root: string; opDir: string } {
  const root = fs.realpathSync(path.join(base, 'clients', 'claude-code'))
  fs.mkdirSync(path.join(root, 'my-skill'))
  fs.writeFileSync(path.join(root, 'my-skill', 'SKILL.md'), '# v1\n')
  const opDir = path.join(root, '.skillsmith-staging', CLEAN_OP)
  fs.mkdirSync(path.join(opDir, 'new'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(opDir, 'new', 'SKILL.md'), '# staged\n')
  fs.writeFileSync(
    path.join(opDir, 'owner.json'),
    JSON.stringify({
      pid: 424242,
      host: os.hostname(),
      uid: process.geteuid?.() ?? -1,
      createdAt: new Date().toISOString(),
      client: 'claude-code',
      scope: 'global',
      dirName: 'my-skill',
      manifestKey: 'my-skill',
      stateRoot: fs.realpathSync.native(stateRoot),
    })
  )
  return { root, opDir }
}

const assertWarned = (): void => {
  const e = err.join('\n')
  expect(e).toContain(WORDS)
  expect(e).toContain('skillsmith doctor backups')
  expect(e).not.toMatch(/trash/i)
  expect(out.join('\n')).not.toContain(WORDS)
  expect(out.join('\n')).not.toMatch(/trash/i)
}

describe('T-PW1 (doctor half): every action that parks prints the warning on stderr', () => {
  it('--park', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({ park: u.opId, yes: true, ...loud })
    expect(fs.existsSync(u.opDir)).toBe(false)
    assertWarned()
    expect(err.join('\n')).toContain(u.opId)
  })

  it('--apply across devices (the op dir is parked)', async () => {
    const u = plantAcross()
    await runRecoveryAction({ apply: u.opId, yes: true, ...loud })
    expect(fs.existsSync(u.opDir)).toBe(false)
    assertWarned()
  })

  it('--undo across devices (the op dir is parked)', async () => {
    const u = plantAcross()
    await runRecoveryAction({ undo: u.opId, yes: true, ...loud })
    expect(fs.existsSync(u.opDir)).toBe(false)
    assertWarned()
  })

  it('--abandon across devices (the op dir is parked)', async () => {
    const u = plantMovedAcross()
    await runRecoveryAction({ abandon: u.opId, yes: true, ...loud })
    expect(fs.existsSync(u.opDir)).toBe(false)
    assertWarned()
  })

  it('--clean-staging across devices (the op dir is parked)', async () => {
    const stateRoot = fs.realpathSync(fs.mkdtempSync('/dev/shm/doctor-pw1-'))
    shm.push(stateRoot)
    const u = plantNoRecord(stateRoot)
    expect(fs.statSync(stateRoot).dev).not.toBe(fs.statSync(u.root).dev)
    await runRecoveryAction({ cleanStaging: CLEAN_OP, yes: true, stateRoot, ...DEAD, ...loud })
    expect(fs.existsSync(u.opDir)).toBe(false)
    assertWarned()
  })

  it('an action that sets nothing aside prints nothing, though the same threshold is over', async () => {
    const u = plantCrashedUpdate(base)
    await runRecoveryAction({ apply: u.opId, yes: true, ...loud })
    expect(process.exitCode).toBeUndefined()
    expect(fs.existsSync(u.backupDest)).toBe(true)
    expect(err.join('\n')).not.toContain(WORDS)
    expect(err).toEqual([])
  })

  it('a refused or declined action prints nothing', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({ park: u.opId, isTTY: () => false, ...loud })
    expect(process.exitCode).toBe(3)
    expect(err.join('\n')).not.toContain(WORDS)
  })
})

describe('SMI-7127 through the doctor actions: entries that could not be measured', () => {
  const oneUnmeasured = () => ({
    allocatedBytes: 4096,
    apparentBytes: 10,
    unmeasured: 1,
    units: new Map([['1:1', 4096]]),
  })
  /** The threshold stays at its default, so only the unmeasured entry can warn. */
  it('--park prints the line on stderr though the total is far below the threshold', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({ park: u.opId, yes: true, measure: oneUnmeasured })
    const e = err.join('\n')
    expect(e).toMatch(/\d+ entr(y|ies) could not be measured/)
    expect(e).toContain("Skillsmith's set-aside folders on this disk hold at least")
    expect(e).not.toMatch(/trash/i)
  })

  it('the same run with every entry measured prints nothing', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({ park: u.opId, yes: true })
    expect(err).toEqual([])
  })
})

describe('D8: the predicate that says a park happened', () => {
  const done = (over: Record<string, unknown>): RecoveryRunResult =>
    ({
      status: 'done',
      opId: 'a',
      action: 'apply',
      from: 'S2',
      installed: null,
      kept: [],
      extraCopy: null,
      manifest: 'committed',
      audit: { kind: 'none' },
      warnings: [],
      swept: {},
      ...over,
    }) as unknown as RecoveryRunResult
  const stopped = (opDir?: { path: string; stillThere: boolean }): RecoveryRunResult =>
    ({
      status: 'stopped',
      opId: 'a',
      reason: 'r',
      detail: 'd',
      recordPath: null,
      warnings: [],
      opDir,
    }) as never

  it('is true for a kept OP tree (--park, --clean-staging finishing abort-new)', () => {
    expect(parked(done({ kept: [{ tree: 'OP', kind: 'abort-new', path: '/p' }] }))).toBe(true)
    expect(parked(done({ kept: [{ tree: 'O', kind: 'backup', path: '/p' }] }))).toBe(false)
  })

  it('is true for an extra copy, and for a held park that names where it moved', () => {
    expect(parked(done({ extraCopy: '/p' }))).toBe(true)
    expect(
      parked(
        done({
          warnings: [
            {
              code: 'removal-not-done',
              path: '/op',
              status: 'held',
              reason: 'r',
              parkedPath: '/held',
            },
          ],
        })
      )
    ).toBe(true)
  })

  it('is false when a park was refused before it moved anything', () => {
    expect(
      parked(
        done({ warnings: [{ code: 'removal-not-done', path: '/op', status: 'kept', reason: 'r' }] })
      )
    ).toBe(false)
    expect(parked(done({}))).toBe(false)
  })

  it('a stop is a park only when the op dir is no longer where it was', () => {
    expect(parked(stopped({ path: '/op', stillThere: false }))).toBe(true)
    expect(parked(stopped({ path: '/op', stillThere: true }))).toBe(false)
    expect(parked(stopped(undefined))).toBe(false)
  })
})

describe('F6: the warning is not lost when the rest of the action throws', () => {
  /** A held set-aside folder under the hermetic Claude root, so the loud threshold has something to count. */
  function plantHeld(): string {
    const copy = path.join(
      base,
      'clients',
      'claude-code',
      '.skillsmith-parked',
      'op-0',
      'foo-12345678'
    )
    fs.mkdirSync(copy, { recursive: true })
    fs.writeFileSync(path.join(copy, 'SKILL.md'), 's'.repeat(6000))
    return copy
  }

  it('doctor backups: a listing that cannot be printed (EPIPE) still warns on stderr', async () => {
    plantHeld()
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('EPIPE')
    })
    await expect(
      runDoctorBackups({ discovery: hermeticDiscovery(base, true), ...loud })
    ).rejects.toThrow('EPIPE')
    expect(err.join('\n')).toContain(WORDS)
  })

  it('--park: a result that cannot be printed after the park moved still warns', async () => {
    const u = plantUnreadable()
    vi.spyOn(console, 'log').mockImplementation(() => {
      if (!fs.existsSync(u.opDir)) throw new Error('EPIPE')
    })
    await expect(runRecoveryAction({ park: u.opId, yes: true, ...loud })).rejects.toThrow('EPIPE')
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(err.join('\n')).toContain(WORDS)
  })

  it('an action that throws after confirmation leaves the outcome unknown, so it warns', async () => {
    plantHeld()
    const u = plantUnreadable()
    const runOptions = {
      afterReplan: () => {
        throw new Error('boom')
      },
    }
    await expect(
      runRecoveryAction({ park: u.opId, yes: true, runOptions, ...loud })
    ).rejects.toThrow('boom')
    expect(err.join('\n')).toContain(WORDS)
  })
})
