/**
 * @fileoverview `skillsmith doctor recovery --park <opId>` (A1 plan §3.9,
 * PLAN:2019; SMI-6531 step 6b-i): T-J15's `--park` half (the confirmation
 * contract), T-X17's `doctor-park` row (a park that does not finish exits 4,
 * UD32), O3b at the command, and the registration.
 *
 * Each refusal asserts nothing changed (a snapshot of the whole temp home) and
 * that no lock was taken (`executeRecovery`, the only caller of lock 1 here,
 * was not called), beside a positive that proves the same setup acts.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ discovery: {} as Record<string, unknown>, executes: 0 }))
vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    discoverRoots: (o: Parameters<typeof actual.discoverRoots>[0]) =>
      actual.discoverRoots({ ...o, ...calls.discovery }),
    executeRecovery: (...a: Parameters<typeof actual.executeRecovery>) => {
      calls.executes++
      return actual.executeRecovery(...a)
    },
  }
})

import { withSkillWriteLock } from '@skillsmith/core'
import { createDoctorCommand } from './doctor.js'
import { runRecoveryAction } from './doctor.recovery.action.js'
import { runDoctorRecovery } from './doctor.recovery.js'
import type { PromptAnswer } from './doctor.recovery.action.js'
import { hermeticDiscovery, plantCrashedUpdate } from './doctor.test-helpers.js'
import type { PlantedUpdate } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-park-')))
  calls.discovery = hermeticDiscovery(base, true)
  calls.executes = 0
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
})

/** Every entry under `p` with its type, inode and bytes; directory mtimes and lock files left out. */
function snapshot(p: string): string[] {
  const lines: string[] = []
  const walk = (abs: string): void => {
    const s = fs.lstatSync(abs, { bigint: true })
    if (path.basename(abs).startsWith('.skillsmith-writes.lock')) return
    const body = s.isFile() ? fs.readFileSync(abs).toString('base64') : ''
    lines.push(`${abs} ${s.mode} ${s.ino} ${s.isDirectory() ? '' : `${s.nlink} ${body}`}`)
    if (s.isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n))
  }
  walk(p)
  return lines
}

/** A crashed update whose record no longer matches its hash: unreadable, the whole root blocked. */
function plantUnreadable(): PlantedUpdate {
  const u = plantCrashedUpdate(base)
  const rec = path.join(u.opDir, 'record.json')
  const body = JSON.parse(fs.readFileSync(rec, 'utf8')) as { pid: number }
  body.pid += 1
  fs.writeFileSync(rec, JSON.stringify(body))
  return u
}

const parkedArea = (u: PlantedUpdate): string =>
  path.join(u.root, '.skillsmith-staging', '.skillsmith-parked', u.opId)

const tty = (answer: PromptAnswer) => ({ isTTY: () => true, prompt: async () => answer })

describe('T-J15 (--park half): the confirmation contract', () => {
  it('--yes: the plan is printed, then done; OP is parked and exit is 0', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({ park: u.opId, yes: true })
    expect(process.exitCode).toBeUndefined()
    const text = out.join('\n')
    expect(text).toContain(`Plan for --park ${u.opId}`)
    expect(text).toContain('OP: kept as unreadable-record')
    expect(text).toContain('Done: park')
    expect(text).toContain('the whole op dir was set aside as unreadable-record')
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(fs.readdirSync(parkedArea(u))).toHaveLength(2)
    expect(calls.executes).toBe(1)
  })

  const NO: Array<[string, Record<string, unknown>, number]> = [
    ['no terminal', { isTTY: () => false }, 3],
    ['--json at a terminal', { json: true, isTTY: () => true }, 3],
    ['No (and empty input, and EOF)', tty('no'), 0],
    ['Ctrl-C', tty('interrupt'), 130],
  ]
  for (const [name, opts, code] of NO) {
    it(`${name}: exit ${code}, nothing changed, no lock`, async () => {
      const u = plantUnreadable()
      const before = snapshot(base)
      await runRecoveryAction({ park: u.opId, ...opts })
      expect(process.exitCode).toBe(code)
      expect(snapshot(base)).toEqual(before)
      expect(calls.executes).toBe(0)
      expect(fs.existsSync(path.join(u.opDir, 'record.json'))).toBe(true)
    })
  }

  it('yes at the prompt acts (the positive for the cases above)', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({ park: u.opId, ...tty('yes') })
    expect(process.exitCode).toBeUndefined()
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(calls.executes).toBe(1)
  })

  it('the prompt is never shown while lock 1 is held: asking under it throws', async () => {
    const u = plantUnreadable()
    let asked = false
    const r = await withSkillWriteLock(u.root, 'test holder', async () =>
      runRecoveryAction({
        park: u.opId,
        isTTY: () => true,
        prompt: async () => {
          asked = true
          return 'yes'
        },
      }).then(
        () => null,
        (e: unknown) => e
      )
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as Error).name).toBe('LockOrderError')
    expect(asked).toBe(false)
    expect(calls.executes).toBe(0)
    expect(fs.existsSync(path.join(u.opDir, 'record.json'))).toBe(true)
  })

  it('plan-changed: a file added inside OP between confirmation and lock: exit 1, nothing moved', async () => {
    const u = plantUnreadable()
    let before: string[] = []
    await runRecoveryAction({
      park: u.opId,
      yes: true,
      afterConfirm: () => {
        fs.writeFileSync(path.join(u.opDir, 'old', 'late.txt'), 'late\n')
        before = snapshot(base)
      },
    })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('plan-changed')
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(1)
    expect(fs.existsSync(parkedArea(u))).toBe(false)
  })

  it("O3b: another user's op dir is refused before any lock: recovery-other-user, exit 1", async () => {
    const u = plantUnreadable()
    const before = snapshot(base)
    vi.spyOn(process, 'geteuid').mockReturnValue((process.geteuid?.() ?? 0) + 1)
    await runRecoveryAction({ park: u.opId, yes: true })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('recovery-other-user')
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(0)
  })

  it('--park on a record that verifies is refused with zero mutation, exit 1', async () => {
    const u = plantCrashedUpdate(base)
    const before = snapshot(base)
    await runRecoveryAction({ park: u.opId, yes: true })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('recovery-not-offered')
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(0)
  })

  it('exactly one action: --park with --apply is refused', async () => {
    await runRecoveryAction({ park: 'a'.repeat(32), apply: 'a'.repeat(32) })
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('exactly one of --apply')
  })
})

describe('T-X17 (doctor-park row): a park that does not finish is removal-not-done, exit 4', () => {
  const nulls = {
    reason: null,
    path: null,
    entry: null,
    treeHash: null,
    errno: null,
    opId: null,
    sidecarPath: null,
    detail: null,
    originPath: null,
    heldPath: null,
    misplaced: null,
    parkedAreaCreated: null,
  }
  const OUTCOMES = [
    ['kept', { status: 'kept', reason: 'mount-inside-tree' }],
    ['stopped (EIO)', { status: 'stopped', reason: 'guard-unreadable', errno: 'EIO' }],
    ['stopped (EACCES)', { status: 'stopped', reason: 'park-failed', errno: 'EACCES' }],
    ['held', { status: 'held', reason: 'changed-during-move' }],
  ] as const
  for (const [label, r] of OUTCOMES) {
    it(`${label}: done, removal-not-done with its status and reason, no restore line, exit 4`, async () => {
      const u = plantUnreadable()
      const heldAt = path.join(parkedArea(u), `${u.opId}-held0000`)
      const held = r.status === 'held'
      await runRecoveryAction({
        park: u.opId,
        yes: true,
        runOptions: {
          swap: {
            park: async () => {
              // A held park moved OP: the stub moves it, as the port would.
              if (held) {
                fs.mkdirSync(path.dirname(heldAt), { recursive: true })
                fs.renameSync(u.opDir, heldAt)
              }
              return { ...nulls, ...r, ...(held ? { path: heldAt } : {}) } as never
            },
          },
        },
      })
      expect(process.exitCode).toBe(4)
      const text = out.join('\n')
      expect(text).toContain('Done: park')
      expect(text).toContain(`(${r.status}/${r.reason}`)
      expect(text).not.toContain('skillsmith restore')
      if (held) {
        expect(text).toContain(`was moved to ${heldAt} but is held there`)
        expect(text).toContain('no longer blocks writes')
        expect(fs.existsSync(heldAt)).toBe(true)
        expect(fs.existsSync(u.opDir)).toBe(false)
      } else {
        expect(text).toContain(`the op dir ${u.opDir} was not set aside`)
        expect(text).toContain('the skills root stays blocked')
        expect(text).toContain(`run \`skillsmith doctor recovery --park ${u.opId}\` again`)
        // Nothing of OP was removed.
        expect(fs.readdirSync(u.opDir).sort()).toEqual(['old', 'record.json'])
      }
    })
  }

  it('the control: the real park finishes, exit 0, no warning', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({ park: u.opId, yes: true })
    expect(process.exitCode).toBeUndefined()
    expect(out.join('\n')).not.toContain('removal-not-done')
  })
})

describe('a --park that stops says truthfully where the op dir is', () => {
  it('a stop before the park (beforePark throws): exit 1, "nothing was moved", the op dir named, never "no record is kept"', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({
      park: u.opId,
      yes: true,
      runOptions: {
        swap: {
          hooks: {
            beforePark: () => {
              throw new Error('killed before the park')
            },
          },
        },
      },
    })
    expect(process.exitCode).toBe(1)
    const text = out.join('\n')
    expect(text).toContain('Stopped (')
    expect(text).toContain(`nothing was moved; the op dir is still at ${u.opDir}`)
    expect(text).not.toContain('no record is kept')
    expect(fs.existsSync(path.join(u.opDir, 'record.json'))).toBe(true)
  })

  it('a stop after the rename (afterPark throws): exit 1, the op dir is no longer there, never "nothing was moved"', async () => {
    const u = plantUnreadable()
    await runRecoveryAction({
      park: u.opId,
      yes: true,
      runOptions: {
        swap: {
          hooks: {
            afterPark: () => {
              throw new Error('killed after the park')
            },
          },
        },
      },
    })
    expect(process.exitCode).toBe(1)
    const text = out.join('\n')
    expect(text).toContain(`the op dir is no longer at ${u.opDir}`)
    expect(text).not.toContain('nothing was moved')
    expect(text).not.toContain('no record is kept')
    expect(fs.existsSync(u.opDir)).toBe(false)
  })
})

describe("the listing names a guard failure in the guard walk's own word", () => {
  it('a FIFO at record.json lists "guard-unsupported-type", not the hash function\'s word', async () => {
    const u = plantCrashedUpdate(base)
    const rec = path.join(u.opDir, 'record.json')
    fs.rmSync(rec)
    execFileSync('mkfifo', [rec])
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(`guard walk failed: guard-unsupported-type at ${rec}`)
    expect(text).not.toContain('unsupported-entry')
    // The --park refusal beside it uses the same word.
    expect(text).toContain('--park: not offered (recovery-not-offered)')
  })
})

describe('through commander', () => {
  it('registers --park and (6b-ii) --clean-staging visibly, and not --abandon yet', () => {
    const recovery = createDoctorCommand().commands.find((c) => c.name() === 'recovery')!
    const flags = recovery.options.map((o) => o.long ?? '')
    expect(flags).toContain('--park')
    expect(flags).toContain('--clean-staging')
    expect(flags).toContain('--unsafe-unverified-owner')
    expect(flags).not.toContain('--abandon')
    expect(recovery.options.find((o) => o.long === '--park')?.hidden).toBe(false)
    expect(recovery.options.find((o) => o.long === '--clean-staging')?.hidden).toBe(false)
    expect(recovery.helpInformation()).toContain('--park <opId>')
    expect(recovery.helpInformation()).toContain('--clean-staging <opId>')
  })

  it('`doctor recovery --park <opId> --yes` runs the action', async () => {
    const u = plantUnreadable()
    const cmd = createDoctorCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'doctor', 'recovery', '--park', u.opId, '--yes'])
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(calls.executes).toBe(1)
  })
})
