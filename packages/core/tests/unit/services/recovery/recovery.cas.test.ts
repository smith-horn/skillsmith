/**
 * SMI-6531 (A1 step 6a-ii): two cases the first pass left uncovered.
 *
 * 1. S1 `--apply` whose manifest CAS fails after the install (design § 2
 *    "Used twice": after renames a CAS failure is a new row): it stops
 *    `changed-since-plan` with the record kept, the new folder at T and nothing
 *    written to the manifest; the rerun sees S2', where `--apply` refuses
 *    `recovery-conflict` and `--undo` puts the old folder back. Control: the
 *    same run without the change commits.
 * 2. T-J2's "undo without the aside" control: the undo sets T aside before it
 *    claims the path, and when something is at T as the restore runs (what an
 *    undo without the aside would face), it refuses with nothing moved over it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashOf, makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { opReport, POST, s1, s2, un1, writeEntry } from './recovery.helpers.js'
import { act, done, entryOf, keptTrees } from './recovery.act.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })
const OTHER = { version: '9.9.9' }

describe('S1 --apply: the manifest entry changes after the install', () => {
  it('control: without the change, the same run commits', async () => {
    const st = await s1(file())
    const a = await done(st, 'apply')
    expect(a.result.manifest).toBe('committed')
    expect(entryOf(st.fx)).toEqual(POST)
    expect(a.trace.some((t) => t.op === 'manifest-write')).toBe(true)
  })

  it("stops changed-since-plan: record kept, N at T, manifest not written; the rerun is S2'", async () => {
    const st = await s1(file())
    const nHash = hashOf(path.join(st.opDir, 'new'))
    const oHash = hashOf(path.join(st.opDir, 'old'))
    const manifest = path.join(st.fx.stateRoot, 'manifest.json')
    let afterChange: Buffer | null = null
    const a = await act(
      st,
      'apply',
      {},
      {
        swap: {
          hooks: {
            afterInstall: () => {
              writeEntry(st.fx, OTHER)
              afterChange = fs.readFileSync(manifest)
            },
          },
        },
      }
    )
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'changed-since-plan' })
    if (a.result.status === 'stopped') {
      expect(a.result.recordPath).toBe(path.join(st.opDir, 'record.json'))
    }
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    // The new folder is installed at T; the old one is still in OP.
    expect(hashOf(st.fx.realDir)).toBe(nHash)
    expect(hashOf(path.join(st.opDir, 'old'))).toBe(oHash)
    // Nothing was written to the manifest: its bytes are the ones the change left.
    expect(afterChange).not.toBeNull()
    expect(fs.readFileSync(manifest).equals(afterChange!)).toBe(true)
    expect(a.trace.some((t) => t.op === 'manifest-write')).toBe(false)
    expect(a.trace.some((t) => t.op === 'rename' && t.dest === st.fx.realDir)).toBe(true)

    // The rerun classifies the post-state: S2' (swapped, manifest other).
    const op = await opReport(st)
    expect(op.cls).toMatchObject({ kind: 'state', state: 'S2prime', postKeep: false })
    const apply = await act(st, 'apply')
    expect(apply.result).toMatchObject({ status: 'refused', reason: 'recovery-conflict' })
    expect(hashOf(st.fx.realDir)).toBe(nHash)
    // `--undo` is S2' `--undo`: the old folder back, the new one kept as undone, manifest untouched.
    const undo = await done(st, 'undo')
    expect(hashOf(st.fx.realDir)).toBe(oHash)
    expect(undo.result.kept.map((k) => k.kind)).toEqual(['undone'])
    expect(keptTrees(st.fx)[`${st.opId}.undone`]).toBe(nHash)
    expect(entryOf(st.fx)).toEqual(OTHER)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})

describe('T-J2 control: undo without the aside', () => {
  it('S2 --undo sets T aside before it claims the path', async () => {
    const st = await s2(file())
    const a = await done(st, 'undo')
    const aside = a.trace.findIndex(
      (t) =>
        t.op === 'rename' && t.path === st.fx.realDir && t.dest === path.join(st.opDir, 'undone')
    )
    const claim = a.trace.findIndex((t) => t.op === 'mkdir' && t.path === st.fx.realDir)
    expect(aside).toBeGreaterThan(-1)
    expect(claim).toBeGreaterThan(aside)
  })

  it('something at T when the restore runs: refused target-changed, nothing moved over it', async () => {
    const st = await s2(file())
    const newHash = hashOf(st.fx.realDir)
    const oHash = hashOf(path.join(st.opDir, 'old'))
    const a = await act(
      st,
      'undo',
      {},
      {
        swap: {
          hooks: {
            beforeRestore: () => {
              fs.mkdirSync(st.fx.realDir)
              fs.writeFileSync(path.join(st.fx.realDir, 'theirs.txt'), 'someone else\n')
            },
          },
        },
      }
    )
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'target-changed' })
    expect(fs.readFileSync(path.join(st.fx.realDir, 'theirs.txt'), 'utf8')).toBe('someone else\n')
    expect(fs.readdirSync(st.fx.realDir)).toEqual(['theirs.txt'])
    expect(hashOf(path.join(st.opDir, 'old'))).toBe(oHash)
    expect(hashOf(path.join(st.opDir, 'undone'))).toBe(newHash)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})

describe('the existing claim is re-checked immediately before the rename', () => {
  it('control: UN1 over an untouched empty claim finishes', async () => {
    const st = await un1(file())
    fs.mkdirSync(st.fx.realDir)
    const a = await done(st, 'apply')
    expect(a.result.installed).toBe('O')
  })

  it('a claim replaced by another empty directory during afterClaim: target-changed, untouched', async () => {
    const st = await un1(file())
    fs.mkdirSync(st.fx.realDir)
    const oHash = hashOf(path.join(st.opDir, 'old'))
    let replacement: bigint | null = null
    const a = await act(
      st,
      'apply',
      {},
      {
        swap: {
          hooks: {
            afterClaim: () => {
              const next = `${st.fx.realDir}.next`
              fs.mkdirSync(next)
              replacement = fs.lstatSync(next, { bigint: true }).ino
              fs.rmdirSync(st.fx.realDir)
              fs.renameSync(next, st.fx.realDir)
            },
          },
        },
      }
    )
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'target-changed' })
    expect(replacement).not.toBeNull()
    expect(fs.lstatSync(st.fx.realDir, { bigint: true }).ino).toBe(replacement)
    expect(fs.readdirSync(st.fx.realDir)).toEqual([])
    expect(hashOf(path.join(st.opDir, 'old'))).toBe(oHash)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    expect(a.trace.some((t) => t.op === 'rename' && t.dest === st.fx.realDir)).toBe(false)
  })
})
