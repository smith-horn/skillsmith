/**
 * SMI-6531 (A1 step 8-i-a-2): each fresh-install state classifies into its
 * row (design § 3), built with the production primitives
 * (`install.helpers.ts`), and the listing labels it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { useTmpCleanup } from '../skill-swap.helpers.js'
import { opReport } from './recovery.helpers.js'
import { act } from './recovery.act.helpers.js'
import {
  fi0,
  fi1,
  fi2,
  fi2prime,
  fi2u,
  fi3,
  fi4,
  installFixture,
  keepWith,
} from './install.helpers.js'

useTmpCleanup()

describe('install rows: each built state is its row', () => {
  it('FI0, FI1, FI2, FI2′, FI2u, FI3, FI4 each classify into their row, with the record op', async () => {
    const cases = [
      ['FI0', 'FI0 not claimed', () => Promise.resolve(fi0(installFixture()))],
      ['FI1', 'FI1 claimed', () => fi1(installFixture())],
      ['FI2', 'FI2 published', () => fi2(installFixture())],
      ['FI2prime', "FI2' published, manifest changed", () => fi2prime(installFixture())],
      ['FI2u', 'FI2u undo, set aside', () => fi2u(installFixture())],
      ['FI3', 'FI3 committed', () => fi3(installFixture())],
      ['FI4', 'FI4 rolled back', () => fi4(installFixture())],
    ] as const
    for (const [state, label, build] of cases) {
      const st = await build()
      const op = await opReport(st)
      expect(op.cls, state).toMatchObject({ kind: 'state', state, postKeep: false })
      expect(op.label, state).toBe(label)
      if (op.cls.kind !== 'state') throw new Error('unreachable')
      expect(op.cls.facts.record.op).toBe('install')
    }
  })

  it('FI0 with N kept is FI0 (after its keep); FI2u with U kept is FI2u (after its keep)', async () => {
    const a = fi0(installFixture())
    await keepWith(a, a.newDir, 'unused-new')
    expect((await opReport(a)).cls).toMatchObject({ kind: 'state', state: 'FI0', postKeep: true })
    expect((await opReport(a)).label).toBe('FI0 not claimed (after its keep)')
    const b = await fi2u(installFixture())
    await keepWith(b, path.join(b.opDir, 'undone'), 'undone')
    expect((await opReport(b)).cls).toMatchObject({ kind: 'state', state: 'FI2u', postKeep: true })
  })

  it('a doctor --apply on FI0 runs end to end', async () => {
    const st = fi0(installFixture())
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'done', installed: 'N', manifest: 'committed' })
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})
