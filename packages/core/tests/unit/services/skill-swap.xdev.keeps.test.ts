/**
 * SMI-6531 (A1 step 4c): the other `publishTree` callers across devices.
 * `publishTree` is the single keep path, so its cross-device copy also runs
 * for abort cleanup's keeps (`edited-new`, `failed-build`) and the undo's
 * (`undone`). Each leaves its verified source in OP, so OP is parked whole
 * (A1 plan §3.3 abort cleanup step 6: "If OP still holds a tree (the
 * unchanged N, or a kept tree's cross-device source)"; step 13 for the undo),
 * with nothing deleted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindIdentity } from '../../../src/install/park-tree.identity.js'
import { isParkIntentFor } from '../../../src/services/skill-swap.intent.js'
import { recordIdentity } from '../../../src/services/skill-swap.staging.js'
import { ALL_DELETES, contentOf, refusedOf, runSpied } from './skill-swap.abort.helpers.js'
import { abortAt } from './skill-swap.abort.triggers.js'
import { areaOf, hashOf, modify, OP_ID, plan, useTmpCleanup } from './skill-swap.helpers.js'
import {
  parkedCopies,
  sidecarOf,
  treeDeletesX,
  useOtherDeviceCleanup,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }

/** The one parked copy holds `tree` and a verifying intent of `kind`. */
function parkedWith(copy: string, tree: string, kind: string): void {
  expect(fs.readdirSync(copy).sort()).toEqual([tree, 'park-intent.json'].sort())
  const intent = JSON.parse(fs.readFileSync(path.join(copy, 'park-intent.json'), 'utf8'))
  const id = bindIdentity(copy)
  expect(id.ok && isParkIntentFor(intent, OP_ID, recordIdentity(id))).toBe(true)
  expect(intent.kind).toBe(kind)
}

describe('abort cleanup across devices: a kept N is copied, and OP parked with its source', () => {
  it('edited-new: the kept copy and the parked source both hold the edit; staged parked with keptAs', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const N = path.join(fx.opDir, 'new')
    const t = abortAt(fx, 'step4', {
      afterBuild: () => fs.appendFileSync(path.join(N, 'a.txt'), 'edited in N\n'),
    })
    try {
      const run = await runSpied(p, ALL_DELETES, t.options)
      const r = refusedOf(run.result)
      const kept = path.join(areaOf(fx), `${OP_ID}.edited-new`)
      const copies = parkedCopies(fx)
      expect(copies).toHaveLength(1)
      expect(r).toMatchObject({
        reason: 'changed-since-plan',
        staged: 'parked',
        parkedPath: copies[0],
        keptAs: { kind: 'edited-new', path: kept },
      })
      expect(r.warnings.filter((w) => w.code === 'removal-not-done')).toEqual([])
      parkedWith(copies[0]!, 'new', 'abort-new')
      expect(contentOf(kept)).toEqual(contentOf(path.join(copies[0]!, 'new')))
      expect(contentOf(kept)['a.txt']).toBe('a\nedited in N\n')
      expect(sidecarOf(kept)).toMatchObject({ kind: 'edited-new', treeHash: hashOf(kept) })
      expect(fs.existsSync(fx.opDir)).toBe(false)
      expect(treeDeletesX(fx, run.events)).toEqual([])
    } finally {
      t.restore()
    }
  })

  it('failed-build: the partial build is copied and kept, and OP parked with it', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const run = await runSpied(p, ALL_DELETES, {
      hooks: {
        afterCopy: () => {
          throw new Error('forced build failure')
        },
      },
    })
    const r = refusedOf(run.result)
    const kept = path.join(areaOf(fx), `${OP_ID}.failed-build`)
    const copies = parkedCopies(fx)
    expect(copies).toHaveLength(1)
    expect(r).toMatchObject({
      staged: 'parked',
      parkedPath: copies[0],
      keptAs: { kind: 'failed-build', path: kept },
    })
    parkedWith(copies[0]!, 'new', 'abort-new')
    expect(contentOf(kept)).toEqual(contentOf(path.join(copies[0]!, 'new')))
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})

describe('the undo across devices: the undone tree is copied, and OP parked with its source', () => {
  it('undone with keptPath the verified copy and extraCopy the parked op dir; the old folder back', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.failCasOnCall = 2
    const lines: string[] = []
    const run = await runSpied(p, ALL_DELETES, { stderr: (l) => lines.push(l) })
    expect(run.result.status).toBe('undone')
    if (run.result.status !== 'undone') return
    const r = run.result
    const kept = path.join(areaOf(fx), `${OP_ID}.undone`)
    const copies = parkedCopies(fx)
    expect(copies).toHaveLength(1)
    expect(r).toMatchObject({ keptAs: 'undone', keptPath: kept, extraCopy: copies[0] })
    parkedWith(copies[0]!, 'undone', 'move-source')
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
    expect(contentOf(kept)).toEqual(contentOf(path.join(copies[0]!, 'undone')))
    expect(fs.existsSync(fx.opDir)).toBe(false)
    expect(lines).toEqual([
      `Undo complete: kept copy at ${kept}; an extra copy of the undone folder was moved aside at ${copies[0]}.`,
    ])
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})
