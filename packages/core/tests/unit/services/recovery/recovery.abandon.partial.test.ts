/**
 * SMI-6531 (A1 step 6b-iii, confirmation round on df8df387e, Major 2): a kill
 * between a copy temp's `partial-copy` sidecar and its rename.
 *
 * `keepTempAsPartial` publishes `<opId>.partial-copy[.k].json`, then renames
 * the temp to that name. A kill between the two leaves a `partial-copy` group
 * with a valid sidecar and no tree, beside the temp it names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { areaOf, hashOf, makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { act, done, requestOf } from './recovery.act.helpers.js'
import { opReport, s2, s3 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { killed, xfile } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

/** Anything else (S2 with a foreign U) with an orphan copy temp `.tmp-<opId>` in the area. */
async function withOrphan(): Promise<State & { temp: string }> {
  const st = await s2(file())
  fs.mkdirSync(path.join(st.opDir, 'undone'))
  fs.writeFileSync(path.join(st.opDir, 'undone', 'stray.md'), 'kept as it is\n')
  const area = areaOf(st.fx)
  fs.mkdirSync(area, { recursive: true })
  const temp = path.join(area, `.tmp-${OP_ID}`)
  fs.mkdirSync(temp)
  fs.writeFileSync(path.join(temp, 'SKILL.md'), '# half a copy\n')
  return { ...st, temp }
}

/** Runs --abandon, killed once the partial-copy sidecar is published (the area sync after its link). */
async function killedAfterPartialSidecar(st: State): Promise<void> {
  const planned = await planRecovery(requestOf(st, 'abandon'))
  if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
  const area = areaOf(st.fx)
  let linked = false
  const r = await executeRecovery(planned, {
    swap: {
      trace: (t) => {
        if (t.op === 'link' && t.dest === path.join(area, `${OP_ID}.partial-copy.json`))
          linked = true
        else if (linked && t.op === 'dirsync' && t.path === area) {
          throw new Error('killed between the partial sidecar and its rename')
        }
      },
    },
  })
  expect(r.status).toBe('stopped')
}

describe('Major 2: a kill between the partial-copy sidecar and the rename', () => {
  it('leaves the sidecar and the temp; the same command finishes the rename and keeps everything', async () => {
    const st = await withOrphan()
    const tempHash = hashOf(st.temp)
    await killedAfterPartialSidecar(st)
    const area = areaOf(st.fx)
    const dest = path.join(area, `${OP_ID}.partial-copy`)
    // What the kill left: the sidecar published, the tree still at its temp name.
    expect(fs.existsSync(`${dest}.json`)).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(st.temp)).toBe(true)
    const cls = (await opReport(st)).cls
    const groups = 'facts' in cls && cls.facts !== null ? cls.facts.groups : []
    const g = groups.find((x) => x.base === `${OP_ID}.partial-copy`)
    expect(g?.unclassified).toBeNull()
    expect(g?.pendingTemp).toBe(OP_ID)
    // The plan names the keep it finishes.
    const planned = await planRecovery(requestOf(st, 'abandon'))
    if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
    expect(planned.plan.remaining[0]).toBe(
      `finish keeping the copy temp ${st.temp} as ${dest} (its partial-copy sidecar is published; only the rename is left)`
    )
    const again = await act(st, 'abandon')
    expect(again.result.status, JSON.stringify(again.result).slice(0, 500)).toBe('done')
    expect(hashOf(dest)).toBe(tempHash)
    expect(fs.existsSync(st.temp)).toBe(false)
    expect(fs.readdirSync(area).filter((n) => n.includes('.partial-copy'))).toEqual([
      `${OP_ID}.partial-copy`,
      `${OP_ID}.partial-copy.json`,
    ])
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('--apply across devices: a P2 temp killed in the same window; the rerun finishes that keep, no second partial', async () => {
    const st = await s3(xfile())
    // A kill inside the backup's copy leaves P2: the copy temp, the backup's sidecar.
    const first = await act(
      st,
      'apply',
      {},
      { swap: { duringBackupCopy: () => killed('mid-copy') } }
    )
    expect(first.result.status).toBe('stopped')
    const temp = path.join(areaOf(st.fx), `.tmp-${OP_ID}`)
    const tempHash = hashOf(temp)
    const planned = await planRecovery(requestOf(st, 'apply'))
    if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
    const area = areaOf(st.fx)
    const dest = path.join(area, `${OP_ID}.partial-copy`)
    let linked = false
    const second = await executeRecovery(planned, {
      swap: {
        trace: (t) => {
          if (t.op === 'link' && t.dest === `${dest}.json`) linked = true
          else if (linked && t.op === 'dirsync' && t.path === area) killed('partial window')
        },
      },
    })
    expect(second.status).toBe('stopped')
    expect(fs.existsSync(`${dest}.json`)).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    const cls = (await opReport(st)).cls
    expect(cls.kind, JSON.stringify(cls).slice(0, 300)).toBe('state')
    const again = await done(st, 'apply')
    expect(again.result.status).toBe('done')
    expect(hashOf(dest)).toBe(tempHash)
    expect(
      fs
        .readdirSync(area)
        .filter((n) => n.includes('.partial-copy'))
        .sort()
    ).toEqual([`${OP_ID}.partial-copy`, `${OP_ID}.partial-copy.json`])
    expect(fs.existsSync(path.join(area, OP_ID))).toBe(true)
  })

  it('--apply across devices: a P2 temp equal to the source (changed after its sidecar), paired with a pending sidecar', async () => {
    const st = await s3(xfile())
    const first = await act(
      st,
      'apply',
      {},
      { swap: { duringBackupCopy: () => killed('mid-copy') } }
    )
    expect(first.result.status).toBe('stopped')
    const area = areaOf(st.fx)
    const temp = path.join(area, `.tmp-${OP_ID}`)
    const dest = path.join(area, `${OP_ID}.partial-copy`)
    const planned = await planRecovery(requestOf(st, 'apply'))
    if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
    let linked = false
    const second = await executeRecovery(planned, {
      swap: {
        trace: (t) => {
          if (t.op === 'link' && t.dest === `${dest}.json`) linked = true
          else if (linked && t.op === 'dirsync' && t.path === area) killed('partial window')
        },
      },
    })
    expect(second.status).toBe('stopped')
    // The source changes after its sidecar into exactly what the temp holds: the temp equals it.
    const old = path.join(st.opDir, 'old')
    for (const n of fs.readdirSync(old)) fs.rmSync(path.join(old, n), { recursive: true })
    for (const n of fs.readdirSync(temp)) {
      fs.cpSync(path.join(temp, n), path.join(old, n), { recursive: true })
    }
    // The tree hash covers modes too: give each entry of old/ (its root included) the temp's mode.
    const modes = (from: string, to: string): void => {
      fs.chmodSync(to, fs.lstatSync(from).mode & 0o7777)
      if (fs.lstatSync(from).isDirectory()) {
        for (const n of fs.readdirSync(from)) modes(path.join(from, n), path.join(to, n))
      }
    }
    modes(temp, old)
    const tempHash = hashOf(temp)
    const cls = (await opReport(st)).cls
    if (cls.kind !== 'state') throw new Error(`expected a row, got ${cls.kind}`)
    const g = cls.facts.groups.find((x) => x.base === OP_ID)
    // Reproduced: P2 (the sidecar's hash is neither), with the temp's hash the source's.
    expect(g?.state).toBe('P2')
    expect(g?.copyTmp.present && g.src.present && g.copyTmp.hash === g.src.hash).toBe(true)
    expect(cls.facts.groups.find((x) => x.base === `${OP_ID}.partial-copy`)?.pendingTemp).toBe(
      OP_ID
    )
    await done(st, 'apply')
    // The pending keep finished: its sidecar has its tree, and the temp it named is that tree.
    expect(hashOf(dest)).toBe(tempHash)
    expect(
      fs
        .readdirSync(area)
        .filter((n) => n.includes('.partial-copy'))
        .sort()
    ).toEqual([`${OP_ID}.partial-copy`, `${OP_ID}.partial-copy.json`])
    expect(fs.existsSync(path.join(area, OP_ID))).toBe(true)
    expect(fs.existsSync(temp)).toBe(false)
  })
})
