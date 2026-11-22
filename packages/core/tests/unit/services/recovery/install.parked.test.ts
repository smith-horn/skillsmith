/**
 * SMI-6531 (#3283, re-derived): FI4's set-aside copy against the two features
 * that read it outside doctor, each through its real path.
 *
 *  - `skillsmith restore` (`planRestore`): doctor's FI4 note is worded from
 *    restore's own verdict on the copy (`ParkedCopyFact.restore`). For a valid
 *    sidecar, a held park, a sidecar with an extra key and no sidecar, the
 *    verdict doctor recorded equals the real `planRestore`'s for the same copy
 *    (would put back or not, the refusal reason, whether its done message says
 *    the copy differs), and the note offers the command exactly when it would.
 *  - Prune's protection (`listBackups`, which runs `protectAll`): a live
 *    install record protects the copy at its place whose identity is the
 *    published folder's, however prune read its sidecar; not a different
 *    folder at that path, not another operation's copy, and nothing once the
 *    record is gone. Two live installs sharing an opId each protect their own.
 *
 * The skills roots are discovered client roots, so both features find them.
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

/** A discovered machine: two client roots and a state root, with the options restore and prune take. */
function machine() {
  const base = tmp('install-prk-')
  const discovery = hermetic(base)
  const stateRoot = path.join(base, 'state')
  fs.mkdirSync(stateRoot)
  const root = (client: string) => fs.realpathSync(path.join(base, 'clients', client))
  return { base, root, opts: { stateRoot, discovery } }
}

/** An FI4 in the claude-code root of a fresh machine. */
async function discoveredFi4(held = false) {
  const m = machine()
  const st = await fi4(
    installFixture({ skillsDir: m.root('claude-code'), stateRoot: m.opts.stateRoot }),
    { held }
  )
  return { ...st, opts: m.opts }
}

type Fi4 = Awaited<ReturnType<typeof discoveredFi4>>

/** What doctor recorded for the copy, and the FI4 note it printed. */
async function doctorSays(st: Fi4) {
  const op = await opReport(st)
  if (op.cls.kind !== 'state' || op.cls.state !== 'FI4') throw new Error(`not FI4: ${op.label}`)
  const apply = op.plans.find((p) => p.action === 'apply')
  if (apply === undefined || !apply.offered) throw new Error('--apply not offered')
  return { verdict: op.cls.facts.parked![0]!.restore, note: apply.notes.join('\n') }
}

/** The property: doctor's verdict is the real restore's, and the note offers restore exactly then. */
async function agrees(st: Fi4) {
  const { verdict, note } = await doctorSays(st)
  const real = await planRestore(st.opId, st.opts)
  const offers = note.includes(`can be put back with \`skillsmith restore ${st.opId}\``)
  expect(offers).toBe(real.status === 'planned')
  expect(verdict.would).toBe(real.status === 'planned')
  if (real.status === 'planned') {
    const differs = real.plan.held || real.plan.contents.state === 'changed'
    expect(verdict).toEqual({ would: true, differs })
    expect(note.includes('restore will say it differs from what was set aside')).toBe(differs)
  } else {
    expect(verdict).toMatchObject({ would: false, reason: real.reason, message: real.message })
    expect(note).toContain(`cannot be put back by \`skillsmith restore\` (${real.reason}:`)
    expect(note).toContain(`copy it to ${st.fx.realDir} by hand`)
  }
  return real
}

describe('FI4: the note is restore’s own verdict', () => {
  it('a valid sidecar: restore would put it back, unchanged; so does doctor', async () => {
    const st = await discoveredFi4()
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'planned', plan: { origin: st.fx.realDir, held: false } })
  })

  it('a held park: restore would put it back and say it differs; so does doctor', async () => {
    const st = await discoveredFi4(true)
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'planned', plan: { held: true } })
  })

  it('a sidecar with an extra key: restore refuses origin-unknown; doctor offers nothing', async () => {
    const st = await discoveredFi4()
    const sc = JSON.parse(fs.readFileSync(`${st.parked}.json`, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(`${st.parked}.json`, JSON.stringify({ ...sc, extra: 1 }))
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'refused', reason: 'origin-unknown' })
  })

  it('no sidecar: restore refuses origin-unknown; doctor offers nothing', async () => {
    const st = await discoveredFi4()
    fs.unlinkSync(`${st.parked}.json`)
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'refused', reason: 'origin-unknown' })
  })

  /** The real park's sidecar with its `originPath` moved, still valid to restore's strict schema. */
  function originAt(st: Fi4, origin: string): void {
    const file = `${st.parked}.json`
    const sc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(file, JSON.stringify({ ...sc, originPath: origin }))
  }

  it('an origin whose folder does not exist: restore refuses origin-parent-missing; so does doctor', async () => {
    const st = await discoveredFi4()
    originAt(st, path.join(st.fx.outside, 'gone', st.fx.dirName))
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'refused', reason: 'origin-parent-missing' })
  })

  it('an origin in another discovered root: restore refuses origin-mismatch; so does doctor', async () => {
    const st = await discoveredFi4()
    const other = fs.realpathSync(path.join(path.dirname(st.fx.skillsDir), 'cursor'))
    originAt(st, path.join(other, st.fx.dirName))
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'refused', reason: 'origin-mismatch' })
  })

  it('an origin spelled through a link to its own root: restore puts it back; so does doctor', async () => {
    const st = await discoveredFi4()
    const link = path.join(st.fx.outside, 'root-link')
    fs.symlinkSync(st.fx.skillsDir, link)
    originAt(st, path.join(link, st.fx.dirName))
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'planned', plan: { target: st.fx.realDir } })
  })
})

/** The listing's parked row for `copyPath`. */
async function rowOf(opts: Fi4['opts'], copyPath: string) {
  const l = await listBackups(opts)
  const row = l.parked.flatMap((a) => a.rows).find((r) => r.copy.copyPath === copyPath)
  if (row === undefined) throw new Error(`no parked row for ${copyPath}`)
  return row
}

const recordOf = (st: Fi4) => path.join(st.opDir, 'record.json')

describe('FI4 and prune’s protection: place and identity', () => {
  for (const [name, build] of [
    ['a park with its sidecar', () => discoveredFi4()],
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
      expect((await rowOf(st.opts, st.parked)).protection).toEqual({
        status: 'protected',
        rule: 'live-record',
        path: recordOf(st),
      })
      fs.rmSync(st.opDir, { recursive: true })
      expect((await rowOf(st.opts, st.parked)).protection).toEqual({ status: 'unprotected' })
    })
  }

  it('a different folder at the exact expected path, sidecar and all, is not protected', async () => {
    const st = await discoveredFi4()
    expect((await rowOf(st.opts, st.parked)).protection).toMatchObject({ status: 'protected' })
    // The same content and name, another folder: what a place-only rule could not tell apart.
    const away = path.join(st.fx.outside, 'parked-away')
    fs.renameSync(st.parked, away)
    fs.cpSync(away, st.parked, { recursive: true })
    expect((await rowOf(st.opts, st.parked)).protection).toEqual({ status: 'unprotected' })
  })

  it('two live installs with one opId in two roots: each protects its own copy', async () => {
    const m = machine()
    const a = await fi4(
      installFixture({ skillsDir: m.root('claude-code'), stateRoot: m.opts.stateRoot })
    )
    const b = await fi4(
      installFixture({
        skillsDir: m.root('cursor'),
        stateRoot: m.opts.stateRoot,
        dirName: 'second-skill',
      })
    )
    expect(a.opId).toBe(b.opId)
    expect((await rowOf(m.opts, a.parked)).protection).toEqual({
      status: 'protected',
      rule: 'live-record',
      path: path.join(a.opDir, 'record.json'),
    })
    expect((await rowOf(m.opts, b.parked)).protection).toEqual({
      status: 'protected',
      rule: 'live-record',
      path: path.join(b.opDir, 'record.json'),
    })
  })

  it('a parked copy of another operation in the same root is not protected', async () => {
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
    expect((await rowOf(st.opts, st.parked)).protection).toMatchObject({ status: 'protected' })
  })
})
