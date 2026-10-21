/**
 * SMI-6531 (A1 step 3): T-H1, one tree-hash function (plan §3.4, ADR-166).
 *
 * `treeHashOf` (standing in for `postTree`), the sidecar `treeHash` written by
 * a real `parkTreeIndexed` call, and the park's own recomputation must agree
 * on one tree; a guarded park with a `guardHash` from `treeHashOf` ends
 * `parked`. The control is a second hash implementation that differs in one
 * field (mode as octal text); its `guardHash` makes the same park end
 * `kept/identity-changed`.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTreeIndexed } from '../../../src/install/park-call.js'
import { pathTreeRecord } from '../../../src/install/park-tree.verify.js'
import type { TreeRecord, TreeRecordEntry } from '../../../src/install/tree-hash.js'
import { copyTreeNoFollow, treeHashOf } from '../../../src/services/skill-tree.js'
import { tmp, useTmpCleanup } from './skill-tree.helpers.js'

useTmpCleanup()

const OPTS = { client: 'test-client', caller: 'uninstall', kind: 'uninstall' } as const

function buildTree(): { parent: string; origin: string } {
  const parent = path.join(tmp(), 'parent')
  const origin = path.join(parent, 'skill')
  fs.mkdirSync(path.join(origin, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(origin, 'SKILL.md'), '# skill\n')
  fs.writeFileSync(path.join(origin, 'scripts', 'run.sh'), 'echo hi\n')
  fs.chmodSync(path.join(origin, 'scripts', 'run.sh'), 0o755)
  fs.symlinkSync('SKILL.md', path.join(origin, 'link'))
  return { parent, origin }
}

/** The spike's serialisation with ONE field changed: mode as octal text, not decimal. */
function octalModeHash(record: TreeRecord): string {
  const hash = crypto.createHash('sha256')
  for (const rel of [...record.keys()].sort()) {
    const e = record.get(rel) as TreeRecordEntry
    const content = e.type === 'file' ? e.contentHash : e.type === 'symlink' ? e.linkText : ''
    hash.update(`${rel}\u0000${e.type}\u0000${e.mode.toString(8)}\u0000${e.size}\u0000${content}\n`)
  }
  return hash.digest('hex')
}

const hashOrThrow = (p: string): string => {
  const r = treeHashOf(p)
  if (!r.ok) throw new Error(`hash failed: ${r.reason}`)
  return r.hash
}

describe('T-H1: one tree-hash function', () => {
  it('treeHashOf, the sidecar treeHash and the park recomputation agree, and the guarded park ends parked', async () => {
    const { parent, origin } = buildTree()
    const postTree = hashOrThrow(origin)

    const r = await parkTreeIndexed(parent, 'skill', { ...OPTS, guardHash: postTree })

    expect(r.status).toBe('parked')
    const sidecar = JSON.parse(fs.readFileSync(String(r.sidecarPath), 'utf8')) as {
      treeHash: string
    }
    expect(sidecar.treeHash).toBe(postTree)
    // The park's own recomputation, taken at the destination after the move.
    expect(r.treeHash).toBe(postTree)
    // And treeHashOf over the parked copy: the hash is root-relative, so it did not move with the tree.
    expect(hashOrThrow(String(r.path))).toBe(postTree)
  })

  it('control: a hash that differs in one field (octal mode) makes the park end kept/identity-changed', async () => {
    const { parent, origin } = buildTree()
    const walked = pathTreeRecord(origin)
    if (!walked.ok) throw new Error('walk failed')
    const foreign = octalModeHash(walked.record)
    expect(foreign).not.toBe(hashOrThrow(origin))

    const r = await parkTreeIndexed(parent, 'skill', { ...OPTS, guardHash: foreign })

    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-changed')
    expect(fs.readFileSync(path.join(origin, 'SKILL.md'), 'utf8')).toBe('# skill\n')
  })

  it("a directory's lstat size is not hashed: a churned directory and its faithful copy hash the same", async () => {
    // On ext4-like filesystems a directory that once held many entries keeps a
    // larger lstat size than a fresh one with the same contents (measured on
    // overlayfs: 69632 vs 4096). APFS reports both the same, so this test only
    // discriminates on Linux; the precondition below says which ran.
    const root = tmp()
    const src = path.join(root, 'skill')
    fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
    for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(src, 'scripts', `f${i}`), 'x')
    for (let i = 0; i < 3000; i++) fs.unlinkSync(path.join(src, 'scripts', `f${i}`))
    fs.writeFileSync(path.join(src, 'scripts', 'run.sh'), 'echo hi\n')
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# skill\n')
    const dest = path.join(root, 'copy')
    expect(await copyTreeNoFollow(src, dest)).toEqual({ ok: true })

    const srcSize = fs.lstatSync(path.join(src, 'scripts')).size
    const copySize = fs.lstatSync(path.join(dest, 'scripts')).size
    if (process.platform === 'linux') expect(srcSize).not.toBe(copySize)

    expect(hashOrThrow(dest)).toBe(hashOrThrow(src))
    // A file's size still counts: the same edit with one more byte changes the hash.
    fs.writeFileSync(path.join(dest, 'SKILL.md'), '# skill\n\n')
    expect(hashOrThrow(dest)).not.toBe(hashOrThrow(src))
  })
})
