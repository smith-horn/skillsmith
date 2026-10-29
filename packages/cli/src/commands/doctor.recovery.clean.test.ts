/**
 * @fileoverview `skillsmith doctor recovery --clean-staging <opId>` (A1 plan
 * §3.9, PLAN:2018; SMI-6531 step 6b-ii): T-J15's `--clean-staging` half (the
 * confirmation contract), `--unsafe-unverified-owner` (offered only with it,
 * named in the plan, never waived by `--yes`, refused without
 * `--clean-staging`), the listing's owner verdict, and the registration.
 *
 * The op dir is planted the way a swap leaves one before its record: `new/`
 * and an `owner.json` carrying O1's attribution. A dead owner is stood for by
 * an injected probe (the request seam, `doctorRecovery`'s list seam); the
 * real probe judges only the alive case, this process. Each refusal asserts
 * nothing changed (a snapshot of the whole temp home) and that no lock was
 * taken (`executeRecovery` was not called), beside a positive that acts.
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

import { MOVE_SOURCE_NO_RECORD_ORIGIN, withSkillWriteLock } from '@skillsmith/core'
import { createDoctorCommand } from './doctor.js'
import { runRecoveryAction } from './doctor.recovery.action.js'
import { runDoctorRecovery } from './doctor.recovery.js'
import type { PromptAnswer } from './doctor.recovery.action.js'
import { hermeticDiscovery } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []
let err: string[] = []
const OP = 'c'.repeat(32)

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-clean-')))
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

/** The pid `owner.json` names when the owner stands for a dead one (the probe decides, not the pid). */
const GONE_PID = 424242
/** This host, every pid gone: injected through the request seam, so no reaped pid can be reused. */
const DEAD = { host: os.hostname(), alive: (): boolean => false }
const dead = { request: { ownerProbe: DEAD } }

interface Planted {
  root: string
  opDir: string
  stateRoot: string
}

/** A no-record op dir as a swap leaves it before its record: `new/` and `owner.json` (with O1). */
function plantNoRecord(pid: number): Planted {
  const root = fs.realpathSync(path.join(base, 'clients', 'claude-code'))
  const stateRoot = path.join(base, '.skillsmith')
  fs.mkdirSync(stateRoot, { recursive: true })
  fs.mkdirSync(path.join(root, 'my-skill'))
  fs.writeFileSync(path.join(root, 'my-skill', 'SKILL.md'), '# v1\n')
  const opDir = path.join(root, '.skillsmith-staging', OP)
  fs.mkdirSync(path.join(opDir, 'new'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(opDir, 'new', 'SKILL.md'), '# staged\n')
  fs.writeFileSync(
    path.join(opDir, 'owner.json'),
    JSON.stringify({
      pid,
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
  return { root, opDir, stateRoot }
}

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

const tty = (answer: PromptAnswer) => ({ isTTY: () => true, prompt: async () => answer })

describe('T-J15 (--clean-staging half): the confirmation contract', () => {
  it('--yes: the plan is printed, then done; N kept, the op dir gone, exit 0', async () => {
    const u = plantNoRecord(GONE_PID)
    await runRecoveryAction({ cleanStaging: OP, yes: true, ...dead })
    expect(process.exitCode).toBeUndefined()
    const text = out.join('\n')
    expect(text).toContain(`Plan for --clean-staging ${OP}`)
    expect(text).toContain('N: kept as unrecorded-new')
    expect(text).toContain('owner same-host-dead')
    expect(text).toContain('Done: clean-staging')
    expect(text).toContain('kept N as unrecorded-new at')
    expect(fs.existsSync(u.opDir)).toBe(false)
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
      const u = plantNoRecord(GONE_PID)
      const before = snapshot(base)
      await runRecoveryAction({ cleanStaging: OP, ...opts, ...dead })
      expect(process.exitCode).toBe(code)
      expect(snapshot(base)).toEqual(before)
      expect(calls.executes).toBe(0)
      expect(fs.existsSync(path.join(u.opDir, 'new'))).toBe(true)
    })
  }

  it('yes at the prompt acts (the positive for the cases above)', async () => {
    const u = plantNoRecord(GONE_PID)
    await runRecoveryAction({ cleanStaging: OP, ...tty('yes'), ...dead })
    expect(process.exitCode).toBeUndefined()
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(calls.executes).toBe(1)
  })

  it('the prompt is never shown while lock 1 is held: asking under it throws', async () => {
    const u = plantNoRecord(GONE_PID)
    let asked = false
    const r = await withSkillWriteLock(u.root, 'test holder', async () =>
      runRecoveryAction({
        cleanStaging: OP,
        ...dead,
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
  })

  it('plan-changed: a file added inside new/ between confirmation and lock: exit 1, nothing kept', async () => {
    const u = plantNoRecord(GONE_PID)
    let before: string[] = []
    await runRecoveryAction({
      cleanStaging: OP,
      ...dead,
      yes: true,
      afterConfirm: () => {
        fs.writeFileSync(path.join(u.opDir, 'new', 'late.txt'), 'late\n')
        before = snapshot(base)
      },
    })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('plan-changed')
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(1)
  })
})

describe('--unsafe-unverified-owner', () => {
  it('an owner still running: refused, exit 1, naming the flag; --yes does not stand in for it', async () => {
    plantNoRecord(process.pid)
    const before = snapshot(base)
    await runRecoveryAction({ cleanStaging: OP, yes: true })
    expect(process.exitCode).toBe(1)
    const text = out.join('\n')
    expect(text).toContain('same-host-alive')
    expect(text).toContain('--unsafe-unverified-owner')
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(0)
  })

  it('with the flag: the plan names the claim and why it cannot be verified, then acts', async () => {
    const u = plantNoRecord(process.pid)
    await runRecoveryAction({ cleanStaging: OP, unsafeUnverifiedOwner: true, yes: true })
    expect(process.exitCode).toBeUndefined()
    const text = out.join('\n')
    expect(text).toContain(`owner.json names pid ${process.pid}`)
    expect(text).toContain('--unsafe-unverified-owner: its owner cannot be verified gone')
    expect(fs.existsSync(u.opDir)).toBe(false)
  })

  it('without --clean-staging: refused, exit 1, nothing planned', async () => {
    await runRecoveryAction({ apply: OP, unsafeUnverifiedOwner: true, yes: true })
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('--unsafe-unverified-owner applies only with --clean-staging')
    expect(calls.executes).toBe(0)
  })
})

describe('the listing', () => {
  it('a no-record op dir shows its owner verdict and that --clean-staging needs the flag', async () => {
    plantNoRecord(process.pid)
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain('owner verdict: same-host-alive')
    expect(text).toContain('--clean-staging needs --unsafe-unverified-owner')
    expect(text).toContain('--clean-staging: not offered (recovery-not-offered)')
  })

  it('a dead owner: the verdict, and --clean-staging offered without the flag', async () => {
    plantNoRecord(GONE_PID)
    await runDoctorRecovery({ listOptions: { ownerProbe: DEAD } })
    const text = out.join('\n')
    expect(text).toContain('owner verdict: same-host-dead')
    expect(text).not.toContain('needs --unsafe-unverified-owner')
    // The offered action's line is its command, whole: nothing follows it.
    const line = out.find((l) => l.includes(`--clean-staging: \``)) ?? ''
    expect(line.trim()).toBe(
      `--clean-staging: \`skillsmith doctor recovery --clean-staging ${OP}\``
    )
  })

  it('a stray file in the op dir with a live owner: refused whatever the flag, so the suffix is not printed', async () => {
    const u = plantNoRecord(process.pid)
    fs.writeFileSync(path.join(u.opDir, 'stray.txt'), 'x')
    await runDoctorRecovery({})
    const text = out.join('\n')
    // Presence from the same run: the live owner is read, and --clean-staging is refused.
    expect(text).toContain('owner verdict: same-host-alive')
    expect(text).toContain('--clean-staging: not offered (recovery-not-offered)')
    expect(text).toContain('so doctor cannot prove it wrote it')
    expect(text).not.toContain('needs --unsafe-unverified-owner')
  })

  /** A park intent that verifies for the op dir as planted (its identity is read from the dir). */
  function plantIntent(opDir: string, kind: 'abort-new' | 'move-source'): void {
    const s = fs.lstatSync(opDir, { bigint: true })
    const intent = {
      schema: 1,
      kind,
      opId: OP,
      owner: { pid: process.pid, host: os.hostname(), uid: process.geteuid?.() ?? -1 },
      opIdentity: {
        dev: s.dev.toString(),
        ino: s.ino.toString(),
        birthtimeNs: s.birthtimeNs.toString(),
        fmt: (s.mode & 0o170000n).toString(),
      },
      ...(kind === 'move-source' ? { backupPath: path.join(base, '.skillsmith', 'kept', OP) } : {}),
    }
    fs.writeFileSync(path.join(opDir, 'park-intent.json'), JSON.stringify(intent))
  }

  const OLD_WORDS = ['a crash before the update began', 'killed after its record was removed']

  it('no record and no intent: the update stopped before writing it, or after removing it', async () => {
    plantNoRecord(process.pid)
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(
      'no record.json (the update stopped before writing it, or after removing it)'
    )
    expect(text).not.toContain('before writing its record')
    for (const w of OLD_WORDS) expect(text).not.toContain(w)
  })

  it('a verifying abort-new intent: the update aborted and was setting it aside', async () => {
    const u = plantNoRecord(process.pid)
    plantIntent(u.opDir, 'abort-new')
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(
      'no record.json: the update aborted and was setting it aside (an abort-new park intent)'
    )
    expect(text).toContain('an abort-new park intent is present and verifies')
    for (const w of OLD_WORDS) expect(text).not.toContain(w)
  })

  it('a verifying move-source intent: both origins are named, not only an update that removed its record', async () => {
    const u = plantNoRecord(process.pid)
    plantIntent(u.opDir, 'move-source')
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(`no record.json: ${MOVE_SOURCE_NO_RECORD_ORIGIN}`)
    // Every origin that writes the intent is named, doctor's own --apply and --undo included.
    expect(text).toContain('a cross-device --apply, --undo or --clean-staging by doctor')
    for (const w of OLD_WORDS) expect(text).not.toContain(w)
  })
})

describe('through commander', () => {
  it('`doctor recovery --clean-staging <opId> --unsafe-unverified-owner --yes` runs the action', async () => {
    // The real probe, the alive case: this process owns it, so the flag is what lets it act.
    const u = plantNoRecord(process.pid)
    const cmd = createDoctorCommand()
    cmd.exitOverride()
    await cmd.parseAsync([
      'node',
      'doctor',
      'recovery',
      '--clean-staging',
      OP,
      '--unsafe-unverified-owner',
      '--yes',
    ])
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(calls.executes).toBe(1)
  })
})
