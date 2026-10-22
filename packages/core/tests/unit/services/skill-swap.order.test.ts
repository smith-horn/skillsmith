/**
 * SMI-6531 (A1 step 4a): T-P4 (same-device half) and T-X2 (swap half).
 *
 * T-P4: the traced syscalls contain the plan's sequence in order. The
 * cross-device copy and the park of OP are step 4c's half. `mkdir ST, sync R`
 * belongs to `bindSkillsRoot` (step 2's tests, `skill-write-lock.dirsync`).
 *
 * T-X2: a SIGKILL between the renames leaves the path absent, O and N
 * complete, and a parseable, verifying `record.json`. The rest of T-X2 is
 * later steps': the next `update` refusing `recovery-pending` is the record
 * scan (step 5), and `doctor recovery --apply` / `--undo` are step 6.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TraceOp } from '../../../src/services/skill-swap.js'
import { changedPaths } from '../../../src/services/skill-swap.writeset.js'
import {
  areaOf,
  hashOf,
  isSubsequence,
  makeFixture,
  modify,
  OP_ID,
  plan,
  readRecord,
  recordOf,
  run,
  tmp,
  useTmpCleanup,
} from './skill-swap.helpers.js'

useTmpCleanup()

const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill-swap.child.mjs')

type Want = Partial<TraceOp> & { op: TraceOp['op'] }

describe('T-P4: sync order (one device)', () => {
  it('a committed update traces the plan sequence, with nothing between rename 1 and rename 2 but its syncs', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n', 'a/b.txt': 'b\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result, trace } = await run(p)
    expect(result.status).toBe('committed')

    const OP = fx.opDir
    const ST = fx.staging
    const R = fx.skillsDir
    const O = path.join(OP, 'old')
    const N = path.join(OP, 'new')
    const area = areaOf(fx)
    const dest = path.join(area, OP_ID)
    const rec = path.join(OP, 'record.json')
    const owner = path.join(OP, 'owner.json')
    const want: Want[] = [
      { op: 'mkdir', path: OP },
      { op: 'dirsync', path: ST },
      { op: 'create', path: `${owner}.tmp` },
      { op: 'fsync', path: `${owner}.tmp` },
      { op: 'link', path: `${owner}.tmp`, dest: owner },
      { op: 'unlink', path: `${owner}.tmp` },
      { op: 'dirsync', path: OP },
      { op: 'copy', path: fx.realDir, dest: N },
      { op: 'fsync', path: path.join(N, 'SKILL.md') },
      { op: 'dirsync', path: N },
      { op: 'dirsync', path: OP },
      { op: 'create', path: `${rec}.tmp` },
      { op: 'fsync', path: `${rec}.tmp` },
      { op: 'link', path: `${rec}.tmp`, dest: rec },
      { op: 'unlink', path: `${rec}.tmp` },
      { op: 'dirsync', path: OP },
      { op: 'rename', path: fx.realDir, dest: O },
      { op: 'dirsync', path: OP },
      { op: 'dirsync', path: R },
      { op: 'rename', path: N, dest: fx.realDir },
      { op: 'dirsync', path: R },
      { op: 'dirsync', path: OP },
      { op: 'manifest-write' },
      { op: 'journal-append' },
      { op: 'create', path: `${dest}.json.tmp` },
      { op: 'fsync', path: `${dest}.json.tmp` },
      { op: 'link', path: `${dest}.json.tmp`, dest: `${dest}.json` },
      { op: 'unlink', path: `${dest}.json.tmp` },
      { op: 'dirsync', path: area },
      { op: 'rename', path: O, dest },
      { op: 'dirsync', path: area },
      { op: 'dirsync', path: OP },
      { op: 'unlink', path: rec },
      { op: 'dirsync', path: OP },
      { op: 'unlink', path: owner },
      { op: 'rmdir', path: OP },
      { op: 'dirsync', path: ST },
    ]
    expect(isSubsequence(trace, want)).toEqual({ ok: true })

    // The window the path is absent: rename 1, sync OP, sync R, then rename 2, nothing else.
    const r1 = trace.findIndex((t) => t.op === 'rename' && t.path === fx.realDir)
    expect(trace.slice(r1 + 1, r1 + 4)).toEqual([
      { op: 'dirsync', path: OP },
      { op: 'dirsync', path: R },
      { op: 'rename', path: N, dest: fx.realDir },
    ])
  })

  it('an undo traces aside, sync OP, sync R; claim, sync R; restore, sync R, sync OP', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.failCasOnCall = 2 // step 4's CAS passes, step 10's fails
    const { result, trace } = await run(p)
    expect(result).toMatchObject({
      status: 'undone',
      reason: 'changed-since-plan',
      keptAs: 'undone',
    })

    const OP = fx.opDir
    const R = fx.skillsDir
    const want: Want[] = [
      { op: 'rename', path: fx.realDir, dest: path.join(OP, 'undone') },
      { op: 'dirsync', path: OP },
      { op: 'dirsync', path: R },
      { op: 'mkdir', path: fx.realDir },
      { op: 'dirsync', path: R },
      { op: 'rename', path: path.join(OP, 'old'), dest: fx.realDir },
      { op: 'dirsync', path: R },
      { op: 'dirsync', path: OP },
    ]
    expect(isSubsequence(trace, want)).toEqual({ ok: true })
    // Each move is followed directly by its own syncs, destination parent first.
    const at = (from: string, to: string) =>
      trace.findIndex((t) => t.op === 'rename' && t.path === from && t.dest === to)
    const aside = at(fx.realDir, path.join(OP, 'undone'))
    expect(trace.slice(aside + 1, aside + 3)).toEqual([
      { op: 'dirsync', path: OP },
      { op: 'dirsync', path: R },
    ])
    const restore = at(path.join(OP, 'old'), fx.realDir)
    expect(trace.slice(restore + 1, restore + 3)).toEqual([
      { op: 'dirsync', path: R },
      { op: 'dirsync', path: OP },
    ])
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
  })
})

describe('T-X2: a kill between the renames (swap half)', () => {
  for (const killAt of ['afterRename1', 'afterRename1Syncs'] as const) {
    it(`SIGKILL at ${killAt}: the path is absent, O and N are complete, record.json verifies`, () => {
      const fx = makeFixture({ 'SKILL.md': '# v1\n', 'scripts/run.sh': 'echo 1\n' })
      const preTree = hashOf(fx.realDir)
      const before = recordOf(fx.realDir)
      const cfgPath = path.join(tmp('skill-swap-cfg-'), 'cfg.json')
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          skillsDir: fx.skillsDir,
          stateRoot: fx.stateRoot,
          dirName: fx.dirName,
          opId: OP_ID,
          killAt,
          writeSet: [
            { rel: 'SKILL.md', kind: 'modify', text: '# v2\n' },
            { rel: 'scripts/new.sh', kind: 'create', text: 'echo 2\n' },
          ],
        })
      )

      const child = spawnSync(process.execPath, ['--import', 'tsx', childPath, 'kill', cfgPath], {
        encoding: 'utf8',
      })

      expect(child.signal).toBe('SIGKILL')
      expect(child.stdout).toBe('')
      expect(fs.existsSync(fx.realDir)).toBe(false)
      const rec = readRecord(path.join(fx.opDir, 'record.json'))
      expect(rec.preTree).toBe(preTree)
      expect(hashOf(path.join(fx.opDir, 'old'))).toBe(preTree)
      const n = path.join(fx.opDir, 'new')
      expect(hashOf(n)).toBe(rec.postTree)
      expect(changedPaths(before, recordOf(n))).toEqual(['SKILL.md', 'scripts/new.sh'])
    })
  }
})
