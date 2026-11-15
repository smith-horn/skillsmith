/**
 * SMI-6531 (A1 step 6c-ii-b), fix round 2, Minor 3: no fail-open defaults. A row whose
 * protection was never decided reads `unknown`, and the planner selects only on an
 * explicit `unprotected`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planPrune } from '../../../src/install/prune.select.js'
import type { LockAssignment } from '../../../src/install/prune.plan.types.js'
import { hermetic, mkBase, parkAt } from './skill-backups.helpers.js'

const decided = vi.hoisted(() => ({ skip: false }))
vi.mock('../../../src/services/skill-backups.protect.js', async (orig) => {
  const real = await orig<typeof import('../../../src/services/skill-backups.protect.js')>()
  return {
    ...real,
    protectAll: (...a: Parameters<typeof real.protectAll>) =>
      decided.skip ? undefined : real.protectAll(...a),
  }
})
import { listBackups } from '../../../src/services/skill-backups.listing.js'

const bases: string[] = []
afterEach(() => {
  decided.skip = false
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

async function setup() {
  const b = mkBase('sbk-undecided-')
  bases.push(b)
  const root = path.join(b, 'clients', 'claude-code')
  const x = parkAt(root, 'x', { opId: 'op-1' })
  const l = await listBackups({ stateRoot: path.join(b, '.skillsmith'), discovery: hermetic(b) })
  const locks = new Map<string, LockAssignment>()
  const real = fs.realpathSync(root)
  locks.set(x.copyPath, {
    kind: 'lock1',
    path: path.join(real, '.skillsmith-writes.lock'),
    root: real,
  })
  const row = l.parked.flatMap((a) => a.rows).find((r) => r.copy.copyPath === x.copyPath)
  const run = () => {
    const p = planPrune(
      l,
      { now: Date.now() + 60_000, includeKept: false, allowChanged: [], op: 'op-1' },
      locks
    )
    return {
      selected: p.groups.flatMap((g) => g.items.map((i) => i.copyPath)).includes(x.copyPath),
      excluded: p.excluded.find((e) => e.copyPath === x.copyPath),
    }
  }
  return { row, run }
}

describe('protection that was never decided', () => {
  it('control: a decided, unprotected row is selected', async () => {
    const { row, run } = await setup()
    expect(row?.protection).toEqual({ status: 'unprotected' })
    expect(run().selected).toBe(true)
  })

  it('a listing whose protection was not decided reads unknown, and is never selected', async () => {
    decided.skip = true
    const { row, run } = await setup()
    expect(row?.protection).toEqual({ status: 'unknown', reason: 'protection not decided' })
    expect(run().selected).toBe(false)
  })

  it('a row with a status the planner does not know is never selected', async () => {
    const { row, run } = await setup()
    ;(row as { protection: unknown }).protection = { status: 'cleared-by-mistake' }
    const r = run()
    expect(r.selected).toBe(false)
    expect(r.excluded?.reason).toMatchObject({ code: 'protection-unknown' })
  })
})
