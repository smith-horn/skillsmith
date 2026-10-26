/**
 * @fileoverview `skillsmith doctor recovery --apply` / `--undo` and the
 * confirmation contract (A1 plan §3.9 items 1-7; SMI-6531 step 6a-ii, T-J15's
 * `--apply`/`--undo` half).
 *
 * Each refusal case asserts nothing changed (a snapshot of the whole temp
 * home) and that no lock was taken (`executeRecovery`, the only caller of lock
 * 1 here, was not called), beside a positive that proves the same setup acts.
 */
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

import { computeRecordSha256, withSkillWriteLock } from '@skillsmith/core'
import { createDoctorCommand } from './doctor.js'
import { runRecoveryAction } from './doctor.recovery.action.js'
import type { PromptAnswer } from './doctor.recovery.action.js'
import { hermeticDiscovery, plantCrashedUpdate } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-action-')))
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

const entry = (stateRoot: string): unknown =>
  (
    JSON.parse(fs.readFileSync(path.join(stateRoot, 'manifest.json'), 'utf8')) as {
      installedSkills: Record<string, unknown>
    }
  ).installedSkills['my-skill']

const tty = (answer: PromptAnswer) => ({
  isTTY: () => true,
  prompt: async () => answer,
})

describe('the confirmation contract', () => {
  it('--yes: the plan is printed, then done; the manifest committed and the op dir gone', async () => {
    const u = plantCrashedUpdate(base)
    await runRecoveryAction({ apply: u.opId, yes: true })
    expect(process.exitCode).toBeUndefined()
    const text = out.join('\n')
    expect(text).toContain(`Plan for --apply ${u.opId}`)
    expect(text).toContain('Done: apply')
    expect(entry(u.stateRoot)).toEqual({ version: '2.0.0' })
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(fs.existsSync(u.backupDest)).toBe(true)
    expect(calls.executes).toBe(1)
  })

  it('no terminal and no --yes: the plan, exit 3, nothing changed, no lock', async () => {
    const u = plantCrashedUpdate(base)
    const before = snapshot(base)
    await runRecoveryAction({ apply: u.opId, isTTY: () => false })
    expect(process.exitCode).toBe(3)
    expect(out.join('\n')).toContain(`Plan for --apply ${u.opId}`)
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(0)
  })

  it('--json without --yes: the plan as JSON, exit 3, nothing changed, even at a terminal', async () => {
    const u = plantCrashedUpdate(base)
    const before = snapshot(base)
    let asked = false
    await runRecoveryAction({
      undo: u.opId,
      json: true,
      isTTY: () => true,
      prompt: async () => {
        asked = true
        return 'yes'
      },
    })
    expect(process.exitCode).toBe(3)
    expect(asked).toBe(false)
    const doc = JSON.parse(out.join('\n')) as {
      plan: { status: string; plan: { action: string } }
      result: unknown
    }
    expect(doc).toMatchObject({ plan: { status: 'planned', plan: { action: 'undo' } } })
    expect(doc.result).toBeNull()
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(0)
  })

  const NO: Array<[string, PromptAnswer, number]> = [
    ['No (and empty input, and EOF)', 'no', 0],
    ['Ctrl-C', 'interrupt', 130],
  ]
  for (const [name, answer, code] of NO) {
    it(`${name} at the prompt: exit ${code}, nothing changed, no lock`, async () => {
      const u = plantCrashedUpdate(base)
      const before = snapshot(base)
      await runRecoveryAction({ apply: u.opId, ...tty(answer) })
      expect(process.exitCode).toBe(code)
      expect(snapshot(base)).toEqual(before)
      expect(calls.executes).toBe(0)
    })
  }

  it('yes at the prompt acts (the positive for the cases above)', async () => {
    const u = plantCrashedUpdate(base)
    await runRecoveryAction({ apply: u.opId, ...tty('yes') })
    expect(process.exitCode).toBeUndefined()
    expect(entry(u.stateRoot)).toEqual({ version: '2.0.0' })
  })

  it('the prompt is never shown while lock 1 is held: asking under it throws', async () => {
    const u = plantCrashedUpdate(base)
    let asked = false
    const r = await withSkillWriteLock(u.root, 'test holder', async () =>
      runRecoveryAction({
        apply: u.opId,
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
  })

  it('plan-changed: O edited between confirmation and lock stops with zero mutation', async () => {
    const u = plantCrashedUpdate(base)
    let before: string[] = []
    await runRecoveryAction({
      apply: u.opId,
      yes: true,
      afterConfirm: () => {
        fs.writeFileSync(path.join(u.opDir, 'old', 'SKILL.md'), '# edited after the prompt\n')
        before = snapshot(base)
      },
    })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('plan-changed')
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(1)
  })

  it("another user's record is refused before any lock: recovery-other-user, exit 1", async () => {
    const u = plantCrashedUpdate(base)
    const recPath = path.join(u.opDir, 'record.json')
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8')) as Record<string, unknown>
    const { recordSha256: _h, ...rest } = rec
    const body = { ...rest, uid: 424242 }
    fs.writeFileSync(
      recPath,
      JSON.stringify({ ...body, recordSha256: computeRecordSha256(body as never) })
    )
    const before = snapshot(base)
    await runRecoveryAction({ apply: u.opId, yes: true })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('recovery-other-user')
    expect(out.join('\n')).toContain('424242')
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(0)
  })

  it('exactly one of --apply and --undo', async () => {
    await runRecoveryAction({})
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('exactly one of --apply')
  })
})

describe('--json prints one document', () => {
  it('--json --yes: one JSON object holding the plan and the result', async () => {
    const u = plantCrashedUpdate(base)
    await runRecoveryAction({ apply: u.opId, json: true, yes: true })
    expect(process.exitCode).toBeUndefined()
    const doc = JSON.parse(out.join('\n')) as {
      plan: { status: string }
      result: { status: string }
    }
    expect(doc.plan.status).toBe('planned')
    expect(doc.result.status).toBe('done')
    expect(entry(u.stateRoot)).toEqual({ version: '2.0.0' })
  })

  it('--json, refused at targeting: one object with a null plan', async () => {
    plantCrashedUpdate(base)
    await runRecoveryAction({ apply: 'z'.repeat(32), json: true, yes: true })
    expect(process.exitCode).toBe(1)
    const doc = JSON.parse(out.join('\n')) as { plan: unknown; result: { status: string } }
    expect(doc.plan).toBeNull()
    expect(doc.result.status).toBe('refused')
  })
})

describe('the empty target op dir', () => {
  it('a rerun after record.json went removes the empty op dir and says so', async () => {
    const u = plantCrashedUpdate(base)
    for (const n of fs.readdirSync(u.opDir)) fs.rmSync(path.join(u.opDir, n), { recursive: true })
    expect(fs.readdirSync(u.opDir)).toEqual([])
    await runRecoveryAction({ apply: u.opId, yes: true })
    expect(process.exitCode).toBeUndefined()
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(out.join('\n')).toContain(`removed the empty directory ${u.opDir}`)
  })
})

describe('through commander', () => {
  it('`doctor recovery --undo <opId> --yes` runs the action; without the flags it lists', async () => {
    const u = plantCrashedUpdate(base)
    const cmd = createDoctorCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'doctor', 'recovery'])
    expect(out.join('\n')).toContain(`${u.opId}  S2 swapped`)
    out = []
    await cmd.parseAsync(['node', 'doctor', 'recovery', '--undo', u.opId, '--yes'])
    expect(out.join('\n')).toContain('Done: undo')
    expect(fs.readFileSync(path.join(u.skillDir, 'SKILL.md'), 'utf8')).toBe('# old\n')
    expect(entry(u.stateRoot)).toEqual({ version: '1.0.0' })
  })
})
