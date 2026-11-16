/**
 * SMI-6531 (A1 step 6c-ii-b), fix round 2, Major A: an index-only area under a skills root
 * discovery did not find takes no lock 1 of it, because that root's update records were never
 * scanned, so an unreadable record there could not make its copies `unknown`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planPrune } from '../../../src/install/prune.select.js'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import { assignLocks } from '../../../src/services/skill-backups.locks.js'
import { hermetic, indexLine, mkBase, parkAt } from './skill-backups.helpers.js'

const bases: string[] = []
afterEach(() => {
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

function unreadableRecord(root: string, opId: string): void {
  const op = path.join(root, '.skillsmith-staging', opId)
  fs.mkdirSync(op, { recursive: true })
  fs.writeFileSync(path.join(op, 'record.json'), '{not json')
}

async function plan(opId: string, copyPath: string, l: Awaited<ReturnType<typeof listBackups>>) {
  const locks = await assignLocks(l)
  const p = planPrune(
    l,
    { now: Date.now() + 60_000, includeKept: false, allowChanged: [], op: opId },
    locks
  )
  return {
    lock: locks.get(copyPath),
    selected: p.groups.flatMap((g) => g.items.map((i) => i.copyPath)).includes(copyPath),
    row: l.parked.flatMap((a) => a.rows).find((r) => r.copy.copyPath === copyPath),
  }
}

describe('Q1: lock 1 of a root needs its records scanned', () => {
  it('an index-only area under an undiscovered root is unknown and never selected', async () => {
    const b = mkBase('sbk-undisc-')
    bases.push(b)
    const state = path.join(b, '.skillsmith')
    const stray = path.join(b, 'stray-root')
    fs.mkdirSync(stray, { recursive: true })
    const x = parkAt(stray, 'x', { opId: 'op-S' })
    indexLine(state, x.copyPath, 'op-S')
    unreadableRecord(stray, 'op-S')
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    expect(l.discovery.roots.map((r) => r.root)).not.toContain(stray)
    const r = await plan('op-S', x.copyPath, l)
    expect(r.row).toBeDefined()
    expect(r.lock).toEqual({
      kind: 'unknown',
      reason: expect.stringContaining('was not discovered, so its update records were not read'),
    })
    expect(r.selected).toBe(false)
  })

  it('control: the same copy in a discovered root keeps lock 1, and the record makes it unknown', async () => {
    const b = mkBase('sbk-undisc-c-')
    bases.push(b)
    const state = path.join(b, '.skillsmith')
    const root = path.join(b, 'clients', 'claude-code')
    const x = parkAt(root, 'x', { opId: 'op-S' })
    unreadableRecord(root, 'op-S')
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    const r = await plan('op-S', x.copyPath, l)
    expect(r.lock).toMatchObject({ kind: 'lock1' })
    expect(r.row?.protection.status).toBe('unknown')
    expect(r.selected).toBe(false)
  })
})
