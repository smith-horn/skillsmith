/**
 * SMI-6529 round 15: `removeIfSame` removes an entry only while it is still
 * the entry the caller saw. It checks the entry after parking it under a
 * random name, so a folder another program puts at the path in the meantime
 * is never the one deleted (Opus round 14, finding 2).
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import type { PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RealFs = typeof import('node:fs/promises')

const PARKED = /\.skillsmith-removing-[0-9a-f]{32}$/

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'remove-if-same-'))
  vi.resetModules()
})

afterEach(async () => {
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

async function load() {
  return await import('../../src/install/remove-if-same.js')
}

function eacces(p: PathLike): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, '${String(p)}'`), { code: 'EACCES' })
}

/** Act out another program putting its own folder at `target`, moving any entry there aside. */
async function swapIn(real: RealFs, target: string): Promise<void> {
  await real.rename(target, `${target}-moved`).catch(() => {})
  await real.mkdir(target)
  await real.writeFile(path.join(target, 'KEEP.md'), 'not ours', 'utf-8')
}

/** Mock one `node:fs/promises` function for the module loaded next. */
function mockFs<K extends 'rename' | 'lstat' | 'rm' | 'unlink'>(
  name: K,
  make: (actual: RealFs) => RealFs[K]
): void {
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<RealFs>('node:fs/promises')
    const fn = make(actual)
    return { ...actual, default: { ...actual, [name]: fn }, [name]: fn }
  })
}

describe('removeIfSame (SMI-6529 round 15)', () => {
  it('removes a folder, a file and a symlink that are still what the caller saw', async () => {
    const { removeIfSame } = await load()
    const dir = path.join(root, 'dir')
    await mkdir(path.join(dir, 'sub'), { recursive: true })
    await writeFile(path.join(dir, 'sub', 'a.md'), 'a', 'utf-8')
    const file = path.join(root, 'file')
    await writeFile(file, 'f', 'utf-8')
    const pointedAt = path.join(root, 'pointed-at')
    await mkdir(pointedAt)
    const link = path.join(root, 'link')
    await symlink(pointedAt, link)

    for (const p of [dir, file, link]) {
      expect(await removeIfSame(p, await lstat(p))).toEqual({ removed: true })
    }
    // The symlink is gone; what it pointed at is not.
    expect(await readdir(root)).toEqual(['pointed-at'])
  })

  it('counts an entry that is already gone as removed', async () => {
    const { removeIfSame } = await load()
    const target = path.join(root, 'gone')
    await mkdir(target)
    const seen = await lstat(target)
    await rm(target, { recursive: true })
    expect(await removeIfSame(target, seen)).toEqual({ removed: true })
  })

  // Round 17: the identity is checked before the entry is parked, so an
  // ordinary mismatch moves nothing at all.
  it('refuses without moving anything when the entry was already replaced', async () => {
    const { removeIfSame } = await load()
    const target = path.join(root, 'skill')
    await mkdir(target)
    const seen = await lstat(target)
    await rename(target, `${target}-moved`)
    await mkdir(target)
    await writeFile(path.join(target, 'KEEP.md'), 'not ours', 'utf-8')

    expect(await removeIfSame(target, seen)).toEqual({
      removed: false,
      reason: 'was replaced by something else, so it was left in place',
    })
    expect(await readFile(path.join(target, 'KEEP.md'), 'utf-8')).toBe('not ours')
    expect((await readdir(root)).sort()).toEqual(['skill', 'skill-moved'])
    expect((await readdir(root)).some((n) => PARKED.test(n))).toBe(false)
  })

  it('never deletes a folder another program puts at the path while the delete runs', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    await writeFile(path.join(target, 'SKILL.md'), 'ours', 'utf-8')
    mockFs('rm', (actual) => {
      let swapped = false
      return (async (...args: Parameters<RealFs['rm']>) => {
        if (!swapped) {
          swapped = true
          await swapIn(actual, target)
        }
        return actual.rm(...args)
      }) as RealFs['rm']
    })
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, await lstat(target))).toEqual({ removed: true })
    expect(await readFile(path.join(target, 'KEEP.md'), 'utf-8')).toBe('not ours')
    expect(await readdir(root)).toEqual(['skill'])
  })

  it('leaves what is left parked when the delete fails, and names where', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    await writeFile(path.join(target, 'SKILL.md'), 'ours', 'utf-8')
    mockFs(
      'rm',
      () =>
        (async (p: PathLike) => {
          throw eacces(p)
        }) as RealFs['rm']
    )
    const { removeIfSame } = await load()

    // Round 17: nothing is renamed back, so the caller is told exactly where
    // what is left ended up. The next uninstall of this skill reports it too.
    const result = await removeIfSame(target, await lstat(target))
    expect(result.removed).toBe(false)
    const reason = result.removed ? '' : result.reason
    expect(reason).toMatch(/^could not be removed \(EACCES\); what is left of it is at /)
    const parked = reason.slice(reason.lastIndexOf(' ') + 1)
    expect(path.basename(parked)).toMatch(PARKED)
    expect(await readFile(path.join(parked, 'SKILL.md'), 'utf-8')).toBe('ours')
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // Round 16 (both reviewers), round 17 (cross-model): `rename` REPLACES what
  // is at the destination — a directory replaces an empty directory, a file
  // replaces a file or a symlink — so nothing is ever renamed back.
  it('leaves what it removed parked rather than replacing a folder that took the path', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    await writeFile(path.join(target, 'SKILL.md'), 'ours', 'utf-8')
    mockFs(
      'rm',
      (actual) =>
        (async (p: PathLike) => {
          // Another program takes the path, with an empty directory: exactly
          // what an unguarded put-back would replace.
          await actual.mkdir(target)
          throw eacces(p)
        }) as RealFs['rm']
    )
    const { removeIfSame } = await load()

    const result = await removeIfSame(target, await lstat(target))
    expect(result.removed).toBe(false)
    const reason = result.removed ? '' : result.reason
    expect(reason).toMatch(/^could not be removed \(EACCES\); what is left of it is at /)
    // Their directory is untouched, and ours is still parked beside it.
    expect(await readdir(target)).toEqual([])
    const parked = (await readdir(root)).find((n) => PARKED.test(n))
    expect(parked).toBeDefined()
    expect(await readFile(path.join(root, parked ?? '', 'SKILL.md'), 'utf-8')).toBe('ours')
  })

  it('leaves a parked file rather than replacing a file that took the path', async () => {
    const target = path.join(root, 'note.md')
    await writeFile(target, 'ours', 'utf-8')
    const seen = await lstat(target)
    mockFs(
      'lstat',
      (actual) =>
        (async (...args: Parameters<RealFs['lstat']>) => {
          if (PARKED.test(String(args[0]))) {
            // The check fails, and another program writes its own file there.
            await actual.writeFile(target, 'theirs', 'utf-8')
            throw eacces(args[0])
          }
          return actual.lstat(...args)
        }) as RealFs['lstat']
    )
    const { removeIfSame } = await load()

    const result = await removeIfSame(target, seen)
    expect(result.removed).toBe(false)
    expect(result.removed ? '' : result.reason).toMatch(
      /^could not be checked \(EACCES\) and is now at /
    )
    expect(await readFile(target, 'utf-8')).toBe('theirs')
    const parked = (await readdir(root)).find((n) => PARKED.test(n))
    expect(parked).toBeDefined()
    expect(await readFile(path.join(root, parked ?? ''), 'utf-8')).toBe('ours')
  })

  it('leaves an entry it cannot move aside where it is', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    mockFs(
      'rename',
      (actual) =>
        (async (from: PathLike, to: PathLike) => {
          if (String(from) === target) throw eacces(from)
          return actual.rename(from, to)
        }) as RealFs['rename']
    )
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, await lstat(target))).toEqual({
      removed: false,
      reason: 'could not be moved aside to be removed (EACCES), so it was left in place',
    })
    expect((await lstat(target)).isDirectory()).toBe(true)
  })

  // Round 19 (Opus): a regular file can go back atomically — `link` fails
  // with EEXIST instead of replacing — so files are put back while
  // directories and symlinks stay parked.
  it('puts a parked file back when the path is free', async () => {
    const target = path.join(root, 'note.md')
    await writeFile(target, 'ours', 'utf-8')
    mockFs(
      'unlink',
      () =>
        (async (p: PathLike) => {
          throw eacces(p)
        }) as RealFs['unlink']
    )
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, await lstat(target))).toEqual({
      removed: false,
      reason: 'could not be removed (EACCES), so it was left in place',
    })
    expect(await readFile(target, 'utf-8')).toBe('ours')
  })

  it('puts a file another program left at the path back, rather than parking it', async () => {
    const target = path.join(root, 'note.md')
    await writeFile(target, 'ours', 'utf-8')
    const seen = await lstat(target)
    mockFs(
      'rename',
      (actual) =>
        (async (from: PathLike, to: PathLike) => {
          if (String(from) === target) {
            // Between the check and the park, another program replaces it.
            // Written elsewhere and renamed in, so it is a distinct inode: a
            // freed one can be reused straight away.
            const theirs = `${target}.theirs`
            await actual.writeFile(theirs, 'theirs', 'utf-8')
            await actual.rename(theirs, target)
          }
          return actual.rename(from, to)
        }) as RealFs['rename']
    )
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, seen)).toEqual({
      removed: false,
      reason: 'was replaced by something else, so it was left in place',
    })
    expect(await readFile(target, 'utf-8')).toBe('theirs')
    expect((await readdir(root)).some((n) => PARKED.test(n))).toBe(false)
  })

  it('leaves an entry it cannot check parked, and says where', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    const seen = await lstat(target)
    mockFs(
      'lstat',
      (actual) =>
        (async (...args: Parameters<RealFs['lstat']>) => {
          if (PARKED.test(String(args[0]))) throw eacces(args[0])
          return actual.lstat(...args)
        }) as RealFs['lstat']
    )
    const { removeIfSame } = await load()

    const result = await removeIfSame(target, seen)
    expect(result.removed).toBe(false)
    expect(result.removed ? '' : result.reason).toMatch(
      /^could not be checked \(EACCES\) and is now at /
    )
    const left = await readdir(root)
    expect(left).toHaveLength(1)
    expect(left[0]).toMatch(PARKED)
  })
})
