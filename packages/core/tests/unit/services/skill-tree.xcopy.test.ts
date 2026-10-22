/**
 * SMI-6531 (A1 step 3): T-X5, the copy half. A nested change while a skill is
 * copied must not carry a byte from outside the skill into the copy, and the
 * folder's tree hash must differ afterwards so step 4 can see it.
 *
 * Step 4 owns the other half: the update aborts with `changed-since-plan`, no
 * rename happens, and nothing from outside the skill remains in staging after
 * cleanup. This file asserts only what `copyTreeNoFollow` and `treeHashOf` do.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyTreeNoFollow, treeHashOf } from '../../../src/services/skill-tree.js'
import { anyFileContains, lstatBig, tmp, useTmpCleanup } from './skill-tree.helpers.js'

useTmpCleanup()

const SENTINEL = Buffer.from('T-X5-SENTINEL-bytes-from-outside-the-skill-91c4e0')

const hashOrThrow = (p: string): string => {
  const r = treeHashOf(p)
  if (!r.ok) throw new Error(`hash failed: ${r.reason}`)
  return r.hash
}

/** skill/{a.txt, nested/{aa.txt, deeper/leaf.txt, inner.txt}, z.txt} and outside/secret.bin holding SENTINEL. */
function fixture(): { root: string; src: string; dest: string; outside: string } {
  const root = tmp()
  const src = path.join(root, 'skill')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(src, 'nested', 'deeper'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(src, 'a.txt'), 'a')
  fs.writeFileSync(path.join(src, 'nested', 'aa.txt'), 'aa')
  fs.writeFileSync(path.join(src, 'nested', 'inner.txt'), 'inner')
  fs.writeFileSync(path.join(src, 'nested', 'deeper', 'leaf.txt'), 'leaf')
  fs.writeFileSync(path.join(src, 'z.txt'), 'z')
  fs.writeFileSync(path.join(outside, 'secret.bin'), SENTINEL)
  return { root, src, dest: path.join(root, 'dest'), outside }
}

describe('T-X5: a nested change during the copy', () => {
  it('a nested directory replaced by a symlink to outside: no outside byte in the copy, and the hash differs', async () => {
    const f = fixture()
    const pre = hashOrThrow(f.src)
    const r = await copyTreeNoFollow(f.src, f.dest, {
      afterEntry: (rel) => {
        if (rel !== 'a.txt') return
        fs.rmSync(path.join(f.src, 'nested'), { recursive: true })
        fs.symlinkSync(f.outside, path.join(f.src, 'nested'))
      },
    })
    expect(anyFileContains(f.dest, SENTINEL)).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'changed-during-copy' })
    expect(hashOrThrow(f.src)).not.toBe(pre)
  })

  it('the same swap one level down, after the sibling before it was copied', async () => {
    const f = fixture()
    const pre = hashOrThrow(f.src)
    const r = await copyTreeNoFollow(f.src, f.dest, {
      afterEntry: (rel) => {
        if (rel !== 'nested/aa.txt') return
        fs.rmSync(path.join(f.src, 'nested', 'deeper'), { recursive: true })
        fs.symlinkSync(f.outside, path.join(f.src, 'nested', 'deeper'))
      },
    })
    expect(anyFileContains(f.dest, SENTINEL)).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'changed-during-copy' })
    expect(hashOrThrow(f.src)).not.toBe(pre)
  })

  it('a swap before the walk typed the entry is recorded as a symlink, never followed', async () => {
    const f = fixture()
    const pre = hashOrThrow(f.src)
    const r = await copyTreeNoFollow(f.src, f.dest, {
      afterEntry: (rel) => {
        if (rel !== 'nested') return
        fs.rmSync(path.join(f.src, 'nested', 'deeper'), { recursive: true })
        fs.symlinkSync(f.outside, path.join(f.src, 'nested', 'deeper'))
      },
    })
    expect(anyFileContains(f.dest, SENTINEL)).toBe(false)
    expect(r.ok).toBe(true)
    expect(fs.readlinkSync(path.join(f.dest, 'nested', 'deeper'))).toBe(f.outside)
    expect(hashOrThrow(f.src)).not.toBe(pre)
  })

  it('a file edited during the copy: the hash after the copy differs from the hash before', async () => {
    const f = fixture()
    const pre = hashOrThrow(f.src)
    const r = await copyTreeNoFollow(f.src, f.dest, {
      afterEntry: (rel) => {
        if (rel === 'a.txt')
          fs.writeFileSync(path.join(f.src, 'z.txt'), 'z, edited by someone else')
      },
    })
    expect(r.ok).toBe(true)
    expect(hashOrThrow(f.src)).not.toBe(pre)
    // The copy caught the edit or not depending on timing; step 4's hash is what notices.
    expect(anyFileContains(f.dest, SENTINEL)).toBe(false)
  })

  it('a directory swapped for a link AFTER its own checks, between two of its files: the next file is not read from outside', async () => {
    // O_NOFOLLOW guards only the last path component. Once `p` has passed its
    // identity checks and its children are typed, swapping `p` for a link to
    // `outside` would let the next child's open resolve through the link. The
    // opened file must be the inode the walk typed.
    const root = tmp()
    const src = path.join(root, 'skill')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(path.join(src, 'p'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(src, 'p', 'a1.txt'), 'a1')
    fs.writeFileSync(path.join(src, 'p', 'b2.txt'), 'b2')
    fs.writeFileSync(path.join(outside, 'b2.txt'), SENTINEL)
    const dest = path.join(root, 'dest')
    const pre = hashOrThrow(src)
    const r = await copyTreeNoFollow(src, dest, {
      afterEntry: (rel) => {
        if (rel !== 'p/a1.txt') return
        fs.renameSync(path.join(src, 'p'), path.join(root, 'p-aside'))
        fs.symlinkSync(outside, path.join(src, 'p'))
      },
    })
    expect(anyFileContains(dest, SENTINEL)).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'changed-during-copy' })
    expect(hashOrThrow(src)).not.toBe(pre)
  })

  it('a directory swapped for a link after its names are read and before its children are typed: nothing from outside is copied', async () => {
    // Each child's lstat resolves `p` as an intermediate component, so after
    // this swap the children would be typed from `outside`, and copyFile's
    // inode match would then agree with the outside inode. Only the identity
    // check of `p` after the typing stands between this and outside bytes.
    const root = tmp()
    const src = path.join(root, 'skill')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(path.join(src, 'p'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(src, 'p', 'b2.txt'), 'b2')
    fs.writeFileSync(path.join(outside, 'b2.txt'), SENTINEL)
    const dest = path.join(root, 'dest')
    const r = await copyTreeNoFollow(src, dest, {
      afterListed: (rel) => {
        if (rel !== 'p') return
        fs.renameSync(path.join(src, 'p'), path.join(root, 'p-aside'))
        fs.symlinkSync(outside, path.join(src, 'p'))
      },
    })
    expect(anyFileContains(dest, SENTINEL)).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'changed-during-copy', path: path.join(src, 'p') })
  })

  it('the same swap to a link whose target lacks a listed name still reports changed-during-copy, not unreadable', async () => {
    const root = tmp()
    const src = path.join(root, 'skill')
    const outside = path.join(root, 'outside-empty')
    fs.mkdirSync(path.join(src, 'p'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(src, 'p', 'b2.txt'), 'b2')
    const r = await copyTreeNoFollow(src, path.join(root, 'dest'), {
      afterListed: (rel) => {
        if (rel !== 'p') return
        fs.renameSync(path.join(src, 'p'), path.join(root, 'p-aside'))
        fs.symlinkSync(outside, path.join(src, 'p'))
      },
    })
    expect(r).toMatchObject({ ok: false, reason: 'changed-during-copy', path: path.join(src, 'p') })
  })

  it('a parent swapped for a link before a SYMLINK child: the outside link text is not copied', async () => {
    // readlink resolves the parent by path, so after this one swap (never
    // undone) it would read `outside/z-link`. The link must still be the inode
    // the walk typed, as copyFile requires of a file.
    const root = tmp()
    const src = path.join(root, 'skill')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(path.join(src, 'p'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(src, 'p', 'a.txt'), 'a')
    fs.symlinkSync('INSIDE-TEXT', path.join(src, 'p', 'z-link'))
    fs.symlinkSync('/etc/OUTSIDE-TEXT', path.join(outside, 'z-link'))
    const dest = path.join(root, 'dest')
    const r = await copyTreeNoFollow(src, dest, {
      afterEntry: (rel) => {
        if (rel !== 'p/a.txt') return
        fs.renameSync(path.join(src, 'p'), path.join(root, 'p-aside'))
        fs.symlinkSync(outside, path.join(src, 'p'))
      },
    })
    expect(r).toMatchObject({
      ok: false,
      reason: 'changed-during-copy',
      path: path.join(src, 'p', 'z-link'),
    })
    expect(lstatBig(path.join(dest, 'p', 'z-link'))).toBeNull()
  })

  it('control: with no change during the copy the hash is the same afterwards', async () => {
    const f = fixture()
    const pre = hashOrThrow(f.src)
    expect(await copyTreeNoFollow(f.src, f.dest, { afterEntry: () => undefined })).toEqual({
      ok: true,
    })
    expect(hashOrThrow(f.src)).toBe(pre)
  })
})
