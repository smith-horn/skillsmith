/**
 * @fileoverview `skillsmith restore <id>` (SMI-6531 6d-ii; A1 plan §3.9): T-J15's
 * restore half (the confirmation contract), the prompt-under-lock control, the
 * telemetry wrapper and the registration. The copies are made by core's REAL
 * `parkTree`, not written by hand.
 *
 * Each refusal asserts nothing changed (a snapshot of the whole temp home) and
 * that no lock was taken (`executeRestore`, the only taker of the lock, was not
 * called), beside a positive that proves the same setup acts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ executes: 0, hooks: {} as Record<string, unknown> }))
vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    // The public entry takes no seams; a test reaches the internal one through this mock.
    executeRestore: async (plan: Parameters<typeof actual.executeRestore>[0]) => {
      calls.executes++
      const internal = await import('../../../core/src/services/skill-restore.exec.js')
      return internal.executeRestoreWith(plan, calls.hooks)
    },
  }
})

import {
  withSkillWriteLock,
  withParkedAreaLock,
  parkedLockPath,
  type RestorePlan,
} from '@skillsmith/core'
import type { RestoreHooks } from '../../../core/src/services/skill-restore.types.js'
import { runLockedForTests } from '../../../core/src/config/file-lock.parked.js'
import { appendParkedIndex } from '../../../core/src/install/parked-index.js'
import { computePathTreeHash, parkTree } from '../../../core/src/install/park-tree.js'
import { confirmOrStop, type PromptAnswer } from './confirm-gate.js'
import { runRestore } from './restore.action.js'
import { restoreJson } from './restore.render.js'
import { createRestoreCommand } from './restore.js'
import { hermeticDiscovery } from './doctor.test-helpers.js'

let base = ''
let root = ''
let out: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-')))
  root = path.join(base, 'clients', 'claude-code')
  fs.mkdirSync(root, { recursive: true })
  calls.executes = 0
  calls.hooks = {}
  out = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' ')))
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  fs.rmSync(base, { recursive: true, force: true })
})

/** A skill folder parked as `uninstall` by the real park; the copy path. */
function parked(name = 'skill-a', held = false): { copy: string; origin: string; opId: string } {
  const origin = path.join(root, name)
  fs.mkdirSync(origin)
  fs.writeFileSync(path.join(origin, 'SKILL.md'), 'skill ' + name + '\n')
  const guard = computePathTreeHash(origin)
  if (!guard.ok) throw new Error('hash')
  const opId = 'op-' + name
  const orig = fs.renameSync.bind(fs)
  if (held) {
    // The production recipe (park-call.test.ts): a write lands right after the rename.
    vi.spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      orig(a, b)
      if (String(a) === origin) fs.writeFileSync(path.join(String(b), 'late.txt'), 'late')
    }) as never)
  }
  const r = parkTree(root, name, {
    client: 'claude-code',
    caller: 'uninstall',
    kind: 'uninstall',
    opId,
    ...(held ? { guardHash: guard.treeHash } : {}),
  })
  if (held) vi.mocked(fs.renameSync).mockRestore()
  const copy = held ? r.heldPath : r.path
  if (copy == null) throw new Error('park: ' + r.status)
  return { copy, origin, opId }
}

/** Every entry under `p` with type, inode and bytes. */
function snapshot(p: string): string[] {
  const lines: string[] = []
  const walk = (abs: string): void => {
    const s = fs.lstatSync(abs, { bigint: true })
    const body = s.isFile() ? fs.readFileSync(abs).toString('base64') : ''
    lines.push(`${abs} ${s.mode} ${s.ino} ${s.isDirectory() ? '' : body}`)
    if (s.isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n))
  }
  walk(p)
  return lines
}

const base0 = () => ({
  discovery: hermeticDiscovery(base, true),
  stateRoot: path.join(base, 'state'),
})
const tty = (answer: PromptAnswer) => ({ isTTY: () => true, prompt: async () => answer })

describe('T-J15 (restore half): the confirmation contract', () => {
  it('--yes: the plan is printed, then restored; exit 0, prompt never asked', async () => {
    const p = parked()
    const prompt = vi.fn(async (): Promise<PromptAnswer> => 'yes')
    await runRestore(p.opId, { ...base0(), yes: true, prompt })
    expect(process.exitCode).toBeUndefined()
    expect(out.join('\n')).toContain(`Restore ${p.copy}`)
    expect(out.join('\n')).toContain(`Restored ${p.origin}.`)
    expect(fs.existsSync(path.join(p.origin, 'SKILL.md'))).toBe(true)
    expect(prompt).not.toHaveBeenCalled()
    expect(calls.executes).toBe(1)
  })

  const NO: Array<[string, Record<string, unknown>, number]> = [
    ['no terminal', { isTTY: () => false }, 3],
    [
      '--json at a terminal',
      { json: true, isTTY: () => true, prompt: async () => 'no' as PromptAnswer },
      3,
    ],
    ['No (and empty input, and EOF)', tty('no'), 0],
    ['Ctrl-C', tty('interrupt'), 130],
  ]
  for (const [name, opts, code] of NO) {
    it(`${name}: exit ${code}, nothing changed, no lock`, async () => {
      const p = parked()
      const disc = base0()
      const before = snapshot(base)
      await runRestore(p.opId, { ...disc, ...opts })
      expect(process.exitCode ?? 0).toBe(code)
      expect(snapshot(base)).toEqual(before)
      expect(calls.executes).toBe(0)
      expect(fs.existsSync(p.origin)).toBe(false)
      expect(fs.existsSync(path.join(root, '.skillsmith-writes.lock'))).toBe(false)
      expect(fs.existsSync(path.join(base, 'state', 'locks'))).toBe(false)
    })
  }

  it('--json at a terminal prints a parseable plan with status planned', async () => {
    const p = parked()
    await runRestore(p.opId, { ...base0(), json: true, isTTY: () => true })
    const doc = JSON.parse(out.join('\n')) as { status: string; plan: { copyPath: string } }
    expect(doc.status).toBe('planned')
    expect(doc.plan.copyPath).toBe(p.copy)
  })

  it('yes at the prompt acts (the positive for the cases above)', async () => {
    const p = parked()
    await runRestore(p.opId, { ...base0(), ...tty('yes') })
    expect(process.exitCode).toBeUndefined()
    expect(fs.existsSync(path.join(p.origin, 'SKILL.md'))).toBe(true)
    expect(calls.executes).toBe(1)
  })

  it('plan-changed: a byte appended to the copy after the confirmation stops with exit 1, nothing restored', async () => {
    const p = parked()
    await runRestore(p.opId, {
      ...base0(),
      yes: true,
      afterConfirm: () => fs.appendFileSync(path.join(p.copy, 'SKILL.md'), 'edit'),
    })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('changed after you confirmed')
    expect(fs.existsSync(p.origin)).toBe(false)
    expect(fs.existsSync(p.copy)).toBe(true)
  })

  it('plan-changed for a held copy: an edit after the confirmation changes the hash, not the class, and still stops', async () => {
    const p = parked('skill-h', true)
    await runRestore(p.opId, {
      ...base0(),
      yes: true,
      afterConfirm: () => fs.appendFileSync(path.join(p.copy, 'late.txt'), ' more'),
    })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('changed after you confirmed')
    expect(fs.existsSync(p.origin)).toBe(false)
  })

  it('a refusal prints "Nothing was restored." and exits 1; --json carries the reason', async () => {
    await runRestore('no-such-op', { ...base0(), yes: true })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('Nothing was restored.')
    out = []
    process.exitCode = undefined
    await runRestore('no-such-op', { ...base0(), yes: true, json: true })
    expect((JSON.parse(out.join('\n')) as { reason: string }).reason).toBe('restore-not-found')
  })

  it('a blank --state-root or --root is refused before anything is read', async () => {
    await runRestore('x', { stateRoot: '  ' })
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    await runRestore('x', { root: ['/a', ''] })
    expect(process.exitCode).toBe(1)
    expect(calls.executes).toBe(0)
  })
})

describe('the prompt is never shown while a skills-root lock is held', () => {
  const gate = (): Promise<'proceed' | 'stop'> =>
    confirmOrStop(
      { isTTY: () => true, prompt: async () => 'yes' },
      () => undefined,
      'restore: prompt'
    )

  it('inside lock 1 the gate throws held-while-planning', async () => {
    await expect(withSkillWriteLock(root, 'test', async () => gate())).rejects.toThrow(
      /prompt ran while holding/
    )
  })

  it('inside lock 1prime the gate throws held-while-planning', async () => {
    const lockPath = parkedLockPath(path.join(base, 'state'), root)
    fs.mkdirSync(path.join(base, 'state'), { recursive: true })
    await expect(withParkedAreaLock(lockPath, 'test', async () => gate())).rejects.toThrow(
      /prompt ran while holding/
    )
  })

  it('outside any lock the gate proceeds (the positive)', async () => {
    await expect(gate()).resolves.toBe('proceed')
  })
})

describe('restore.render: the plan JSON carries the lock disagreement', () => {
  it('plan.lockDisagreement is { prune, restore }', () => {
    const lock = { kind: 'lock1', root: '/r', path: '/r/.skillsmith-writes.lock' } as const
    const plan = {
      copyPath: '/c',
      opId: 'o',
      kind: 'uninstall',
      held: false,
      type: 'directory',
      origin: '/o',
      lock,
      bytes: 1,
      contents: { state: 'unchanged' },
      lockNote: 'note',
      lockDisagreement: { prune: { kind: 'unknown', reason: 'why' }, restore: lock },
      digest: 'd',
    } as unknown as RestorePlan
    const doc = JSON.parse(
      restoreJson({ status: 'planned', reason: null, plan, result: null })
    ) as {
      plan: { lockDisagreement: unknown; lockNote: string }
    }
    expect(doc.plan.lockDisagreement).toEqual({
      prune: { kind: 'unknown', reason: 'why' },
      restore: lock,
    })
    expect(doc.plan.lockNote).toBe('note')
  })
})

describe('a stranded lock claim is reported in the text and the JSON', () => {
  it('lock 1prime with locks/ swapped after the claim', async () => {
    const outsideDir = path.join(base, 'proj-outside')
    fs.mkdirSync(outsideDir)
    const origin = path.join(outsideDir, 'skill-i')
    fs.mkdirSync(origin)
    fs.writeFileSync(path.join(origin, 'SKILL.md'), 'x')
    const r = parkTree(outsideDir, 'skill-i', {
      client: 'claude-code',
      caller: 'init-rollback',
      kind: 'init-rollback',
      opId: 'op-i',
    })
    const stateRoot = path.join(base, 'state')
    fs.mkdirSync(stateRoot)
    appendParkedIndex(path.join(stateRoot, 'parked-index.jsonl'), {
      path: r.path as string,
      opId: 'op-i',
      client: 'claude-code',
      kind: 'init-rollback',
      createdAt: new Date().toISOString(),
    })
    const locks = path.join(stateRoot, 'locks')
    let swaps = 0
    const runLock: NonNullable<RestoreHooks['runLock']> = (lp, label, fn, o) =>
      runLockedForTests(lp, label, fn, {
        ...(o ?? {}),
        hooks: {
          beforeFn: () => {
            fs.renameSync(locks, locks + '.moved' + String(++swaps))
            fs.mkdirSync(locks)
          },
        },
      }) as ReturnType<NonNullable<RestoreHooks['runLock']>>
    calls.hooks = { runLock }
    const opts = {
      discovery: hermeticDiscovery(base, true),
      stateRoot,
      yes: true,
    }
    await runRestore('op-i', opts)
    const text = out.join('\n')
    expect(text).toContain(
      'The lock folder `' + locks + '` was replaced while restore held its lock'
    )
    expect(text).toContain('Skillsmith will reclaim it once this process has exited')
    out = []
    process.exitCode = undefined
    await runRestore('op-i', { ...opts, json: true })
    const doc = JSON.parse(out.join('\n')) as {
      result: {
        strandedLockClaim: { lockName: string; locksDir: { dev: string }; detail: string }
      } | null
    }
    // The first run already stopped; the second finds the copy still parked and strands again.
    expect(doc.result?.strandedLockClaim.lockName).toMatch(/^parked-[0-9a-f]{16}\.lock$/)
    expect(typeof doc.result?.strandedLockClaim.locksDir.dev).toBe('string')
  })
})

describe('registration', () => {
  it('index.ts adds the command to the program', () => {
    const src = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    expect(src).toContain('program.addCommand(createRestoreCommand())')
  })

  it('restore is a command taking <id>, --yes, --json, --root and --state-root', () => {
    const c = createRestoreCommand()
    expect(c.name()).toBe('restore')
    const flags = c.options.map((o) => o.long)
    expect(flags).toEqual(expect.arrayContaining(['--root', '--state-root', '--json', '--yes']))
  })
})
