/**
 * SMI-6531 (A1 step 6b-i): O1's reader side (design § 2 O1, bf-1k0 minors):
 * the attribution is accepted only when every field validates, and otherwise
 * discarded whole for the client-`none` layout; validated and fallback fields
 * are never mixed. 6b-i has no writer of these fields, so the end-to-end case
 * plants `owner.json` by hand.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  keepAreaOf,
  keepSidecarOf,
  parkClientOf,
  parkIndexOf,
  resolveAttribution,
} from '../../../../src/services/skill-recovery.attribution.js'
import { rootKeyOf } from '../../../../src/services/skill-swap.area.js'
import { makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { act } from './recovery.act.helpers.js'
import { s2 } from './recovery.helpers.js'

useTmpCleanup()

const ROOTS = ['/state/a', '/state/b']
const VALID = {
  client: 'cursor',
  scope: 'workspace',
  dirName: 'my-skill',
  manifestKey: 'my-skill::cursor',
  stateRoot: '/state/b',
}
const R = '/skills'
const OP = 'a'.repeat(32)

describe('resolveAttribution: all or nothing', () => {
  it('accepts a fully valid attribution and routes by it', () => {
    const a = resolveAttribution({ owner: { pid: 1, ...VALID }, stateRoots: ROOTS })
    expect(a).toEqual({ kind: 'attributed', ...VALID })
    expect(parkClientOf(a)).toBe('cursor')
    expect(parkIndexOf(a)).toBe(path.join('/state/b', 'parked-index.jsonl'))
    expect(keepAreaOf(a, R, OP)).toBe(
      path.join('/state/b', 'backups', 'update', 'cursor', rootKeyOf(R), 'my-skill')
    )
  })

  const BAD: Array<[string, Record<string, unknown>]> = [
    ['a client not in CLIENT_IDS', { client: 'emacs' }],
    ['a dirName that is not one component', { dirName: '../x' }],
    ['a manifestKey that is not one component', { manifestKey: 'a/b' }],
    ['a scope that is not an install scope (admin)', { scope: 'admin' }],
    ['the scope user (6b-i design premise; no writer produces it)', { scope: 'user' }],
    ['a stateRoot doctor did not discover', { stateRoot: '/elsewhere' }],
  ]
  for (const [name, over] of BAD) {
    it(`${name}: the whole attribution is discarded; no valid field survives`, () => {
      const a = resolveAttribution({ owner: { ...VALID, ...over }, stateRoots: ROOTS })
      expect(a.kind).toBe('fallback')
      expect(parkClientOf(a)).toBe('none')
      // The primary state root, never the attribution's (valid) one.
      expect(parkIndexOf(a)).toBe(path.join('/state/a', 'parked-index.jsonl'))
      const area = keepAreaOf(a, R, OP)!
      expect(area).toBe(path.join('/state/a', 'backups', 'update', 'none', rootKeyOf(R), OP))
      expect(area).not.toContain('cursor')
      expect(area).not.toContain('my-skill')
      expect(keepSidecarOf(a, OP)).toEqual({
        client: 'none',
        scope: 'none',
        manifestKey: '',
        dirName: OP,
      })
    })
  }

  it('owner.json and the intent disagreeing: discarded; agreeing: accepted', () => {
    const differ = resolveAttribution({
      owner: VALID,
      intent: { ...VALID, client: 'claude-code' },
      stateRoots: ROOTS,
    })
    expect(differ).toMatchObject({ kind: 'fallback', why: expect.stringContaining('differ') })
    const agree = resolveAttribution({ owner: VALID, intent: { ...VALID }, stateRoots: ROOTS })
    expect(agree.kind).toBe('attributed')
  })

  it("none at all (today's owner.json): fallback, and with no state root no index line", () => {
    const a = resolveAttribution({ owner: { pid: 1, host: 'h', uid: 0 }, stateRoots: [] })
    expect(a).toMatchObject({ kind: 'fallback', primary: null })
    expect(parkIndexOf(a)).toBeNull()
    expect(keepAreaOf(a, R, OP)).toBeNull()
  })
})

describe('--park uses the attribution for its client and index', () => {
  it('a valid owner.json attribution names its client in the parked sidecar and its index', async () => {
    const st = await s2(makeFixture({ 'SKILL.md': '# v1\n' }))
    const rec = path.join(st.opDir, 'record.json')
    fs.writeFileSync(rec, '{ not a record')
    const stateRoot = fs.realpathSync(st.fx.stateRoot)
    const owner = path.join(st.opDir, 'owner.json')
    const was = JSON.parse(fs.readFileSync(owner, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(
      owner,
      JSON.stringify({
        ...was,
        client: 'cursor',
        scope: 'global',
        dirName: st.fx.dirName,
        manifestKey: st.fx.dirName,
        stateRoot,
      })
    )
    const a = await act(st, 'park')
    expect(a.result.status).toBe('done')
    if (a.result.status !== 'done') return
    const parked = a.result.kept[0]!.path
    expect(JSON.parse(fs.readFileSync(`${parked}.json`, 'utf8'))).toMatchObject({
      kind: 'unreadable-record',
      client: 'cursor',
    })
    expect(fs.readFileSync(path.join(stateRoot, 'parked-index.jsonl'), 'utf8')).toContain(
      '"client":"cursor"'
    )
  })
})
