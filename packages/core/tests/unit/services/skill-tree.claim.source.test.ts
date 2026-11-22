/**
 * SMI-6531 (A1 step 8-i-a-3a, T-PS unit half, Q-G): `claimPublish` syncs the
 * parent the staged folder was renamed out of, after the destination's
 * parent, and reports it as `syncs.source`. Its own file because it wraps
 * `syncDirectory` for the module: every call is recorded with what was on
 * disk at that moment, then delegated to the real sync (or failed, for one
 * chosen directory).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

interface SyncCall {
  dir: string
  stagedPresent: boolean
  destHasFile: boolean
}

const rec = vi.hoisted(() => ({
  calls: [] as SyncCall[],
  watch: { staged: '', dest: '' },
  failDir: null as string | null,
}))

vi.mock('../../../src/install/dir-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/install/dir-sync.js')>()
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  return {
    ...actual,
    syncDirectory: async (dir: string) => {
      rec.calls.push({
        dir,
        stagedPresent: nodeFs.existsSync(rec.watch.staged),
        destHasFile: nodeFs.existsSync(nodePath.join(rec.watch.dest, 'SKILL.md')),
      })
      if (dir === rec.failDir) {
        return { outcome: 'failed', code: 'EDQUOT', error: new Error('EDQUOT') }
      }
      return actual.syncDirectory(dir)
    },
  }
})

const { claimPublish } = await import('../../../src/services/skill-tree.js')
const { tmp, useTmpCleanup } = await import('./skill-tree.helpers.js')

useTmpCleanup()

/** A staged folder in `root/op/new` and a destination in `root/skills`, parents distinct. */
function layout(): { staged: string; dest: string; op: string; skills: string } {
  const root = tmp()
  const op = path.join(root, 'op')
  const skills = path.join(root, 'skills')
  fs.mkdirSync(op)
  fs.mkdirSync(skills)
  const staged = path.join(op, 'new')
  fs.mkdirSync(staged)
  fs.writeFileSync(path.join(staged, 'SKILL.md'), '# skill\n')
  const dest = path.join(skills, 'my-skill')
  rec.calls = []
  rec.watch = { staged, dest }
  rec.failDir = null
  return { staged, dest, op, skills }
}

describe('claimPublish: the source parent is synced after the rename', () => {
  it('syncs the destination parent twice, then the source parent, after the rename; reports it', async () => {
    const { staged, dest, op, skills } = layout()
    const r = await claimPublish(staged, dest)
    expect(r).toEqual({
      ok: true,
      syncs: {
        claim: { outcome: 'synced' },
        publish: { outcome: 'synced' },
        source: { outcome: 'synced' },
      },
    })
    expect(rec.calls.map((c) => c.dir)).toEqual([skills, skills, op])
    // The claim sync ran before the rename; the publish and source syncs after it.
    expect(rec.calls.map((c) => [c.stagedPresent, c.destHasFile])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ])
  })

  it('a failed source sync is reported, the publish already made (not undone)', async () => {
    const { staged, dest, op } = layout()
    rec.failDir = op
    const r = await claimPublish(staged, dest)
    expect(r).toMatchObject({
      ok: true,
      syncs: { publish: { outcome: 'synced' }, source: { outcome: 'failed', code: 'EDQUOT' } },
    })
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# skill\n')
    expect(fs.existsSync(staged)).toBe(false)
  })
})
