/**
 * SMI-6531 (#3280 retro): FI4's set-aside copy against the two features that
 * read it outside doctor, each through its real path.
 *
 *  - `skillsmith restore` (`planRestore`): it reads the copy's sidecar to learn
 *    where it came from, so it puts back a copy the park recorded (held or
 *    not) and refuses one whose sidecar was never written. Doctor's FI4 note
 *    says which, for each.
 *  - Prune's protection (`listBackups`, which runs `protectAll`): while the
 *    install's record is live, its own set-aside copy is protected however
 *    prune read its sidecar (a held park's, or none), and unprotected once
 *    the record is gone; a copy of another operation is not protected by it.
 *
 * The skills root is a discovered client root, so both features find it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTree } from '../../../../src/install/park-tree.js'
import { listBackups } from '../../../../src/services/skill-backups.listing.js'
import { planRestore } from '../../../../src/services/skill-restore.js'
import { tmp, useTmpCleanup } from '../skill-swap.helpers.js'
import { hermetic } from '../skill-backups.helpers.js'
import { opReport } from './recovery.helpers.js'
import { fi4, installFixture } from './install.helpers.js'

useTmpCleanup()

/** A fresh FI4 in a discovered root, with the options restore and prune are given. */
async function discoveredFi4(held = false) {
  const base = tmp('install-prk-')
  const discovery = hermetic(base)
  const stateRoot = path.join(base, 'state')
  fs.mkdirSync(stateRoot)
  const skillsDir = fs.realpathSync(path.join(base, 'clients', 'claude-code'))
  const st = await fi4(installFixture({ skillsDir, stateRoot }), { held })
  return { ...st, opts: { stateRoot, discovery } }
}

/** FI4's note, from the `--apply` plan the listing offers. */
async function fi4Note(st: Awaited<ReturnType<typeof discoveredFi4>>): Promise<string> {
  const op = await opReport(st)
  expect(op.cls).toMatchObject({ kind: 'state', state: 'FI4' })
  const apply = op.plans.find((p) => p.action === 'apply')
  if (apply === undefined || !apply.offered) throw new Error('--apply not offered')
  return apply.notes.join('\n')
}

describe('FI4 and skillsmith restore', () => {
  it('with the park’s sidecar: restore plans to put it back at the skill path; the note says so', async () => {
    const st = await discoveredFi4()
    const r = await planRestore(st.opId, st.opts)
    expect(r).toMatchObject({
      status: 'planned',
      plan: { copyPath: st.parked, origin: st.fx.realDir, held: false },
    })
    const note = await fi4Note(st)
    expect(note).toContain(`can be put back with \`skillsmith restore ${st.opId}\``)
    expect(note).not.toContain('held when it was set aside')
  })

  it('a held park: restore plans it, held; the note says restore will call it different', async () => {
    const st = await discoveredFi4(true)
    expect(JSON.parse(fs.readFileSync(`${st.parked}.json`, 'utf8'))).toMatchObject({ hold: true })
    const r = await planRestore(st.opId, st.opts)
    expect(r).toMatchObject({ status: 'planned', plan: { copyPath: st.parked, held: true } })
    const note = await fi4Note(st)
    expect(note).toContain(`can be put back with \`skillsmith restore ${st.opId}\``)
    expect(note).toContain('it was held when it was set aside')
  })

  it('no sidecar: restore refuses origin-unknown; the note says to copy it back by hand', async () => {
    const st = await discoveredFi4()
    fs.unlinkSync(`${st.parked}.json`)
    const r = await planRestore(st.opId, st.opts)
    expect(r).toMatchObject({ status: 'refused', reason: 'origin-unknown' })
    const note = await fi4Note(st)
    expect(note).toContain(
      `the folder set aside at ${st.parked} has no record of where it came from`
    )
    expect(note).toContain(`copy it to ${st.fx.realDir} by hand`)
    expect(note).not.toContain(`skillsmith restore ${st.opId}`)
  })
})

/** The listing's parked row for `copyPath`. */
async function rowOf(opts: Awaited<ReturnType<typeof discoveredFi4>>['opts'], copyPath: string) {
  const l = await listBackups(opts)
  const row = l.parked.flatMap((a) => a.rows).find((r) => r.copy.copyPath === copyPath)
  if (row === undefined) throw new Error(`no parked row for ${copyPath}`)
  return row
}

describe('FI4 and prune’s protection', () => {
  for (const [name, build] of [
    ['a held park', () => discoveredFi4(true)],
    [
      'a park whose sidecar was never written',
      async () => {
        const st = await discoveredFi4()
        fs.unlinkSync(`${st.parked}.json`)
        return st
      },
    ],
  ] as const) {
    it(`${name}: protected by the live install record, unprotected once it is gone`, async () => {
      const st = await build()
      const row = await rowOf(st.opts, st.parked)
      // Prune read no kind for it: the case a kind test misses.
      expect(row.kind).toBeNull()
      expect(row.protection).toEqual({
        status: 'protected',
        rule: 'live-record',
        path: path.join(st.opDir, 'record.json'),
      })
      fs.rmSync(st.opDir, { recursive: true })
      expect((await rowOf(st.opts, st.parked)).protection).toEqual({ status: 'unprotected' })
    })
  }

  it('a parked copy of another operation in the same root is not protected by the record', async () => {
    const st = await discoveredFi4()
    const other = path.join(st.fx.skillsDir, 'other-skill')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'SKILL.md'), '# other\n')
    const r = parkTree(st.fx.skillsDir, 'other-skill', {
      client: 'claude-code',
      caller: 'uninstall',
      kind: 'uninstall',
    })
    expect(r.status).toBe('parked')
    expect((await rowOf(st.opts, r.path!)).protection).toEqual({ status: 'unprotected' })
    // The install's own copy, in the same listing, is protected.
    expect((await rowOf(st.opts, st.parked)).protection).toMatchObject({ status: 'protected' })
  })
})
