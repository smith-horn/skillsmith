/**
 * SMI-6531 (A1 step 4c): Q2's control. A port that skips the comparison of the
 * copy temp with its source (the temp "verifies" whatever the source holds)
 * parks OP with `dest` missing a file edited in the source after the copy, so
 * the Q2 edit-hook assertion (`dest` holds the edit) fails against it. The
 * skip is made by having the tree hash of the copy temp report the source's
 * hash, here only; every other hash is the real one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ALL_DELETES, contentOf, runSpied } from './skill-swap.abort.helpers.js'
import { areaOf, modify, OP_ID, plan, useTmpCleanup } from './skill-swap.helpers.js'
import {
  parkedCopies,
  partials,
  useOtherDeviceCleanup,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

const ctl = vi.hoisted(() => ({ src: null as string | null }))

vi.mock('../../../src/services/skill-tree.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/skill-tree.js')>()
  return {
    ...real,
    treeHashOf: (p: string) =>
      ctl.src !== null && path.basename(p).startsWith('.tmp-')
        ? real.treeHashOf(ctl.src)
        : real.treeHashOf(p),
  }
})

useTmpCleanup()
useOtherDeviceCleanup()

describe('Q2 control: a port that skips the comparison', () => {
  it('parks OP with dest missing the edit made after the copy (the Q2 assertion fails)', async () => {
    const fx = xdevFixture({ 'SKILL.md': '# v1\n', 'a.txt': 'a\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    ctl.src = path.join(fx.opDir, 'old')
    try {
      const run = await runSpied(p, ALL_DELETES, {
        hooks: {
          afterBackupCopy: () => fs.appendFileSync(path.join(ctl.src!, 'a.txt'), 'edited\n'),
        },
      })
      expect(run.result.status).toBe('committed')
      const dest = path.join(areaOf(fx), OP_ID)
      // The Q2 assertion is `contentOf(dest)['a.txt'] === 'a\nedited\n'`: it fails here.
      expect(contentOf(dest)['a.txt']).toBe('a\n')
      expect(partials(areaOf(fx))).toEqual([])
      const copies = parkedCopies(fx)
      expect(copies).toHaveLength(1)
      expect(fs.readFileSync(path.join(copies[0]!, 'old', 'a.txt'), 'utf8')).toBe('a\nedited\n')
    } finally {
      ctl.src = null
    }
  })
})
