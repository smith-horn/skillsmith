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
function machine(prefix = 'install-prk-') {
  const base = tmp(prefix)
  const discovery = hermetic(base)
  const stateRoot = path.join(base, 'state')
  fs.mkdirSync(stateRoot)
  const root = (client: string) => fs.realpathSync(path.join(base, 'clients', client))
  return { base, root, opts: { stateRoot, discovery } }
}

/** An FI4 in the claude-code root of a fresh machine. */
async function discoveredFi4(held = false, prefix?: string) {
  const m = machine(prefix)
  const st = await fi4(
    installFixture({ skillsDir: m.root('claude-code'), stateRoot: m.opts.stateRoot }),
    { held }
  )
  return { ...st, opts: m.opts }
}

type Fi4 = Awaited<ReturnType<typeof discoveredFi4>>

/** What doctor recorded for the copy, and the FI4 note it printed. */
async function doctorSays(st: Pick<Fi4, 'fx' | 'opId'>) {
  const op = await opReport(st)
  if (op.cls.kind !== 'state' || op.cls.state !== 'FI4') throw new Error(`not FI4: ${op.label}`)
  const apply = op.plans.find((p) => p.action === 'apply')
  if (apply === undefined || !apply.offered) throw new Error('--apply not offered')
  return { verdict: op.cls.facts.parked![0]!.restore, note: apply.notes.join('\n') }
}

/**
 * The words a POSIX shell makes of `text` (single quotes, backslash escapes,
 * unquoted blanks between words): what the program would be given.
 */
function shellWords(text: string): string[] {
  const words: string[] = []
  let cur: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) throw new Error(`unterminated quote in ${text}`)
      cur = (cur ?? '') + text.slice(i + 1, end)
      i = end
    } else if (ch === '\\') {
      cur = (cur ?? '') + (text[i + 1] ?? '')
      i++
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (cur !== null) words.push(cur)
      cur = null
    } else {
      cur = (cur ?? '') + ch
    }
  }
  if (cur !== null) words.push(cur)
  return words
}

/**
 * The argument the note's restore command gives `skillsmith restore`, as a
 * shell would pass it, or null when the note offers none. It must be exactly
 * one word: a path a shell would split is not one argument.
 */
function offeredArg(note: string): string | null {
  const m = /can be put back with `skillsmith restore ([^`]+)`/.exec(note)
  if (m === null) return null
  const words = shellWords(m[1]!)
  expect(words).toHaveLength(1)
  return words[0]!
}

/**
 * The property: doctor's verdict is the real restore's, and the note offers
 * restore exactly then. The real `planRestore` is run with the argument the
 * note offers (the copy's path when it offers none), never an id the test picks.
 */
async function agrees(st: Pick<Fi4, 'fx' | 'opId' | 'opts' | 'parked'>) {
  const { verdict, note } = await doctorSays(st)
  const offered = offeredArg(note)
  const real = await planRestore(offered ?? st.parked, st.opts)
  // An offered command must plan as given (an ambiguous id would not): a refusal shows its reason.
  if (offered !== null) expect(real.status === 'planned' ? 'planned' : real.reason).toBe('planned')
  expect(offered !== null).toBe(real.status === 'planned')
  // And it names this copy, by its full path.
  if (offered !== null) expect(offered).toBe(st.parked)
  expect(verdict.would).toBe(real.status === 'planned')
  if (real.status === 'planned') {
    const differs = real.plan.held || real.plan.contents.state === 'changed'
    expect(verdict).toEqual({ would: true, differs })
    expect(note.includes('restore will say it differs from what was set aside')).toBe(differs)
  } else {
    expect(verdict).toMatchObject({ would: false, reason: real.reason, message: real.message })
    if (real.reason !== 'origin-parent-missing') {
      expect(note).toContain(`cannot be put back by \`skillsmith restore\` (${real.reason}:`)
      expect(note).toContain(`copy it to ${st.fx.realDir} by hand`)
    }
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
    const gone = path.join(st.fx.outside, 'gone')
    originAt(st, path.join(gone, st.fx.dirName))
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'refused', reason: 'origin-parent-missing' })
    // The fixable refusal: what to create and what to run then, with no placeholder id.
    const { note } = await doctorSays(st)
    expect(note).toContain(
      `the folder set aside at ${st.parked}: restore will refuse until ${gone} exists; ` +
        `create it and run \`skillsmith restore ${st.parked}\`, or copy the folder to ${st.fx.realDir} by hand`
    )
    expect(note).not.toContain('<id>')
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

  it('a root whose path has a space and a quote: the note quotes it, and restore plans it as one argument', async () => {
    const st = await discoveredFi4(false, "install prk o'q-")
    expect(st.parked).toContain(' ')
    expect(st.parked).toContain("'")
    const { note } = await doctorSays(st)
    // Quoted as one shell word, with the quote written as '\''.
    expect(note).toContain(`\`skillsmith restore '${st.parked.replace(/'/g, `'\\''`)}'\``)
    const real = await agrees(st)
    expect(real).toMatchObject({ status: 'planned', plan: { copyPath: st.parked } })
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

  it('two live installs with one opId in two roots: each restorable by its note, each protected', async () => {
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
    // Restore, given the argument each FI4 note offers, plans each copy: no ambiguity across roots.
    for (const x of [a, b]) {
      expect(await agrees({ ...x, opts: m.opts })).toMatchObject({
        status: 'planned',
        plan: { copyPath: x.parked, target: x.fx.realDir },
      })
    }
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
