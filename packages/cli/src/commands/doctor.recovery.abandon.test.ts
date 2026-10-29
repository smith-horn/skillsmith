/**
 * @fileoverview `skillsmith doctor recovery --abandon <opId>` (A1 plan §3.9,
 * PLAN:2022; SMI-6531 step 6b-iii): the confirmation contract (T-J15's
 * `--abandon` half), the listing's line, the refusal on a row, and the
 * registration through commander.
 *
 * Each refusal asserts nothing changed (a snapshot of the whole temp home) and
 * that no lock was taken (`executeRecovery`, the only caller of lock 1 here,
 * was not called), beside a positive that proves the same setup acts.
 */
import { createHash } from 'node:crypto'
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

import { createDoctorCommand } from './doctor.js'
import { runRecoveryAction } from './doctor.recovery.action.js'
import type { PromptAnswer } from './doctor.recovery.action.js'
import { resultLines } from './doctor.recovery.action.render.js'
import { runDoctorRecovery } from './doctor.recovery.js'
import { hermeticDiscovery, plantCrashedUpdate } from './doctor.test-helpers.js'
import type { PlantedUpdate } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-abandon-')))
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

/** Every entry under `p` with its type, inode and bytes; lock files left out. */
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

const MOVED = 'b'.repeat(32)

/** The planted S2 with its op dir renamed: the record names another op dir (moved, `--abandon` only). */
function plantMoved(): PlantedUpdate & { area: string } {
  const u = plantCrashedUpdate(base)
  const to = path.join(path.dirname(u.opDir), MOVED)
  fs.renameSync(u.opDir, to)
  return { ...u, opId: MOVED, opDir: to, area: path.dirname(u.backupDest) }
}

const tty = (answer: PromptAnswer) => ({ isTTY: () => true, prompt: async () => answer })

describe('T-J15 (--abandon half): the confirmation contract', () => {
  it('--yes: the plan, then done; O kept as abandoned-old under the op dir’s own name; exit 0', async () => {
    const u = plantMoved()
    await runRecoveryAction({ abandon: u.opId, yes: true })
    expect(process.exitCode).toBeUndefined()
    const text = out.join('\n')
    expect(text).toContain(`Plan for --abandon ${u.opId}`)
    expect(text).toContain('O: kept as abandoned-old')
    expect(text).toContain(`Done: abandon of ${u.opId}`)
    const dest = path.join(u.area, `${MOVED}.abandoned-old`)
    expect(text).toContain(`kept O as abandoned-old at ${dest}`)
    expect(fs.existsSync(dest)).toBe(true)
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
      const u = plantMoved()
      const before = snapshot(base)
      await runRecoveryAction({ abandon: u.opId, ...opts })
      expect(process.exitCode).toBe(code)
      expect(snapshot(base)).toEqual(before)
      expect(calls.executes).toBe(0)
      expect(fs.existsSync(path.join(u.opDir, 'record.json'))).toBe(true)
    })
  }

  it('yes at the prompt acts (the positive for the cases above)', async () => {
    const u = plantMoved()
    await runRecoveryAction({ abandon: u.opId, ...tty('yes') })
    expect(process.exitCode).toBeUndefined()
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(calls.executes).toBe(1)
  })

  it('--abandon of a row (S2) is refused before any lock, naming --apply; exit 1, nothing changed', async () => {
    const u = plantCrashedUpdate(base)
    const before = snapshot(base)
    await runRecoveryAction({ abandon: u.opId, yes: true })
    expect(process.exitCode).toBe(1)
    const text = out.join('\n')
    expect(text).toContain('recovery-not-offered')
    expect(text).toContain('--apply')
    expect(snapshot(base)).toEqual(before)
    expect(calls.executes).toBe(0)
  })

  it('exactly one action: --abandon with --undo is refused', async () => {
    await runRecoveryAction({ abandon: MOVED, undo: MOVED })
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('--abandon <opId>')
  })
})

describe('the listing and commander', () => {
  it('lists --abandon for a moved op as its command, ending there', async () => {
    const u = plantMoved()
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(`${u.opId}  moved (foreign-op-dir)`)
    expect(text).toContain(`--abandon: \`skillsmith doctor recovery --abandon ${u.opId}\`\n`)
  })

  it("a moved op's backup line names the scanned root's area, not the record's", async () => {
    // foreign-op-dir: same root, so the area is the record's, but the name is the op dir's own.
    const u = plantMoved()
    // And a copy of it in another discovered root, whose area is keyed by that root.
    const other = fs.realpathSync(path.join(base, 'clients', 'cursor'))
    fs.cpSync(u.root, other, { recursive: true })
    await runDoctorRecovery({})
    const text = out.join('\n')
    const recordLine = `    backup: ${u.backupDest}\n`
    const key = createHash('sha256').update(other).digest('hex').slice(0, 16)
    const otherArea = path.join(
      fs.realpathSync(u.stateRoot),
      'backups',
      'update',
      'claude-code',
      key,
      'my-skill'
    )
    expect(text).toContain(`    backup: ${path.join(u.area, MOVED)}\n`)
    expect(text).toContain(`    backup: ${path.join(otherArea, MOVED)}\n`)
    // Presence first, then the absence: neither moved op names the record's backupDest.
    expect(text).toContain('2 operation directories found')
    expect(text.split(`${MOVED}  moved (`)).toHaveLength(3)
    expect(text).not.toContain(recordLine)
  })

  it('a row whose op dir holds a .DS_Store is listed as its row, with --apply and --undo saying why', async () => {
    const u = plantCrashedUpdate(base)
    const stray = path.join(u.opDir, '.DS_Store')
    fs.writeFileSync(stray, 'finder\n')
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(`${u.opId}  S2 swapped`)
    for (const flag of ['--apply', '--undo']) {
      expect(text).toContain(`${flag}: not offered (recovery-not-offered): ${stray} is not a file`)
    }
  })

  it('a role-less copy temp kept at tree OP prints as a kept copy, not as the whole op dir set aside', () => {
    const area = '/state/backups/update/claude-code/k/my-skill'
    const parked = '/root/.skillsmith-staging/.skillsmith-parked/x/x-r'
    const lines = resultLines({
      status: 'done',
      opId: 'x',
      action: 'abandon',
      from: 'anything else',
      installed: null,
      kept: [
        { tree: 'OP', kind: 'partial-copy', path: `${area}/x.partial-copy` },
        { tree: 'O', kind: 'abandoned-old', path: `${area}/x.abandoned-old` },
      ],
      extraCopy: parked,
      manifest: 'untouched',
      audit: { kind: 'none' },
      warnings: [],
      swept: { removed: [], left: [] },
    })
    expect(lines).toContain(`  kept OP as partial-copy at ${area}/x.partial-copy`)
    expect(lines).toContain(`  kept O as abandoned-old at ${area}/x.abandoned-old`)
    // The run's real park line is still printed; only the copy temp's line changed.
    expect(lines).toContain(
      `  the op dir, holding the verified source copies, was moved aside to ${parked}`
    )
    expect(lines.filter((l) => l.includes('the whole op dir was set aside'))).toEqual([])
  })

  it('the --abandon help says the op dir is removed, or set aside across devices', () => {
    const recovery = createDoctorCommand().commands.find((c) => c.name() === 'recovery')!
    expect(recovery.options.find((o) => o.long === '--abandon')?.description).toContain(
      'then remove (or, across devices, set aside) its op dir'
    )
  })

  it('`doctor recovery --abandon <opId> --yes` runs the action', async () => {
    const u = plantMoved()
    const cmd = createDoctorCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'doctor', 'recovery', '--abandon', u.opId, '--yes'])
    expect(fs.existsSync(u.opDir)).toBe(false)
    expect(calls.executes).toBe(1)
  })
})
