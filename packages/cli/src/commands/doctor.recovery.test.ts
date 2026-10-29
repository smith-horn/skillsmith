/**
 * @fileoverview `skillsmith doctor recovery` and the skills-root half of
 * `doctor locks` (A1 plan §3.9; SMI-6531 step 6a-i).
 *
 * The listing is read-only and finds a crashed update in any of the nine client
 * roots without `--root`. Every case reads a temporary directory standing in for
 * the home; discovery's seams (see `doctor.test-helpers.ts`) keep the real home
 * out of it. Each negative has a positive beside it.
 */
import { spawnSync } from 'node:child_process'
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

import { createDoctorCommand, runDoctorLocks } from './doctor.js'
import { runDoctorRecovery } from './doctor.recovery.js'
import { hermeticDiscovery, plantCrashedUpdate } from './doctor.test-helpers.js'

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''])
  expect(r.status).toBe(0)
  return r.pid!
}

const v1 = (pid: number): string =>
  JSON.stringify({ v: 1, pid, token: 'abcdef0123456789', host: os.hostname(), acquiredAt: 1 })

let base = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-recovery-')))
  calls.discovery = hermeticDiscovery(base, true)
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  fs.rmSync(base, { recursive: true, force: true })
})

/** Every entry under `p`, links never followed, with type, inode, link count and nanosecond mtime. */
function snapshot(p: string): string[] {
  const lines: string[] = []
  const walk = (abs: string): void => {
    const s = fs.lstatSync(abs, { bigint: true })
    lines.push(`${abs} ${s.mode} ${s.ino} ${s.nlink} ${s.mtimeNs} ${s.isFile() ? s.size : ''}`)
    if (s.isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n))
  }
  walk(p)
  return lines
}

describe('skillsmith doctor recovery', () => {
  it('lists a crashed update found in a client root without --root, with its state and what each action would do', async () => {
    const u = plantCrashedUpdate(base)

    await runDoctorRecovery({})

    const text = out.join('\n')
    expect(text).toContain('1 operation directory found')
    expect(text).toContain(u.root)
    expect(text).toContain(`${u.opId}  S2 swapped`)
    // A recorded op's backup line is its record's backupDest, the whole line.
    expect(text).toContain(`    backup: ${u.backupDest}\n`)
    expect(text).toContain('manifest entry: pre')
    // 6a-iii: --apply and --undo are supported; each offered line is its command, ending there.
    expect(text).toContain(`--apply: \`skillsmith doctor recovery --apply ${u.opId}\`\n`)
    expect(text).toContain(`--undo: \`skillsmith doctor recovery --undo ${u.opId}\`\n`)
    expect(text).toContain('O: kept as backup')
    expect(text).toContain('O: installed')
    // The identities and hashes it compared are printed.
    expect(text).toMatch(/T \(skill path\): new; dir, ino \d+, birthtime \d+, hash [0-9a-f]{12}/)
    expect(process.exitCode).toBeUndefined()
  })

  it('is read-only: nothing under the roots or the state root changes, and no root gets a staging dir', async () => {
    plantCrashedUpdate(base)
    const before = snapshot(base)

    await runDoctorRecovery({})
    await runDoctorRecovery({ json: true })

    expect(snapshot(base)).toEqual(before)
    const cursor = path.join(base, 'clients', 'cursor')
    expect(fs.existsSync(path.join(cursor, '.skillsmith-staging'))).toBe(false)
    expect(out.join('\n')).toContain('no staging directory')
    // Presence: the root that does have staging was listed.
    expect(out.join('\n')).toContain('S2 swapped')
  })

  it("--json prints the same listing as JSON: the class, every action's plan and the digest", async () => {
    const u = plantCrashedUpdate(base)

    await runDoctorRecovery({ json: true })

    const parsed = JSON.parse(out.join('\n')) as {
      roots: Array<{
        root: string
        sources: string[]
        ops: Array<{
          opId: string
          class: { kind: string; state?: string }
          plans: unknown[]
          digest: string
        }>
      }>
    }
    const root = parsed.roots.find((r) => r.root === u.root)!
    expect(root.sources).toContain('client:claude-code')
    expect(root.ops).toHaveLength(1)
    expect(root.ops[0]).toMatchObject({ opId: u.opId, class: { kind: 'state', state: 'S2' } })
    expect(root.ops[0]!.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(root.ops[0]!.plans).toHaveLength(5)
    expect(parsed.roots.filter((r) => r.ops.length === 0).length).toBeGreaterThanOrEqual(8)
  })

  it('lists an unreadable record, an op dir with no record, and a leftover probe, each with its words', async () => {
    const u = plantCrashedUpdate(base)
    const staging = path.join(u.root, '.skillsmith-staging')
    fs.mkdirSync(path.join(staging, 'b'.repeat(32)))
    fs.writeFileSync(path.join(staging, 'b'.repeat(32), 'record.json'), 'not a record')
    fs.mkdirSync(path.join(staging, 'c'.repeat(32), 'new'), { recursive: true })
    fs.mkdirSync(path.join(staging, '.skillsmith-probe-dddd-1'))

    await runDoctorRecovery({})

    const text = out.join('\n')
    expect(text).toContain(`${'b'.repeat(32)}  unreadable record (not-json)`)
    expect(text).toContain('--park: `skillsmith doctor recovery --park')
    expect(text).toContain(`${'c'.repeat(32)}  no-record`)
    expect(text).toContain('no record.json')
    expect(text).toContain(path.join(staging, '.skillsmith-probe-dddd-1'))
    expect(text).toContain('leftover probes')
    // The probe is still there: listing never removes it.
    expect(fs.existsSync(path.join(staging, '.skillsmith-probe-dddd-1'))).toBe(true)
    // And the crashed update beside them is still a row.
    expect(text).toContain(`${u.opId}  S2 swapped`)
  })

  it('--root adds a root; a --root that does not exist exits 1 and is not created', async () => {
    plantCrashedUpdate(base)
    const extra = path.join(base, 'extra-root')
    fs.mkdirSync(path.join(extra, '.skillsmith-staging', 'e'.repeat(32)), { recursive: true })
    const missing = path.join(base, 'no-such-root')

    await runDoctorRecovery({ root: [extra, missing] })

    expect(out.join('\n')).toContain(`${'e'.repeat(32)}  empty-op-dir`)
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain(
      `--root ${missing} could not be used (ENOENT); nothing was created there.`
    )
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('an op dir whose record names another root is recovery-moved: --apply is refused in words, not offered', async () => {
    const u = plantCrashedUpdate(base)
    // The same record, copied into another root's staging: it names the first root.
    const other = path.join(base, 'clients', 'cursor')
    const dir = path.join(other, '.skillsmith-staging', u.opId)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(path.join(u.opDir, 'record.json'), path.join(dir, 'record.json'))

    await runDoctorRecovery({})

    const text = out.join('\n')
    expect(text).toContain('moved (foreign-root)')
    expect(text).toContain('--apply: not offered (recovery-moved)')
    expect(text).toContain('S2 swapped') // the original, beside it, is still a row
  })
})

describe('skillsmith doctor locks over the discovered roots', () => {
  it("lists a root's write lock and its reclaim lock; a root with none is counted, not listed", async () => {
    const root = path.join(base, 'clients', 'cursor')
    const lock = path.join(root, '.skillsmith-writes.lock')
    fs.writeFileSync(lock, '4242')
    fs.writeFileSync(`${lock}.reclaim`, 'x')
    const state = path.join(base, 'state')
    fs.mkdirSync(state)

    await runDoctorLocks({ stateRoot: state, discovery: calls.discovery })

    const text = out.join('\n')
    expect(text).toContain(`Locks in skills root ${fs.realpathSync(root)}`)
    expect(text).toContain(path.join(fs.realpathSync(root), '.skillsmith-writes.lock'))
    expect(text).toContain(`${path.join(fs.realpathSync(root), '.skillsmith-writes.lock')}.reclaim`)
    expect(text).toContain('bare-PID claim (older Skillsmith)')
    expect(text).toContain('Scanned 9 skills roots; 1 holds a write lock file.')
    expect(text).not.toContain(path.join(base, 'clients', 'agents'))
    // The state root's own locks are still listed first.
    expect(text.indexOf('Locks under')).toBeLessThan(text.indexOf('Locks in skills root'))
  })

  it('a missing state root is reported, and the skills roots are still listed', async () => {
    const lock = path.join(base, 'clients', 'opencode', '.skillsmith-writes.lock')
    fs.writeFileSync(lock, '4242')
    const missing = path.join(base, 'no-state-root')

    await runDoctorLocks({ stateRoot: missing, discovery: calls.discovery })

    const text = out.join('\n')
    expect(text).toContain(`${missing} does not exist`)
    expect(text).toContain('Locks in skills root')
    expect(process.exitCode).toBeUndefined()
  })

  it('a --root that does not exist is reported and exits 1, the listing still prints, nothing is created', async () => {
    const state = path.join(base, 'state')
    fs.mkdirSync(state)
    const missing = path.join(base, 'no-such-root')

    await runDoctorLocks({ stateRoot: state, root: [missing], discovery: calls.discovery })

    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain(
      `--root ${missing} could not be used (ENOENT); nothing was created there.`
    )
    expect(fs.existsSync(missing)).toBe(false)
    expect(out.join('\n')).toContain('Scanned 9 skills roots')
  })

  it('control: a --root that exists is scanned and the exit status stays 0', async () => {
    const state = path.join(base, 'state')
    fs.mkdirSync(state)
    const extra = path.join(base, 'extra-root')
    fs.mkdirSync(extra)

    await runDoctorLocks({ stateRoot: state, root: [extra], discovery: calls.discovery })

    expect(process.exitCode).toBeUndefined()
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('Scanned 10 skills roots')
  })

  it('--release accepts a discovered skills-root lock (SMI-6531 6a-ii): a dead same-host claim goes', async () => {
    const lock = path.join(
      fs.realpathSync(path.join(base, 'clients', 'cursor')),
      '.skillsmith-writes.lock'
    )
    fs.writeFileSync(lock, v1(deadPid()))
    const state = path.join(base, 'state')
    fs.mkdirSync(state)

    await runDoctorLocks({ stateRoot: state, release: lock, discovery: calls.discovery })

    expect(process.exitCode).toBeUndefined()
    expect(out.join('\n')).toContain(`Released ${lock}.`)
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('--release of a skills-root lock keeps the rules: a bare-PID claim needs the flag', async () => {
    const lock = path.join(
      fs.realpathSync(path.join(base, 'clients', 'cursor')),
      '.skillsmith-writes.lock'
    )
    fs.writeFileSync(lock, '4242')
    const state = path.join(base, 'state')
    fs.mkdirSync(state)

    await runDoctorLocks({ stateRoot: state, release: lock, discovery: calls.discovery })

    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('Not released')
    expect(err.join('\n')).not.toContain('is not a lock doctor lists')
    expect(fs.readFileSync(lock, 'utf8')).toBe('4242')
  })

  it('--release still refuses a path no listing shows', async () => {
    const stray = path.join(base, 'clients', 'cursor', 'not-a-lock')
    fs.writeFileSync(stray, v1(deadPid()))
    const state = path.join(base, 'state')
    fs.mkdirSync(state)

    await runDoctorLocks({ stateRoot: state, release: stray, discovery: calls.discovery })

    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('is not a lock doctor lists')
    expect(fs.existsSync(stray)).toBe(true)
  })
})

describe('the doctor command', () => {
  it('registers recovery (with repeatable --root, --state-root and --json) and locks (with --root)', () => {
    const cmd = createDoctorCommand()
    const names = cmd.commands.map((c) => c.name())
    expect(names).toEqual(['recovery', 'locks'])
    const flags = (name: string): string[] =>
      cmd.commands.find((c) => c.name() === name)!.options.map((o) => o.long ?? '')
    expect(flags('recovery')).toEqual([
      '--root',
      '--state-root',
      '--json',
      '--apply',
      '--undo',
      // 6b-iii: --abandon, beside the two it stands in for.
      '--abandon',
      '--park',
      // 6b-ii: --clean-staging and the flag only it takes.
      '--clean-staging',
      '--unsafe-unverified-owner',
      '--accept-identity',
      '--yes',
    ])
    // 6a-iii: the supported endpoint, so the help names every option and hides none.
    const recovery = cmd.commands.find((c) => c.name() === 'recovery')!
    expect(recovery.options.filter((o) => o.hidden)).toEqual([])
    const help = recovery.helpInformation()
    expect(help).toContain('--state-root')
    for (const f of [
      '--apply <opId>',
      '--undo <opId>',
      '--abandon <opId>',
      '--park <opId>',
      '--clean-staging <opId>',
      '--unsafe-unverified-owner',
      '--accept-identity',
      '--yes',
    ]) {
      expect(help).toContain(f)
    }
    expect(flags('locks')).toEqual([
      '--state-root',
      '--root',
      '--release',
      '--unsafe-unverified-owner',
    ])
  })

  it('runs `doctor recovery --json` end to end through commander, repeating --root', async () => {
    plantCrashedUpdate(base)
    const extra = path.join(base, 'cli-extra')
    fs.mkdirSync(extra)
    const cmd = createDoctorCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'doctor', 'recovery', '--json', '--root', extra, '--root', extra])
    const parsed = JSON.parse(out.join('\n')) as { roots: Array<{ root: string }> }
    expect(parsed.roots.map((r) => r.root)).toContain(fs.realpathSync(extra))
    expect(parsed.roots).toHaveLength(10)
  })
})
