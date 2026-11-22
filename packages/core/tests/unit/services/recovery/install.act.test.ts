/**
 * SMI-6531 (A1 step 8-i-a-2): doctor's `--apply`, `--undo`, `--abandon` and
 * `--park` on a fresh install's states (design § 4, § 6: T-FI0, T-FI1,
 * T-FI1k, T-FI2, T-FI3, T-FI4, T-FIA, T-FIP, T-FIO, T-X9's doctor half).
 * Every state is built with the production primitives (`install.helpers.ts`).
 * Each absence assertion is paired with a presence one from the same run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { areaOf, hashOf, useTmpCleanup } from '../skill-swap.helpers.js'
import { opReport, setEntry } from './recovery.helpers.js'
import {
  act,
  done,
  entryOf,
  killAt,
  keptTrees,
  onlyMetadataRemoved,
  removedBy,
} from './recovery.act.helpers.js'
import {
  fi0,
  fi1,
  fi2,
  fi2prime,
  fi3,
  fi4,
  idOf,
  installFixture,
  OTHER_ENTRY,
  POST_ENTRY,
} from './install.helpers.js'
import type { IState } from './install.helpers.js'

useTmpCleanup()

const keptAt = (st: IState, kind: string): string => path.join(areaOf(st.fx), `${st.opId}.${kind}`)

describe('T-FI0: not claimed', () => {
  it('--apply installs N at the skill path, commits, and removes only metadata', async () => {
    const st = fi0(installFixture())
    const a = await done(st, 'apply')
    expect(a.result).toMatchObject({ installed: 'N', manifest: 'committed', kept: [] })
    expect(idOf(st.fx.realDir)).toEqual(st.record.newIdentity)
    expect(hashOf(st.fx.realDir)).toBe(st.record.postTree)
    expect(entryOf(st.fx)).toEqual(POST_ENTRY)
    expect(fs.existsSync(st.opDir)).toBe(false)
    onlyMetadataRemoved(a.trace, st.fx)
    expect(a.trace.filter((t) => t.op === 'manifest-write')).toHaveLength(1)
  })

  it('--undo keeps N as unused-new; edited, as edited-new; T and the manifest untouched', async () => {
    for (const edited of [false, true]) {
      const st = fi0(installFixture())
      if (edited) fs.writeFileSync(path.join(st.newDir, 'SKILL.md'), '# edited\n')
      const nHash = hashOf(st.newDir)
      const kind = edited ? 'edited-new' : 'unused-new'
      const a = await done(st, 'undo')
      expect(a.result.kept).toEqual([{ tree: 'N', kind, path: keptAt(st, kind) }])
      expect(keptTrees(st.fx)[`${st.opId}.${kind}`]).toBe(nHash)
      expect(fs.existsSync(st.fx.realDir)).toBe(false)
      expect(entryOf(st.fx)).toBeUndefined()
      expect(fs.existsSync(st.opDir)).toBe(false)
      onlyMetadataRemoved(a.trace, st.fx)
    }
  })

  it('--apply of an edited N is refused recovery-conflict at plan time', async () => {
    const st = fi0(installFixture())
    fs.writeFileSync(path.join(st.newDir, 'SKILL.md'), '# edited\n')
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-conflict' })
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })

  it('an edit planted in N after the re-plan is refused before the claim: nothing moved', async () => {
    const st = fi0(installFixture())
    const a = await act(
      st,
      'apply',
      {},
      {
        afterReplan: () => fs.writeFileSync(path.join(st.newDir, 'SKILL.md'), '# planted\n'),
      }
    )
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'recovery-conflict' })
    // Nothing moved: no claim at the skill path; N and the record still in OP.
    expect(fs.existsSync(st.fx.realDir)).toBe(false)
    expect(fs.readFileSync(path.join(st.newDir, 'SKILL.md'), 'utf8')).toBe('# planted\n')
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    expect(removedBy(a.trace)).toEqual([])
  })
})

describe('T-FI1 and T-X9: claimed', () => {
  it('--apply renames N over the empty claim and commits (a claim that survived a kill)', async () => {
    const st = await fi1(installFixture())
    expect((await opReport(st)).cls).toMatchObject({ kind: 'state', state: 'FI1' })
    const a = await done(st, 'apply')
    expect(a.result).toMatchObject({ installed: 'N', manifest: 'committed' })
    expect(idOf(st.fx.realDir)).toEqual(st.record.newIdentity)
    expect(entryOf(st.fx)).toEqual(POST_ENTRY)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('--undo keeps N, then removes the empty claim with one non-recursive rmdir', async () => {
    const st = await fi1(installFixture())
    const nHash = hashOf(st.newDir)
    const a = await done(st, 'undo')
    expect(a.result.kept).toEqual([
      { tree: 'N', kind: 'unused-new', path: keptAt(st, 'unused-new') },
    ])
    expect(keptTrees(st.fx)[`${st.opId}.unused-new`]).toBe(nHash)
    expect(fs.existsSync(st.fx.realDir)).toBe(false)
    const rmdirs = a.trace.filter((t) => t.op === 'rmdir').map((t) => t.path)
    expect(rmdirs).toContain(st.fx.realDir)
    // The claim went before the op dir: the keep came first (T-FI1k's order).
    const keepAt = a.trace.findIndex((t) => t.op === 'rename' && t.path === st.newDir)
    const claimAt = a.trace.findIndex((t) => t.op === 'rmdir' && t.path === st.fx.realDir)
    expect(keepAt).toBeGreaterThanOrEqual(0)
    expect(claimAt).toBeGreaterThan(keepAt)
    expect(entryOf(st.fx)).toBeUndefined()
  })

  it('a file planted in the claim after the keep stops target-changed; the file survives, N is kept', async () => {
    const st = await fi1(installFixture())
    const planted = path.join(st.fx.realDir, 'user.txt')
    const a = await act(
      st,
      'undo',
      {},
      {
        swap: { hooks: { afterPublishOpSync: () => fs.writeFileSync(planted, 'mine\n') } },
      }
    )
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'target-changed' })
    expect(fs.readFileSync(planted, 'utf8')).toBe('mine\n')
    expect(fs.existsSync(keptAt(st, 'unused-new'))).toBe(true)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })

  it('T-FI1k: --undo killed after the keep is FI1 (after its keep), never FI0; the rerun finishes', async () => {
    const st = await fi1(installFixture())
    const first = await act(st, 'undo', {}, killAt('afterPublishOpSync'))
    expect(first.result.status).toBe('stopped')
    const op = await opReport(st)
    expect(op.cls).toMatchObject({ kind: 'state', state: 'FI1', postKeep: true })
    expect(op.cls).not.toMatchObject({ state: 'FI0' })
    // `--apply` there finishes the undo too: it never installs the folder the user undid.
    const again = await done(st, 'apply')
    expect(again.result.installed).toBeNull()
    expect(fs.existsSync(st.fx.realDir)).toBe(false)
    expect(fs.existsSync(keptAt(st, 'unused-new'))).toBe(true)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})

describe('T-FI2: published', () => {
  it('--apply commits; the folder stays', async () => {
    const st = await fi2(installFixture())
    const a = await done(st, 'apply')
    expect(a.result).toMatchObject({ installed: null, manifest: 'committed', kept: [] })
    expect(entryOf(st.fx)).toEqual(POST_ENTRY)
    expect(idOf(st.fx.realDir)).toEqual(st.record.newIdentity)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('an edit in the folder after the re-plan commits with live-folder-changed', async () => {
    const st = await fi2(installFixture())
    const a = await done(
      st,
      'apply',
      {},
      {
        afterReplan: () => fs.writeFileSync(path.join(st.fx.realDir, 'SKILL.md'), '# edited\n'),
      }
    )
    expect(a.result.warnings).toContainEqual(
      expect.objectContaining({ code: 'live-folder-changed' })
    )
    expect(entryOf(st.fx)).toEqual(POST_ENTRY)
  })

  it('the manifest changed between the plan and lock 3: plan-changed, nothing changed', async () => {
    const st = await fi2(installFixture())
    const a = await act(
      st,
      'apply',
      {},
      {
        afterReplan: () => setEntry(st.fx, st.fx.dirName, OTHER_ENTRY),
      }
    )
    expect(a.result).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(entryOf(st.fx)).toEqual(OTHER_ENTRY)
    expect(idOf(st.fx.realDir)).toEqual(st.record.newIdentity)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })

  it('--undo of FI2 and FI2′: the skill path ends empty, the folder kept as undone (conflict when edited)', async () => {
    for (const [build, edited] of [
      [fi2, false],
      [fi2prime, false],
      [fi2, true],
    ] as const) {
      const st = await build(installFixture())
      if (edited) fs.writeFileSync(path.join(st.fx.realDir, 'SKILL.md'), '# edited\n')
      const before = entryOf(st.fx)
      const tHash = hashOf(st.fx.realDir)
      const kind = edited ? 'conflict' : 'undone'
      const a = await done(st, 'undo')
      expect(a.result.kept).toEqual([{ tree: 'T', kind, path: keptAt(st, kind) }])
      expect(keptTrees(st.fx)[`${st.opId}.${kind}`]).toBe(tHash)
      expect(fs.existsSync(st.fx.realDir)).toBe(false)
      expect(entryOf(st.fx)).toEqual(before)
      onlyMetadataRemoved(a.trace, st.fx)
    }
  })

  it('FI2′ --apply is refused recovery-conflict', async () => {
    const st = await fi2prime(installFixture())
    expect((await act(st, 'apply')).result).toMatchObject({
      status: 'refused',
      reason: 'recovery-conflict',
    })
  })
})

describe('T-FI3 and T-FI4', () => {
  it('FI3 --apply unlinks only metadata; --undo is refused with the remove hint', async () => {
    const st = await fi3(installFixture())
    const u = await act(st, 'undo')
    expect(u.result).toMatchObject({
      status: 'refused',
      reason: 'recovery-not-offered',
      detail: expect.stringContaining('skillsmith remove my-skill'),
    })
    const tHash = hashOf(st.fx.realDir)
    const a = await done(st, 'apply')
    expect(hashOf(st.fx.realDir)).toBe(tHash)
    expect(entryOf(st.fx)).toEqual(POST_ENTRY)
    expect(fs.existsSync(st.opDir)).toBe(false)
    onlyMetadataRemoved(a.trace, st.fx)
  })

  for (const action of ['apply', 'undo'] as const) {
    it(`FI4 --${action}: metadata only; the set-aside copy is unchanged (identity and hash)`, async () => {
      const st = await fi4(installFixture())
      const before = { id: idOf(st.parked), hash: hashOf(st.parked) }
      const a = await done(st, action)
      expect({ id: idOf(st.parked), hash: hashOf(st.parked) }).toEqual(before)
      expect(fs.existsSync(st.fx.realDir)).toBe(false)
      expect(entryOf(st.fx)).toBeUndefined()
      expect(fs.existsSync(st.opDir)).toBe(false)
      expect(a.planned.status === 'planned' && a.planned.plan.notes.join(' ')).toContain(
        `skillsmith restore ${st.parked}`
      )
      onlyMetadataRemoved(a.trace, st.fx)
    })
  }
})

describe('T-FIA: --abandon on anything else', () => {
  it('something else at the skill path: N kept as abandoned-new, the skill path untouched', async () => {
    const st = fi0(installFixture())
    fs.mkdirSync(st.fx.realDir)
    fs.writeFileSync(path.join(st.fx.realDir, 'user.txt'), 'mine\n')
    expect((await opReport(st)).cls).toMatchObject({ kind: 'anything-else' })
    const tHash = hashOf(st.fx.realDir)
    const a = await done(st, 'abandon')
    expect(a.result.kept).toEqual([
      { tree: 'N', kind: 'abandoned-new', path: keptAt(st, 'abandoned-new') },
    ])
    expect(hashOf(st.fx.realDir)).toBe(tHash)
    expect(fs.existsSync(st.opDir)).toBe(false)
    onlyMetadataRemoved(a.trace, st.fx)
  })

  it('nothing of the install left: metadata only; a set-aside copy beside a T stays untouched', async () => {
    const gone = fi0(installFixture())
    fs.renameSync(gone.newDir, path.join(gone.fx.outside, 'gone'))
    expect((await opReport(gone)).cls).toMatchObject({
      kind: 'anything-else',
      reason: expect.stringContaining('nothing of this install is left'),
    })
    const a = await done(gone, 'abandon')
    expect(a.result.kept).toEqual([])
    expect(fs.existsSync(gone.opDir)).toBe(false)
    onlyMetadataRemoved(a.trace, gone.fx)

    const both = await fi4(installFixture())
    fs.mkdirSync(both.fx.realDir)
    fs.writeFileSync(path.join(both.fx.realDir, 'user.txt'), 'mine\n')
    const before = { p: idOf(both.parked), t: hashOf(both.fx.realDir) }
    expect((await opReport(both)).cls).toMatchObject({ kind: 'anything-else' })
    await done(both, 'abandon')
    expect({ p: idOf(both.parked), t: hashOf(both.fx.realDir) }).toEqual(before)
    expect(fs.existsSync(both.opDir)).toBe(false)
  })
})

describe('T-FIP and T-FIO', () => {
  it('an install record whose hash fails is unreadable; --park sets the op dir aside whole', async () => {
    const st = fi0(installFixture())
    const file = path.join(st.opDir, 'record.json')
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...v, postEntry: { tampered: true } }))
    expect((await opReport(st)).cls).toMatchObject({ kind: 'unreadable', why: 'hash-mismatch' })
    const a = await done(st, 'park')
    expect(a.result.kept).toEqual([
      expect.objectContaining({ tree: 'OP', kind: 'unreadable-record' }),
    ])
    expect(fs.existsSync(st.opDir)).toBe(false)
    const parked = a.result.kept[0]!.path
    expect(fs.existsSync(path.join(parked, 'new', 'SKILL.md'))).toBe(true)
  })

  it("another user's install record is refused recovery-other-user before any lock", async () => {
    const st = fi0(installFixture(), { uid: (process.geteuid?.() ?? 0) + 1 })
    for (const action of ['apply', 'undo', 'abandon'] as const) {
      const a = await act(st, action)
      expect(a.result, action).toMatchObject({ status: 'refused', reason: 'recovery-other-user' })
      expect(a.trace).toEqual([])
    }
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})
