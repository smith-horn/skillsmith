/**
 * SMI-6531 (A1 step 6b-ii): O1 end to end (design `step6b-design.md` § 2 O1,
 * bf-1k0's minors, § 6): the swap writes the attribution into `owner.json`
 * and the abort-new intent; `--clean-staging` routes a keep (and an intent's
 * park) by it when every field validates, and otherwise uses the client-`none`
 * layout whole, never mixing a valid field with a fallback one. A forged but
 * well-formed attribution is an accepted misfile: the tree is still kept, in
 * R's area, and nothing outside that area changes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupAreaPath, rootKeyOf } from '../../../../src/services/skill-swap.area.js'
import { contentOf } from '../skill-swap.abort.helpers.js'
import { areaOf, OP_ID, tmp, useTmpCleanup } from '../skill-swap.helpers.js'
import { done } from './recovery.act.helpers.js'
import type { State } from './recovery.helpers.js'
import { abortLeft, dead, editOwner, noneArea, sidecarAt } from './recovery.clean.helpers.js'

useTmpCleanup()

const stateReal = (st: State): string => fs.realpathSync.native(st.fx.stateRoot)
const rootReal = (st: State): string => fs.realpathSync.native(st.fx.skillsDir)
const json = (p: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>

/** The skill folder and the manifest: what no routing hint may change. */
const skillAndManifest = (st: State): string =>
  JSON.stringify([
    contentOf(st.fx.realDir),
    fs.existsSync(path.join(st.fx.stateRoot, 'manifest.json'))
      ? fs.readFileSync(path.join(st.fx.stateRoot, 'manifest.json'), 'utf8')
      : null,
  ])

describe('O1 writer: the swap writes the attribution from step 1', () => {
  it("owner.json carries client, scope, dirName, manifestKey and the state root's native real path", async () => {
    const st = await abortLeft('abortAfterCheck')
    expect(json(path.join(st.opDir, 'owner.json'))).toEqual({
      pid: process.pid,
      host: expect.any(String),
      uid: expect.any(Number),
      createdAt: expect.any(String),
      client: 'claude-code',
      scope: 'global',
      dirName: st.fx.dirName,
      manifestKey: st.fx.dirName,
      stateRoot: stateReal(st),
    })
  })

  it("the abort-new intent copies owner.json's attribution, field for field", async () => {
    const st = await abortLeft('afterIntent')
    const owner = json(path.join(st.opDir, 'owner.json'))
    const intent = json(path.join(st.opDir, 'park-intent.json'))
    expect(intent.schema).toBe(2)
    for (const k of ['client', 'scope', 'dirName', 'manifestKey', 'stateRoot']) {
      expect(intent[k]).toBe(owner[k])
    }
  })
})

describe('O1 accepted: the keep is routed by the attribution', () => {
  it('into backupAreaPath(stateRoot, client, R, dirName), the sidecar naming those fields and R', async () => {
    const st = await abortLeft('abortAfterCheck')
    const a = await done(st, 'clean-staging', dead)
    const area = backupAreaPath(stateReal(st), 'claude-code', rootReal(st), st.fx.dirName)
    expect(area).toBe(areaOf(st.fx))
    const dest = path.join(area, `${OP_ID}.unrecorded-new`)
    expect(a.result.kept).toEqual([{ tree: 'N', kind: 'unrecorded-new', path: dest }])
    expect(sidecarAt(dest)).toMatchObject({
      client: 'claude-code',
      scope: 'global',
      dirName: st.fx.dirName,
      manifestKey: st.fx.dirName,
      skillsDir: rootReal(st),
    })
  })

  it("an abort-new intent's park names the attributed client and indexes in the attributed state root", async () => {
    const st = await abortLeft('afterIntent')
    // Another real client in both (they agree): the park follows it.
    editOwner(st, { client: 'cursor' })
    const intent = path.join(st.opDir, 'park-intent.json')
    fs.writeFileSync(intent, JSON.stringify({ ...json(intent), client: 'cursor' }, null, 2) + '\n')
    const a = await done(st, 'clean-staging', dead)
    const parked = a.result.kept[0]!.path
    expect(sidecarAt(parked)).toMatchObject({ kind: 'abort-new', client: 'cursor' })
    const index = fs.readFileSync(path.join(stateReal(st), 'parked-index.jsonl'), 'utf8')
    expect(index).toContain('"client":"cursor"')
  })
})

describe("O1 scope: the update target's install scope (global or workspace), not 6b-i's 'user'", () => {
  it("a swap whose input scope is 'global' (the real InstallScope) is accepted and routed by its client", async () => {
    const st = await abortLeft('abortAfterCheck')
    expect(st.p.input.scope).toBe('global')
    expect(json(path.join(st.opDir, 'owner.json')).scope).toBe('global')
    const a = await done(st, 'clean-staging', dead)
    expect(a.result.kept[0]!.path).toBe(path.join(areaOf(st.fx), `${OP_ID}.unrecorded-new`))
    expect(sidecarAt(a.result.kept[0]!.path)).toMatchObject({
      client: 'claude-code',
      scope: 'global',
    })
  })

  it("the pair: scope 'user' (no writer produces it) is invalid, so the whole attribution falls back", async () => {
    const st = await abortLeft('abortAfterCheck')
    editOwner(st, { scope: 'user' })
    const a = await done(st, 'clean-staging', dead)
    expect(a.result.kept[0]!.path).toBe(
      path.join(noneArea(st.fx, stateReal(st)), `${OP_ID}.unrecorded-new`)
    )
    expect(sidecarAt(a.result.kept[0]!.path)).toMatchObject({ client: 'none', scope: 'none' })
  })
})

describe('O1 all or nothing: one invalid field discards the whole attribution', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['a client not in CLIENT_IDS', { client: 'emacs' }],
    ['a dirName ../x', { dirName: '../x' }],
    ['a scope admin', { scope: 'admin' }],
    ['a stateRoot doctor did not discover', { stateRoot: '/elsewhere' }],
  ]
  for (const [label, over] of BAD) {
    it(`${label}: kept in <primary>/backups/update/none/<rootKey(R)>/<opId>; no valid field survives`, async () => {
      const st = await abortLeft('abortAfterCheck')
      editOwner(st, over)
      const a = await done(st, 'clean-staging', dead)
      const area = noneArea(st.fx, stateReal(st))
      expect(area).toBe(
        path.join(stateReal(st), 'backups', 'update', 'none', rootKeyOf(rootReal(st)), OP_ID)
      )
      const dest = path.join(area, `${OP_ID}.unrecorded-new`)
      expect(a.result.kept).toEqual([{ tree: 'N', kind: 'unrecorded-new', path: dest }])
      const side = sidecarAt(dest)
      expect(side).toMatchObject({ client: 'none', scope: 'none', manifestKey: '', dirName: OP_ID })
      // The valid fields (client claude-code, scope global, dirName my-skill) appear nowhere.
      for (const v of ['claude-code', st.fx.dirName]) {
        expect(dest).not.toContain(v)
        expect(JSON.stringify(side)).not.toContain(`"${v}"`)
      }
      expect(side.scope).not.toBe('global')
      // Nothing was made in the attributed area, nor beside it (`../x`).
      expect(fs.existsSync(path.join(stateReal(st), 'backups', 'update', 'claude-code'))).toBe(
        false
      )
      expect(fs.readdirSync(path.join(stateReal(st), 'backups', 'update'))).toEqual(['none'])
    })
  }

  it("owner.json's and the intent's attributions differ: the park falls back to client none", async () => {
    const st = await abortLeft('afterIntent')
    editOwner(st, { client: 'cursor' })
    const a = await done(st, 'clean-staging', dead)
    const parked = a.result.kept[0]!.path
    expect(sidecarAt(parked)).toMatchObject({ kind: 'abort-new', client: 'none' })
    const index = fs.readFileSync(path.join(stateReal(st), 'parked-index.jsonl'), 'utf8')
    expect(index).toContain('"client":"none"')
    expect(index).not.toContain('"client":"cursor"')
  })
})

describe('O1 forged but well-formed: an accepted misfile, nothing lost, nothing else changed', () => {
  it('another real client: filed under that client in R’s area', async () => {
    const st = await abortLeft('abortAfterCheck')
    editOwner(st, { client: 'cursor' })
    const before = skillAndManifest(st)
    const a = await done(st, 'clean-staging', dead)
    const area = backupAreaPath(stateReal(st), 'cursor', rootReal(st), st.fx.dirName)
    expect(a.result.kept[0]!.path).toBe(path.join(area, `${OP_ID}.unrecorded-new`))
    expect(sidecarAt(a.result.kept[0]!.path)).toMatchObject({ client: 'cursor' })
    expect(skillAndManifest(st)).toBe(before)
  })

  it('a dirName and manifestKey that are neither this op’s nor each other’s: filed under that folder name', async () => {
    const st = await abortLeft('abortAfterCheck')
    editOwner(st, { dirName: 'someone-else', manifestKey: 'another-key' })
    const before = skillAndManifest(st)
    const a = await done(st, 'clean-staging', dead)
    const area = backupAreaPath(stateReal(st), 'claude-code', rootReal(st), 'someone-else')
    expect(a.result.kept[0]!.path).toBe(path.join(area, `${OP_ID}.unrecorded-new`))
    expect(sidecarAt(a.result.kept[0]!.path)).toMatchObject({
      dirName: 'someone-else',
      manifestKey: 'another-key',
    })
    // No skill folder named by the hint exists or was made; the real skill and the manifest are unchanged.
    expect(fs.existsSync(path.join(st.fx.skillsDir, 'someone-else'))).toBe(false)
    expect(skillAndManifest(st)).toBe(before)
  })

  it('another state root doctor discovered: the keep goes there', async () => {
    const st = await abortLeft('abortAfterCheck')
    const other = fs.realpathSync.native(tmp('other-state-'))
    editOwner(st, { stateRoot: other })
    const a = await done(st, 'clean-staging', {
      ...dead,
      stateRoots: [stateReal(st), other],
    })
    const area = backupAreaPath(other, 'claude-code', rootReal(st), st.fx.dirName)
    expect(a.result.kept[0]!.path).toBe(path.join(area, `${OP_ID}.unrecorded-new`))
    expect(fs.existsSync(path.join(stateReal(st), 'backups'))).toBe(false)
  })

  it('a state root neither discovered nor given: refused as a route (client-none layout), nothing written there', async () => {
    const st = await abortLeft('abortAfterCheck')
    const other = fs.realpathSync.native(tmp('undiscovered-state-'))
    editOwner(st, { stateRoot: other })
    const a = await done(st, 'clean-staging', dead)
    expect(a.result.kept[0]!.path).toBe(
      path.join(noneArea(st.fx, stateReal(st)), `${OP_ID}.unrecorded-new`)
    )
    expect(fs.readdirSync(other)).toEqual([])
  })
})
