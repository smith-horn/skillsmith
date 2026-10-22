/**
 * SMI-6531 (A1 step 3): `claimPublish` when the parent sync after the claim
 * fails. The claim stays, no rename is attempted, and the staged folder is
 * untouched. Its own file because it stubs `syncDirectory` for the module.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/install/dir-sync.js', () => ({
  // An uncommon code, so a hard-coded errno in claimPublish cannot pass for propagation.
  syncDirectory: vi.fn(async () => ({
    outcome: 'failed',
    code: 'EDQUOT',
    error: new Error('EDQUOT'),
  })),
}))

const { claimPublish } = await import('../../../src/services/skill-tree.js')
const { listTree, tmp, useTmpCleanup } = await import('./skill-tree.helpers.js')

useTmpCleanup()

describe('claimPublish: the claim sync fails', () => {
  it('returns sync-failed with claimLeft, leaves the empty claim, and never renames', async () => {
    const root = tmp()
    const staged = path.join(root, 'staged')
    fs.mkdirSync(staged)
    fs.writeFileSync(path.join(staged, 'SKILL.md'), '# skill\n')
    const dest = path.join(root, 'dest')

    const r = await claimPublish(staged, dest)

    expect(r).toEqual({ ok: false, reason: 'sync-failed', errno: 'EDQUOT', claimLeft: true })
    expect(fs.lstatSync(dest).isDirectory()).toBe(true)
    expect(listTree(dest)).toEqual([])
    expect(listTree(staged)).toEqual(['SKILL.md'])
  })
})
