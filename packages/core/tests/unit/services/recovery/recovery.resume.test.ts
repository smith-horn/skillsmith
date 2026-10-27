/**
 * SMI-6531 (A1 step 6a-ii): resuming a keep from its publish sub-state (T-J9's
 * `--apply`, UD38's own-sidecar rule, the one-device sidecar rewrite R1-R3 and
 * its kill tests, the Q10 temp rule, T-X14's S0 `--apply` started keep, and
 * T-J13's one-device foreign-entry case).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SwapHookPoint } from '../../../../src/services/skill-swap.types.js'
import {
  areaOf,
  hashOf,
  makeFixture,
  modify,
  plan,
  run,
  useTmpCleanup,
} from '../skill-swap.helpers.js'
import { destOf, keepTree, opReport, s0, s3, sha, syncManifest } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import {
  act,
  areaNames,
  done,
  keptTrees,
  killAt,
  onlyMetadataRemoved,
} from './recovery.act.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

/** S3 with O's keep at P1 (sidecar only), then O edited so its hash no longer matches. */
async function p1Changed(): Promise<State> {
  const st = await s3(file())
  keepTree(st, 'old', 'backup', { move: false })
  fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# O edited after its sidecar\n')
  return st
}

const sidecarHash = (st: State): string | null =>
  (
    JSON.parse(fs.readFileSync(`${destOf(st, 'backup')}.json`, 'utf8')) as {
      treeHash: string | null
    }
  ).treeHash

describe('the one-device sidecar rewrite (R1-R3)', () => {
  it('uninterrupted: P1 with a changed source rewrites the sidecar, then moves the tree', async () => {
    const st = await p1Changed()
    const oHash = hashOf(path.join(st.opDir, 'old'))
    const a = await done(st, 'apply')
    expect(sidecarHash(st)).toBe(oHash)
    expect(keptTrees(st.fx)[st.opId]).toBe(oHash)
    expect(areaNames(st.fx)).toEqual([st.opId, `${st.opId}.json`])
    expect(a.trace.some((t) => t.op === 'link' && t.dest === `${destOf(st, 'backup')}.json`)).toBe(
      true
    )
    onlyMetadataRemoved(a.trace, st.fx)
  })

  const BOUNDARIES: Array<[SwapHookPoint, string]> = [
    ['afterSidecarTemp', 'R1'],
    ['afterRewriteTempSync', 'R1'],
    ['afterSidecarUnlink', 'R2'],
    ['afterRewriteLink', 'R3'],
    ['afterRewriteLinkSync', 'R3'],
    ['afterRewriteTempUnlink', 'P1'],
  ]
  for (const [point, state] of BOUNDARIES) {
    it(`killed at ${point} (${state}): the rerun ends with one sidecar equal to the source's hash`, async () => {
      const st = await p1Changed()
      const oHash = hashOf(path.join(st.opDir, 'old'))
      const first = await act(st, 'apply', {}, killAt(point))
      expect(first.result.status).toBe('stopped')
      const op = await opReport(st)
      if (op.cls.kind !== 'state') throw new Error(`a row expected, got ${op.cls.kind}`)
      expect(op.cls.facts.groups.map((g) => g.state)).toEqual([state])
      const again = await done(st, 'apply')
      expect(again.result.status).toBe('done')
      expect(sidecarHash(st)).toBe(oHash)
      expect(keptTrees(st.fx)[st.opId]).toBe(oHash)
      expect(areaNames(st.fx)).toEqual([st.opId, `${st.opId}.json`])
      expect(fs.existsSync(st.opDir)).toBe(false)
    })
  }

  it('the temp opened before it was written (empty, one link) is provable: unlinked, then the rewrite', async () => {
    const st = await p1Changed()
    const oHash = hashOf(path.join(st.opDir, 'old'))
    fs.writeFileSync(`${destOf(st, 'backup')}.json.tmp`, '')
    const a = await done(st, 'apply')
    expect(a.trace).toContainEqual({ op: 'unlink', path: `${destOf(st, 'backup')}.json.tmp` })
    expect(sidecarHash(st)).toBe(oHash)
    expect(areaNames(st.fx)).toEqual([st.opId, `${st.opId}.json`])
  })

  it("a temp that is not provably this op's is refused, named, and left untouched", async () => {
    const st = await p1Changed()
    const tmp = `${destOf(st, 'backup')}.json.tmp`
    fs.writeFileSync(tmp, '{"someone":"else"}\n')
    const before = sha(tmp)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'backup-unsafe' })
    if (a.result.status === 'stopped') expect(a.result.detail).toContain(tmp)
    expect(sha(tmp)).toBe(before)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    expect(fs.existsSync(path.join(st.opDir, 'old'))).toBe(true)
  })
})

describe("T-J9 --apply: a real run killed inside step 12's publish", () => {
  const POINTS: Array<[SwapHookPoint, string]> = [
    ['afterSidecarTemp', 'P0'],
    ['afterSidecar', 'P1'],
    ['afterPublishRename', 'P5'],
  ]
  for (const [point, state] of POINTS) {
    it(`killed at ${point} (${state}): --apply finishes with the backup and its sidecar, op dir gone`, async () => {
      const fx = file()
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const r = await run(p, {
        hooks: {
          [point]: () => {
            throw new Error(`killed at ${point}`)
          },
        },
      })
      expect(r.result).toMatchObject({ status: 'committed', incomplete: { step: 'publish' } })
      const st = { fx, p, opId: 'a'.repeat(32), opDir: path.join(fx.staging, 'a'.repeat(32)) }
      syncManifest(st)
      const a = await done(st, 'apply')
      expect(a.result.from).toContain('S3')
      expect(fs.existsSync(path.join(areaOf(fx), st.opId))).toBe(true)
      expect(fs.existsSync(path.join(areaOf(fx), `${st.opId}.json`))).toBe(true)
      expect(fs.existsSync(path.join(areaOf(fx), `${st.opId}.json.tmp`))).toBe(false)
      expect(fs.existsSync(st.opDir)).toBe(false)
      // One device: no park of OP, and OP is removed by rmdir.
      expect(a.trace.some((t) => t.op === 'park')).toBe(false)
      expect(a.trace).toContainEqual({ op: 'rmdir', path: st.opDir })
    })
  }
})

describe('UD38: the backup name is free to its own resume', () => {
  it("P1's own published sidecar does not stop the backup's resume", async () => {
    const st = await s3(file())
    keepTree(st, 'old', 'backup', { move: false })
    const a = await done(st, 'apply')
    expect(a.result.kept).toEqual([{ tree: 'O', kind: 'backup', path: destOf(st, 'backup') }])
    expect(keptTrees(st.fx)[st.opId]).toBeDefined()
  })

  it("another op's tree at the backup's name is not this op's keep: refused, nothing moved", async () => {
    const st = await s3(file())
    fs.mkdirSync(destOf(st, 'backup'), { recursive: true })
    fs.writeFileSync(path.join(destOf(st, 'backup'), 'x'), 'someone else\n')
    const a = await act(st, 'apply')
    expect(a.result.status).not.toBe('done')
    expect(fs.existsSync(path.join(st.opDir, 'old'))).toBe(true)
    expect(fs.readFileSync(path.join(destOf(st, 'backup'), 'x'), 'utf8')).toBe('someone else\n')
  })
})

describe('T-X14 S0 --apply: a started keep resumes with its own kind', () => {
  it('an edited-new keep started, then N reverted to hash postTree: the kind stays edited-new', async () => {
    const st = await s0(file())
    const n = path.join(st.opDir, 'new')
    const original = fs.readFileSync(path.join(n, 'SKILL.md'))
    fs.writeFileSync(path.join(n, 'SKILL.md'), '# an edit\n')
    keepTree(st, 'new', 'edited-new', { move: false })
    fs.writeFileSync(path.join(n, 'SKILL.md'), original)
    const rec = JSON.parse(fs.readFileSync(path.join(st.opDir, 'record.json'), 'utf8')) as {
      postTree: string
    }
    expect(hashOf(n)).toBe(rec.postTree)
    const a = await done(st, 'apply')
    expect(a.result.kept.map((k) => k.kind)).toEqual(['edited-new'])
    expect(fs.existsSync(destOf(st, 'edited-new'))).toBe(true)
    expect(fs.existsSync(destOf(st, 'unused-new'))).toBe(false)
  })
})

describe("T-J13 one device: another op's entries in the area are untouched", () => {
  it('every new name carries this opId and the other entries stay byte-identical', async () => {
    const st = await s3(file())
    const area = areaOf(st.fx)
    fs.mkdirSync(area, { recursive: true })
    const other = 'b'.repeat(32)
    fs.mkdirSync(path.join(area, other))
    fs.writeFileSync(path.join(area, other, 'SKILL.md'), '# other op\n')
    fs.writeFileSync(path.join(area, `${other}.json`), '{"opId":"other"}\n')
    fs.writeFileSync(path.join(area, `${other}.json.tmp`), '')
    const before = [`${other}.json`, `${other}.json.tmp`].map((n) => sha(path.join(area, n)))
    const beforeNames = areaNames(st.fx)
    await done(st, 'apply')
    const added = areaNames(st.fx).filter((n) => !beforeNames.includes(n))
    expect(added.length).toBeGreaterThan(0)
    for (const n of added) expect(n.startsWith(st.opId)).toBe(true)
    expect([`${other}.json`, `${other}.json.tmp`].map((n) => sha(path.join(area, n)))).toEqual(
      before
    )
    expect(hashOf(path.join(area, other))).toBeDefined()
  })
})
