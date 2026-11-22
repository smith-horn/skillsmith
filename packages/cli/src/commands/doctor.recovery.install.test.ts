/**
 * @fileoverview `skillsmith doctor recovery` on a fresh install's record
 * (SMI-6531 A1 step 8-i-a-2, T-FIJ): the row label, the facts line naming the
 * operation, the set-aside copy, the JSON (`state`, `record.op`, `parked`) and
 * the exit codes (0 done, 1 refused, 3 a plan printed without confirmation).
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

import { runDoctorRecovery } from './doctor.recovery.js'
import { runRecoveryAction } from './doctor.recovery.action.js'
import { hermeticDiscovery, plantInstall } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-install-')))
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
})

const entry = (stateRoot: string): unknown =>
  (
    JSON.parse(fs.readFileSync(path.join(stateRoot, 'manifest.json'), 'utf8')) as {
      installedSkills: Record<string, unknown>
    }
  ).installedSkills['my-skill']

describe('doctor recovery: a fresh install', () => {
  it('lists FI0 with its label and a first facts line naming the install; no O line', async () => {
    const u = await plantInstall(base, 'FI0')
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(`${u.opId}  FI0 not claimed`)
    expect(text).toContain(
      `    install of my-skill into ${u.root} (manifest key my-skill)\n    skill: ${u.skillDir}`
    )
    expect(text).toContain('    N (new): in the op dir')
    expect(text).not.toContain('O (old)')
    expect(text).toContain(`--apply: \`skillsmith doctor recovery --apply ${u.opId}\``)
    expect(text).toContain(`note: puts the new folder at ${u.skillDir} and adds the manifest entry`)
    expect(process.exitCode).toBeUndefined()
  })

  it('lists FI4 with where the folder was set aside; with no sidecar, to copy it back by hand', async () => {
    const u = await plantInstall(base, 'FI4')
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(`${u.opId}  FI4 rolled back`)
    expect(text).toContain(`    set aside at ${u.parked} (sidecar: missing; held: no)`)
    // `skillsmith restore` refuses a copy with no sidecar (origin-unknown), so the note does not offer it.
    expect(text).toContain(`copy it to ${u.skillDir} by hand`)
    expect(text).not.toContain(`skillsmith restore ${u.opId}`)
  })

  it('a set-aside copy with a sidecar says present and held yes or no; another folder is named as one', async () => {
    const u = await plantInstall(base, 'FI4')
    // No public park reaches the CLI tests, so the sidecar is written here with the fields the
    // classifier reads; core's tests read the real park's own sidecar (install.classify.test.ts).
    const sidecar = (hold: boolean) =>
      JSON.stringify({ opId: u.opId, kind: 'install-rollback', hold, treeHash: null })
    fs.writeFileSync(`${u.parked}.json`, sidecar(true))
    await runDoctorRecovery({})
    expect(out.join('\n')).toContain(`    set aside at ${u.parked} (sidecar: present; held: yes)`)
    // With a sidecar the note offers restore, and says a held copy will be reported as different.
    expect(out.join('\n')).toContain(
      `skillsmith restore ${u.opId}\`; it was held when it was set aside`
    )

    out = []
    fs.writeFileSync(`${u.parked}.json`, sidecar(false))
    await runDoctorRecovery({})
    expect(out.join('\n')).toContain(`    set aside at ${u.parked} (sidecar: present; held: no)`)

    out = []
    const other = path.join(path.dirname(u.parked!), 'my-skill-deadbeef')
    fs.cpSync(u.parked!, other, { recursive: true })
    await runDoctorRecovery({})
    const text = out.join('\n')
    expect(text).toContain(`    set aside at ${other}: not the installed folder (sidecar: missing)`)
    expect(text).toContain(`    set aside at ${u.parked} (sidecar: present; held: no)`)
    expect(text).toContain(`${u.opId}  anything else`)
  })

  it('--json carries the state, the record op and the parked copies', async () => {
    const u = await plantInstall(base, 'FI4')
    await runDoctorRecovery({ json: true })
    const doc = JSON.parse(out.join('\n')) as {
      roots: Array<{ root: string; ops: Array<{ opId: string; class: Record<string, unknown> }> }>
    }
    const op = doc.roots.find((r) => r.root === u.root)!.ops[0]!
    expect(op).toMatchObject({
      opId: u.opId,
      class: {
        kind: 'state',
        state: 'FI4',
        facts: {
          record: { op: 'install' },
          parked: [{ path: u.parked, identityMatches: true, sidecar: null }],
        },
      },
    })
  })

  it('exit codes: 3 for a plan without confirmation (nothing changed), 0 done, 1 refused', async () => {
    const u = await plantInstall(base, 'FI2')
    await runRecoveryAction({ apply: u.opId, isTTY: () => false })
    expect(process.exitCode).toBe(3)
    expect(entry(u.stateRoot)).toBeUndefined()
    expect(out.join('\n')).toContain(`(FI2 published)`)

    process.exitCode = undefined
    await runRecoveryAction({ apply: u.opId, yes: true })
    expect(process.exitCode).toBeUndefined()
    expect(out.join('\n')).toContain('Done: apply')
    expect(entry(u.stateRoot)).toEqual({ version: '1.0.0', source: 'github:o/r' })
    expect(fs.existsSync(u.opDir)).toBe(false)

    // Out of the way: a folder with the same content at the skill path is another install's.
    fs.renameSync(u.skillDir, path.join(base, 'first-install'))
    const v = await plantInstall(base, 'FI0', 'd'.repeat(32))
    fs.writeFileSync(path.join(v.opDir, 'new', 'SKILL.md'), '# edited\n')
    process.exitCode = undefined
    await runRecoveryAction({ apply: v.opId, yes: true })
    expect(process.exitCode).toBe(1)
    expect([...out, ...err].join('\n')).toContain('recovery-conflict')
    expect(fs.existsSync(path.join(v.opDir, 'record.json'))).toBe(true)
  })
})
