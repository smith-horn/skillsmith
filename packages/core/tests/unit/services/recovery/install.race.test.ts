/**
 * SMI-6531 (A1 step 8-i-a-2), design review round 1 Major 1: `installAt`
 * re-checks the tree it publishes (identity and the hash the plan observed)
 * immediately before each publishing rename, on both paths: claim-publish
 * (`beforeRename`, after the claim's `mkdir` and sync) and the rename over an
 * existing empty claim. For FI0 and FI1 and for every update row that calls
 * `installAt` (S1 `--apply` and `--undo`, UN1, S2 `--undo`), a tree edited, or
 * replaced by a copy, after the claim exists is refused: nothing is
 * published, the tree stays in the op dir, the record is kept.
 *
 * The race is planted in the `afterClaim` test hook, which runs after the
 * claim exists and before the re-check.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RecoveryRunOptions } from '../../../../src/services/skill-recovery.run.types.js'
import { makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { s1, s2, un1 } from './recovery.helpers.js'
import { act } from './recovery.act.helpers.js'
import { fi0, fi1, installFixture } from './install.helpers.js'

useTmpCleanup()

type Race = 'edit' | 'replace'

/** Options whose `afterClaim` edits `src`, or swaps it for a copy (same content, another folder). */
function raceOn(src: string, race: Race, outside: string): RecoveryRunOptions {
  return {
    swap: {
      hooks: {
        afterClaim: () => {
          if (race === 'edit') {
            fs.writeFileSync(path.join(src, 'SKILL.md'), '# raced\n')
          } else {
            const away = path.join(outside, 'raced-away')
            fs.renameSync(src, away)
            fs.cpSync(away, src, { recursive: true })
          }
        },
      },
    },
  }
}

interface Case {
  name: string
  build: () => Promise<{ fx: Fixture; opId: string; opDir: string }>
  action: 'apply' | 'undo'
  /** The tree `installAt` publishes, under OP. */
  role: 'new' | 'old'
  /** The skill path holds a claim before the action (the existing-claim path). */
  claimed: boolean
}

const update = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

const CASES: Case[] = [
  {
    name: 'FI0 --apply',
    build: async () => fi0(installFixture()),
    action: 'apply',
    role: 'new',
    claimed: false,
  },
  {
    name: 'FI1 --apply',
    build: () => fi1(installFixture()),
    action: 'apply',
    role: 'new',
    claimed: true,
  },
  { name: 'S1 --apply', build: () => s1(update()), action: 'apply', role: 'new', claimed: false },
  {
    name: 'S1 --apply over an existing claim',
    build: async () => {
      const st = await s1(update())
      fs.mkdirSync(st.fx.realDir)
      return st
    },
    action: 'apply',
    role: 'new',
    claimed: true,
  },
  { name: 'S1 --undo', build: () => s1(update()), action: 'undo', role: 'old', claimed: false },
  { name: 'UN1 --apply', build: () => un1(update()), action: 'apply', role: 'old', claimed: false },
  { name: 'S2 --undo', build: () => s2(update()), action: 'undo', role: 'old', claimed: false },
]

describe('Major 1: the published tree is re-checked immediately before its rename', () => {
  for (const c of CASES) {
    for (const race of ['edit', 'replace'] as const) {
      it(`${c.name}, ${race} after the claim: refused, nothing published, the record kept`, async () => {
        const st = await c.build()
        const src = path.join(st.opDir, c.role)
        // Which `installAt` path this case drives: over an existing claim, or claim-publish
        // (S2's undo sets its folder aside first, so the skill path is free by the claim).
        expect(fs.existsSync(st.fx.realDir) && fs.readdirSync(st.fx.realDir).length === 0).toBe(
          c.claimed
        )
        const a = await act(st, c.action, {}, raceOn(src, race, st.fx.outside))
        expect(a.result).toMatchObject({
          status: 'stopped',
          reason: 'staging-unsafe',
          detail: expect.stringContaining('nothing was published'),
        })
        // The skill path is the empty claim, not the tree; the tree is still in OP.
        expect(fs.readdirSync(st.fx.realDir)).toEqual([])
        expect(fs.existsSync(path.join(src, 'SKILL.md'))).toBe(true)
        expect(a.trace.some((t) => t.op === 'rename' && t.path === src)).toBe(false)
        expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
      })
    }
  }

  // The existing-claim path also re-checks the claim itself just before the rename
  // (gate on bf928bc3c: the races above change only the source).
  for (const c of CASES.filter((x) => x.claimed)) {
    for (const race of ['swap', 'fill'] as const) {
      it(`${c.name}, claim ${race === 'swap' ? 'swapped' : 'filled'} after the hook: target-changed, nothing published`, async () => {
        const st = await c.build()
        const src = path.join(st.opDir, c.role)
        const t = st.fx.realDir
        // swap: the planned claim moved aside (so its inode stays in use) and a new
        // empty folder in its place; fill: a file written into the planned claim.
        const a = await act(
          st,
          c.action,
          {},
          {
            swap: {
              hooks: {
                afterClaim: () => {
                  if (race === 'swap') {
                    fs.renameSync(t, path.join(st.fx.outside, 'claim-away'))
                    fs.mkdirSync(t)
                  } else {
                    fs.writeFileSync(path.join(t, 'planted.txt'), 'x')
                  }
                },
              },
            },
          }
        )
        expect(a.result).toMatchObject({ status: 'stopped', reason: 'target-changed' })
        // What the race left at the skill path is untouched; the tree is still in OP.
        expect(fs.readdirSync(t)).toEqual(race === 'swap' ? [] : ['planted.txt'])
        expect(fs.existsSync(path.join(src, 'SKILL.md'))).toBe(true)
        expect(a.trace.some((x) => x.op === 'rename' && x.path === src)).toBe(false)
        expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
      })
    }
  }

  it('control: the same actions with a hook that changes nothing publish the tree', async () => {
    for (const c of CASES) {
      const st = await c.build()
      const src = path.join(st.opDir, c.role)
      const a = await act(st, c.action, {}, { swap: { hooks: { afterClaim: () => undefined } } })
      expect(a.result.status, c.name).toBe('done')
      expect(
        a.trace.some((t) => t.op === 'rename' && t.path === src && t.dest === st.fx.realDir),
        c.name
      ).toBe(true)
    }
  })
})
