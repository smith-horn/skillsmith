import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assertInsideRoot, PathOutsideRoot } from '../utils/pathContainment'

describe('assertInsideRoot', () => {
  let root: string
  let outside: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-root-'))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-outside-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  it('accepts a direct child of root', async () => {
    const child = path.join(root, 'my-skill')
    await fs.mkdir(child)
    await expect(assertInsideRoot(child, root)).resolves.toBeUndefined()
  })

  it('accepts a nested descendant of root', async () => {
    const nested = path.join(root, 'author', 'skill')
    await fs.mkdir(nested, { recursive: true })
    await expect(assertInsideRoot(nested, root)).resolves.toBeUndefined()
  })

  it('rejects a sibling outside root', async () => {
    await expect(assertInsideRoot(outside, root)).rejects.toBeInstanceOf(PathOutsideRoot)
  })

  it('rejects a traversal path', async () => {
    const traversal = path.join(root, '..', path.basename(outside))
    await expect(assertInsideRoot(traversal, root)).rejects.toBeInstanceOf(PathOutsideRoot)
  })

  it('rejects when target equals root (destructive on whole directory)', async () => {
    await expect(assertInsideRoot(root, root)).rejects.toBeInstanceOf(PathOutsideRoot)
  })

  it('rejects a symlink inside root that points outside', async () => {
    const link = path.join(root, 'evil')
    await fs.symlink(outside, link)
    await expect(assertInsideRoot(link, root)).rejects.toBeInstanceOf(PathOutsideRoot)
  })

  it('rejects a non-existent target (cannot verify containment)', async () => {
    const nonExistent = path.join(root, 'does-not-exist')
    await expect(assertInsideRoot(nonExistent, root)).rejects.toBeInstanceOf(PathOutsideRoot)
  })

  it('re-throws non-ENOENT realpath errors rather than masking them as PathOutsideRoot', async () => {
    // Simulate an ENOTDIR error by using a file as a path component.
    // realpath will throw ENOTDIR — this must NOT be swallowed as PathOutsideRoot.
    const file = path.join(root, 'a-file')
    await fs.writeFile(file, 'x')
    const throughFile = path.join(file, 'impossible-child')
    const err = await assertInsideRoot(throughFile, root).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(PathOutsideRoot)
    expect((err as NodeJS.ErrnoException).code).toBe('ENOTDIR')
  })

  it('accepts when root itself is a symlink resolved to a real dir', async () => {
    const symlinkRoot = path.join(
      os.tmpdir(),
      `skillsmith-sym-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    await fs.symlink(root, symlinkRoot)
    try {
      const child = path.join(root, 'child')
      await fs.mkdir(child)
      await expect(assertInsideRoot(child, symlinkRoot)).resolves.toBeUndefined()
    } finally {
      await fs.unlink(symlinkRoot)
    }
  })
})
