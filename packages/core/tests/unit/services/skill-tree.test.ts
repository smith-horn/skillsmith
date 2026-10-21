/**
 * SMI-6531 (A1 step 3): `treeHashOf` and `copyTreeNoFollow` (plan §3.4).
 * Covers T-B2 (unsupported entry), copy fidelity, and the lstat-to-open race.
 * T-X5, T-X9 and T-H1 have their own files.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyTreeNoFollow, treeHashOf } from '../../../src/services/skill-tree.js'
import { anyFileContains, listTree, lstatBig, tmp, useTmpCleanup } from './skill-tree.helpers.js'

useTmpCleanup()

const SENTINEL = Buffer.from('SENTINEL-OUTSIDE-BYTES-7f3a91c2')

/** A skill folder with every entry kind the copy must preserve. */
function buildSkill(root: string): string {
  const src = path.join(root, 'skill')
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(src, 'sub', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(src, 'empty'))
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# skill\n')
  fs.writeFileSync(path.join(src, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
  fs.writeFileSync(path.join(src, 'data.txt'), 'data')
  fs.writeFileSync(path.join(src, 'sub', 'deep', 'n.txt'), 'nested')
  fs.chmodSync(path.join(src, 'scripts', 'run.sh'), 0o755)
  fs.chmodSync(path.join(src, 'data.txt'), 0o640)
  fs.chmodSync(path.join(src, 'sub'), 0o750)
  fs.symlinkSync('SKILL.md', path.join(src, 'rel-link'))
  fs.symlinkSync('does-not-exist', path.join(src, 'dangling'))
  fs.symlinkSync('../outside', path.join(src, 'up-link'))
  return src
}

const modeOf = (p: string): number => Number(lstatBig(p)?.mode) & 0o7777

describe('treeHashOf', () => {
  it('returns the hash and the record it came from, and is stable', () => {
    const src = buildSkill(tmp())
    const a = treeHashOf(src)
    const b = treeHashOf(src)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(b.hash).toBe(a.hash)
      expect(a.record.get('scripts/run.sh')?.type).toBe('file')
      expect(a.record.get('dangling')).toMatchObject({
        type: 'symlink',
        linkText: 'does-not-exist',
      })
    }
  })

  it('a changed byte, mode or link text changes the hash', () => {
    const src = buildSkill(tmp())
    const base = treeHashOf(src)
    const hashAfter = (mutate: () => void): string => {
      mutate()
      const r = treeHashOf(src)
      if (!r.ok) throw new Error('hash failed')
      return r.hash
    }
    if (!base.ok) throw new Error('hash failed')
    const h1 = hashAfter(() => fs.writeFileSync(path.join(src, 'data.txt'), 'dat!'))
    const h2 = hashAfter(() => fs.chmodSync(path.join(src, 'data.txt'), 0o600))
    const h3 = hashAfter(() => {
      fs.rmSync(path.join(src, 'rel-link'))
      fs.symlinkSync('data.txt', path.join(src, 'rel-link'))
    })
    expect(new Set([base.hash, h1, h2, h3]).size).toBe(4)
  })
})

describe('T-B2: an unsupported entry is refused at planning, with nothing written', () => {
  const withFifo = (root: string, rel: string): { src: string; fifo: string } => {
    const src = buildSkill(root)
    const fifo = path.join(src, rel)
    fs.mkdirSync(path.dirname(fifo), { recursive: true })
    execFileSync('mkfifo', [fifo])
    return { src, fifo }
  }

  it('treeHashOf names the FIFO as unsupported-entry and writes nothing', () => {
    const root = tmp()
    const { src, fifo } = withFifo(root, 'pipe')
    const before = listTree(src)
    const rootBefore = fs.readdirSync(root).sort()
    const r = treeHashOf(src)
    expect(r).toMatchObject({ ok: false, reason: 'unsupported-entry', path: fifo })
    expect(listTree(src)).toEqual(before)
    expect(fs.readdirSync(root).sort()).toEqual(rootBefore)
  })

  it('a FIFO nested in a subdirectory is found too', () => {
    const { src, fifo } = withFifo(tmp(), 'sub/deep/pipe')
    expect(treeHashOf(src)).toMatchObject({ ok: false, reason: 'unsupported-entry', path: fifo })
  })

  it('copyTreeNoFollow returns unsupported-entry and writes nothing for that entry', async () => {
    const root = tmp()
    const { src, fifo } = withFifo(root, 'pipe')
    const dest = path.join(root, 'dest')
    const r = await copyTreeNoFollow(src, dest)
    expect(r).toMatchObject({ ok: false, reason: 'unsupported-entry', path: fifo })
    expect(listTree(dest)).not.toContain('pipe')
    expect(lstatBig(path.join(dest, 'pipe'))).toBeNull()
  })

  it('a non-directory root is refused as unsupported-entry before dest is created', async () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'file'), 'x')
    const dest = path.join(root, 'dest')
    const r = await copyTreeNoFollow(path.join(root, 'file'), dest)
    expect(r).toMatchObject({ ok: false, reason: 'unsupported-entry' })
    expect(lstatBig(dest)).toBeNull()
  })
})

describe('copyTreeNoFollow fidelity', () => {
  it('copies nested directories, an empty directory, bytes and modes', async () => {
    const root = tmp()
    const src = buildSkill(root)
    const dest = path.join(root, 'dest')
    expect(await copyTreeNoFollow(src, dest)).toEqual({ ok: true })
    expect(listTree(dest)).toEqual(listTree(src))
    expect(fs.readFileSync(path.join(dest, 'sub', 'deep', 'n.txt'), 'utf8')).toBe('nested')
    expect(fs.readdirSync(path.join(dest, 'empty'))).toEqual([])
    expect(modeOf(path.join(dest, 'data.txt'))).toBe(0o640)
    expect(modeOf(path.join(dest, 'scripts', 'run.sh'))).toBe(0o755)
    expect(modeOf(path.join(dest, 'sub'))).toBe(0o750)
  })

  it('recreates symlinks verbatim, dangling and outward ones included, never reading through', async () => {
    const root = tmp()
    const src = buildSkill(root)
    fs.mkdirSync(path.join(root, 'outside'))
    fs.writeFileSync(path.join(root, 'outside', 'secret'), SENTINEL)
    const dest = path.join(root, 'dest')
    expect(await copyTreeNoFollow(src, dest)).toEqual({ ok: true })
    expect(fs.readlinkSync(path.join(dest, 'rel-link'))).toBe('SKILL.md')
    expect(fs.readlinkSync(path.join(dest, 'dangling'))).toBe('does-not-exist')
    expect(fs.readlinkSync(path.join(dest, 'up-link'))).toBe('../outside')
    expect(fs.lstatSync(path.join(dest, 'up-link')).isSymbolicLink()).toBe(true)
    expect(anyFileContains(dest, SENTINEL)).toBe(false)
  })

  it('the copy hashes as the source does', async () => {
    const root = tmp()
    const src = buildSkill(root)
    const dest = path.join(root, 'dest')
    await copyTreeNoFollow(src, dest)
    const a = treeHashOf(src)
    const b = treeHashOf(dest)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(b.hash).toBe(a.hash)
  })

  it('refuses a destination that already exists and writes nothing', async () => {
    const root = tmp()
    const src = buildSkill(root)
    const dest = path.join(root, 'dest')
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(dest, 'keep'), 'mine')
    const before = lstatBig(dest)
    const r = await copyTreeNoFollow(src, dest)
    expect(r).toMatchObject({ ok: false, reason: 'dest-exists', path: dest, errno: 'EEXIST' })
    expect(listTree(dest)).toEqual(['keep'])
    expect(lstatBig(dest)?.ino).toBe(before?.ino)
  })

  it('a missing destination parent is write-failed, not a recursive mkdir', async () => {
    const root = tmp()
    const src = buildSkill(root)
    const dest = path.join(root, 'no', 'parent', 'dest')
    const r = await copyTreeNoFollow(src, dest)
    expect(r).toMatchObject({ ok: false, reason: 'write-failed', errno: 'ENOENT' })
    expect(lstatBig(path.join(root, 'no'))).toBeNull()
  })

  it('an unreadable source file stops with unreadable and removes nothing it wrote', async () => {
    if (process.getuid?.() === 0) return // root reads through mode 000
    const root = tmp()
    const src = buildSkill(root)
    fs.chmodSync(path.join(src, 'data.txt'), 0o000)
    const dest = path.join(root, 'dest')
    const r = await copyTreeNoFollow(src, dest)
    expect(r).toMatchObject({ ok: false, reason: 'unreadable', errno: 'EACCES' })
    expect(r.ok === false && r.path).toBe(path.join(src, 'data.txt'))
    expect(listTree(dest)).not.toContain('data.txt')
  })
})

describe('the lstat-to-open race: a path that changed type is refused, not copied as a file', () => {
  /** Two files, `a.txt` then `b.txt`; the hook runs after `a.txt`, with `b.txt` already typed as a file. */
  const twoFiles = (root: string): string => {
    const src = path.join(root, 'skill')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    fs.writeFileSync(path.join(src, 'b.txt'), 'b')
    return src
  }

  it('b.txt becomes a directory: changed-during-copy, and nothing is written for it', async () => {
    const root = tmp()
    const src = twoFiles(root)
    const dest = path.join(root, 'dest')
    const r = await copyTreeNoFollow(src, dest, {
      afterEntry: (rel) => {
        if (rel !== 'a.txt') return
        fs.rmSync(path.join(src, 'b.txt'))
        fs.mkdirSync(path.join(src, 'b.txt'))
      },
    })
    expect(r).toMatchObject({
      ok: false,
      reason: 'changed-during-copy',
      path: path.join(src, 'b.txt'),
    })
    expect(lstatBig(path.join(dest, 'b.txt'))).toBeNull()
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('a')
  })

  it('b.txt becomes a symlink to a file outside: refused, no outside byte reaches dest', async () => {
    const root = tmp()
    const src = twoFiles(root)
    fs.writeFileSync(path.join(root, 'outside.txt'), SENTINEL)
    const dest = path.join(root, 'dest')
    const r = await copyTreeNoFollow(src, dest, {
      afterEntry: (rel) => {
        if (rel !== 'a.txt') return
        fs.rmSync(path.join(src, 'b.txt'))
        fs.symlinkSync(path.join(root, 'outside.txt'), path.join(src, 'b.txt'))
      },
    })
    expect(r).toMatchObject({ ok: false, reason: 'changed-during-copy', errno: 'ELOOP' })
    expect(anyFileContains(dest, SENTINEL)).toBe(false)
    expect(lstatBig(path.join(dest, 'b.txt'))).toBeNull()
  })

  it('b.txt becomes a FIFO: refused without blocking the open', async () => {
    const root = tmp()
    const src = twoFiles(root)
    const dest = path.join(root, 'dest')
    const r = await copyTreeNoFollow(src, dest, {
      afterEntry: (rel) => {
        if (rel !== 'a.txt') return
        fs.rmSync(path.join(src, 'b.txt'))
        execFileSync('mkfifo', [path.join(src, 'b.txt')])
      },
    })
    expect(r).toMatchObject({ ok: false, reason: 'changed-during-copy' })
    expect(lstatBig(path.join(dest, 'b.txt'))).toBeNull()
  })
})
