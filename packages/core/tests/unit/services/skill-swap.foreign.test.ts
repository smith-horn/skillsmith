/**
 * SMI-6531 (A1 step 4a): foreign writes at each window. T-X5 (step-4 half),
 * T-X6, T-X10, T-X11.
 *
 * T-X5's "no byte from outside the skill is in staging after cleanup" is the
 * abort cleanup's assertion (step 4b); here staging is left as it is and only
 * checked not to hold outside bytes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceOp } from '../../../src/services/skill-swap.js'
import { anyFileContains } from './skill-tree.helpers.js'
import {
  areaOf,
  hashOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  snapshot,
  useTmpCleanup,
} from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'z.txt': 'z\n', 'scripts/run.sh': 'echo\n' }
const renamedLive = (trace: TraceOp[], realDir: string): TraceOp[] =>
  trace.filter((t) => t.op === 'rename' && t.path === realDir)

describe('T-X5 (step-4 half): a change while staging is caught before any rename', () => {
  it('(a) a live file edited after the copy: step 4 refuses changed-since-plan', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result, trace } = await run(p, {
      hooks: { afterCopy: () => fs.appendFileSync(path.join(fx.realDir, 'a.txt'), 'edit\n') },
    })
    expect(result).toMatchObject({
      status: 'refused',
      reason: 'changed-since-plan',
      staged: 'left',
    })
    expect(renamedLive(trace, fx.realDir)).toEqual([])
    expect(fs.readFileSync(path.join(fx.realDir, 'a.txt'), 'utf8')).toBe('a\nedit\n')
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v1\n')
    expect(p.manifest.writes).toBe(0)
  })

  it('(b) a nested live dir replaced by a symlink to outside after the copy: same, nothing from outside staged', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const outsideBefore = snapshot(fx.outside)
    const { result, trace } = await run(p, {
      hooks: {
        afterCopy: () => {
          fs.renameSync(path.join(fx.realDir, 'scripts'), path.join(fx.base, 'scripts-aside'))
          fs.symlinkSync(fx.outside, path.join(fx.realDir, 'scripts'))
        },
      },
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'changed-since-plan' })
    expect(renamedLive(trace, fx.realDir)).toEqual([])
    expect(snapshot(fx.outside)).toEqual(outsideBefore)
    expect(anyFileContains(fx.staging, Buffer.from('outside bytes'))).toBe(false)
  })

  it('(c) a not-yet-copied live file edited during the copy (and restored after it): the copy-hash check refuses', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const z = path.join(fx.realDir, 'z.txt')
    let edited = false
    let restored: string | null = null
    const { result, trace } = await run(p, {
      duringCopy: (rel) => {
        if (rel === 'a.txt' && !edited) {
          edited = true
          fs.writeFileSync(z, 'z changed mid-copy\n')
        }
      },
      // Restored, so step 4's re-hash of the live folder would pass on its own.
      hooks: {
        afterCopy: () => {
          fs.writeFileSync(z, 'z\n')
          restored = hashOf(fx.realDir)
        },
      },
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'changed-since-plan' })
    expect(edited).toBe(true)
    expect(restored).toBe(p.input.preTree)
    expect(renamedLive(trace, fx.realDir)).toEqual([])
    expect(p.manifest.casCalls).toBe(0) // refused in step 1, before step 4 ran
  })
})

describe('T-X6: a foreign edit before rename 1 is kept in the backup', () => {
  it('the edit is in the backup, backup-holds-foreign-change names it, and the update commits', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p, {
      hooks: { beforeRename1: () => fs.appendFileSync(path.join(fx.realDir, 'a.txt'), 'late\n') },
    })
    expect(result.status).toBe('committed')
    if (result.status !== 'committed') throw new Error('unreachable')
    expect(fs.readFileSync(path.join(result.backupDest, 'a.txt'), 'utf8')).toBe('a\nlate\n')
    expect(result.warnings).toEqual([
      { code: 'backup-holds-foreign-change', backup: result.backupDest },
    ])
  })
})

describe('T-X10: a foreign edit after rename 2 is kept and reported', () => {
  for (const point of ['afterRename2', 'beforeCommitRehash'] as const) {
    it(`at ${point}: committed, live-folder-changed names the file, the edit stays live`, async () => {
      const fx = makeFixture(FILES)
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const { result } = await run(p, {
        hooks: { [point]: () => fs.appendFileSync(path.join(fx.realDir, 'a.txt'), 'live\n') },
      })
      expect(result.status).toBe('committed')
      if (result.status !== 'committed') throw new Error('unreachable')
      expect(result.warnings).toEqual([{ code: 'live-folder-changed', paths: ['a.txt'] }])
      expect(fs.readFileSync(path.join(fx.realDir, 'a.txt'), 'utf8')).toBe('a\nlive\n')
    })
  }
})

describe('T-X11: an undo never deletes a changed tree', () => {
  it('(a) live edit after rename 2 + manifest changed before commit: undone, the edit is in <opId>.conflict', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p, {
      hooks: {
        afterRename2: () => {
          fs.appendFileSync(path.join(fx.realDir, 'a.txt'), 'kept edit\n')
          p.manifest.entry = { version: '1.0.0', pinnedVersion: 'someone else' }
        },
      },
    })
    const conflict = path.join(areaOf(fx), `${OP_ID}.conflict`)
    expect(result).toMatchObject({
      status: 'undone',
      reason: 'changed-since-plan',
      keptAs: 'conflict',
      keptPath: conflict,
      warnings: [{ code: 'conflict-kept', path: conflict }],
    })
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
    expect(fs.readFileSync(path.join(conflict, 'a.txt'), 'utf8')).toBe('a\nkept edit\n')
    expect(JSON.parse(fs.readFileSync(`${conflict}.json`, 'utf8'))).toMatchObject({
      opId: OP_ID,
      kind: 'conflict',
      treeHash: hashOf(conflict),
    })
    expect(p.manifest.writes).toBe(0)
  })

  it('(b) a write through a file opened before the undo lands in the conflict copy', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.failCasOnCall = 2
    let fd: number | null = null
    const { result } = await run(p, {
      hooks: {
        beforeUndoAside: () => {
          fd = fs.openSync(path.join(fx.realDir, 'a.txt'), 'a')
        },
        afterUndoAside: () => {
          fs.writeSync(fd!, 'through the fd\n')
          fs.closeSync(fd!)
        },
      },
    })
    const conflict = path.join(areaOf(fx), `${OP_ID}.conflict`)
    expect(result).toMatchObject({
      status: 'undone',
      reason: 'changed-since-plan',
      keptAs: 'conflict',
    })
    expect(fs.readFileSync(path.join(conflict, 'a.txt'), 'utf8')).toBe('a\nthrough the fd\n')
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
  })
})
