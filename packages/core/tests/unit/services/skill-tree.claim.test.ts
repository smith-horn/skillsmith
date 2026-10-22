/**
 * SMI-6531 (A1 step 3): claim-publish (plan §3.4) and the step-3 half of T-X9.
 *
 * The other half of T-X9 is owned by later steps: that a fresh install REFUSES
 * on `target-exists` (step 8's install caller), and that `doctor` finishes or
 * undoes a claim left by a kill (step 6). This file pins what the primitive
 * itself guarantees: it touches nothing when something exists, and a kill
 * between the claim and the rename leaves the empty claim and an intact stage.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claimPublish, treeHashOf } from '../../../src/services/skill-tree.js'
import { listTree, lstatBig, tmp, useTmpCleanup } from './skill-tree.helpers.js'

useTmpCleanup()

const childPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skill-tree.claim.child.mjs'
)

/** A staged skill folder under `<root>/.skillsmith-staging/op/new`, and the target path. */
function stage(root: string): { staged: string; dest: string } {
  const staged = path.join(root, '.skillsmith-staging', 'op', 'new')
  fs.mkdirSync(path.join(staged, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(staged, 'SKILL.md'), '# new\n')
  fs.writeFileSync(path.join(staged, 'scripts', 'run.sh'), 'echo\n')
  fs.chmodSync(path.join(staged, 'scripts', 'run.sh'), 0o755)
  fs.symlinkSync('SKILL.md', path.join(staged, 'link'))
  return { staged, dest: path.join(root, 'my-skill') }
}

const hashOrThrow = (p: string): string => {
  const r = treeHashOf(p)
  if (!r.ok) throw new Error(`hash failed: ${r.reason}`)
  return r.hash
}

describe('claimPublish', () => {
  it('publishes the staged folder at an absent target, byte for byte', async () => {
    const root = tmp()
    const { staged, dest } = stage(root)
    const before = hashOrThrow(staged)
    const r = await claimPublish(staged, dest)
    expect(r.ok).toBe(true)
    expect(lstatBig(staged)).toBeNull()
    expect(hashOrThrow(dest)).toBe(before)
  })

  it('T-X9 (1): an empty directory at the target is refused and left untouched, staging too', async () => {
    const root = tmp()
    const { staged, dest } = stage(root)
    fs.mkdirSync(dest)
    const claimBefore = lstatBig(dest)
    const stagedHash = hashOrThrow(staged)
    const stagedBefore = lstatBig(staged)

    const r = await claimPublish(staged, dest)

    expect(r).toEqual({ ok: false, reason: 'target-exists' })
    const claimAfter = lstatBig(dest)
    expect(claimAfter?.isDirectory()).toBe(true)
    expect(claimAfter?.ino).toBe(claimBefore?.ino)
    expect(fs.readdirSync(dest)).toEqual([])
    expect(hashOrThrow(staged)).toBe(stagedHash)
    expect(lstatBig(staged)?.ino).toBe(stagedBefore?.ino)
  })

  it('a file or a symlink at the target is refused the same way', async () => {
    const root = tmp()
    const { staged, dest } = stage(root)
    fs.symlinkSync(path.join(root, 'elsewhere'), dest)
    const r = await claimPublish(staged, dest)
    expect(r).toEqual({ ok: false, reason: 'target-exists' })
    expect(fs.readlinkSync(dest)).toBe(path.join(root, 'elsewhere'))
    expect(lstatBig(staged)?.isDirectory()).toBe(true)
  })

  it('a non-empty directory at the target is refused, not replaced', async () => {
    const root = tmp()
    const { staged, dest } = stage(root)
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(dest, 'mine.txt'), 'mine')
    expect(await claimPublish(staged, dest)).toEqual({ ok: false, reason: 'target-exists' })
    expect(listTree(dest)).toEqual(['mine.txt'])
  })

  it('a missing parent is claim-failed and touches nothing', async () => {
    const root = tmp()
    const { staged } = stage(root)
    const r = await claimPublish(staged, path.join(root, 'no', 'parent', 'skill'))
    expect(r).toMatchObject({ ok: false, reason: 'claim-failed', errno: 'ENOENT' })
    expect(lstatBig(path.join(root, 'no'))).toBeNull()
  })

  it('a failed rename leaves the empty claim and the stage, and removes nothing', async () => {
    const root = tmp()
    const { dest } = stage(root)
    const r = await claimPublish(path.join(root, 'no-such-stage'), dest)
    expect(r).toMatchObject({
      ok: false,
      reason: 'rename-failed',
      errno: 'ENOENT',
      claimLeft: true,
    })
    expect(lstatBig(dest)?.isDirectory()).toBe(true)
    expect(fs.readdirSync(dest)).toEqual([])
  })

  it('afterClaim runs after the claim exists and before the rename', async () => {
    const root = tmp()
    const { staged, dest } = stage(root)
    const seen: Record<string, boolean> = {}
    await claimPublish(staged, dest, {
      afterClaim: () => {
        seen.claimIsEmptyDir =
          lstatBig(dest)?.isDirectory() === true && fs.readdirSync(dest).length === 0
        seen.stagedStillThere = lstatBig(staged) !== null
      },
    })
    expect(seen).toEqual({ claimIsEmptyDir: true, stagedStillThere: true })
  })

  it('T-X9 (2): a kill between the claim and the rename leaves the empty claim and an intact stage', () => {
    const root = tmp()
    const { staged, dest } = stage(root)
    const stagedHash = hashOrThrow(staged)

    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', childPath, staged, dest, 'kill'],
      {
        encoding: 'utf8',
      }
    )

    // The hook killed it: a signal, no exit code, and it never reached its output line.
    expect(child.signal).toBe('SIGKILL')
    expect(child.stdout).toBe('')
    // The claim is there and empty; the stage is whole and still at its path.
    expect(lstatBig(dest)?.isDirectory()).toBe(true)
    expect(fs.readdirSync(dest)).toEqual([])
    expect(hashOrThrow(staged)).toBe(stagedHash)
    // Doctor finishing or undoing that claim is step 6's.
  })

  it('control for T-X9 (2): the same child without the kill publishes', () => {
    const root = tmp()
    const { staged, dest } = stage(root)
    const stagedHash = hashOrThrow(staged)
    const child = spawnSync(process.execPath, ['--import', 'tsx', childPath, staged, dest, 'run'], {
      encoding: 'utf8',
    })
    expect(child.status).toBe(0)
    expect(lstatBig(staged)).toBeNull()
    expect(hashOrThrow(dest)).toBe(stagedHash)
  })
})
