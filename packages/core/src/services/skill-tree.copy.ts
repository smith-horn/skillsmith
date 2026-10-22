/**
 * SMI-6531 (A1 step 3): the no-follow tree copy (A1 plan §3.4 "Copying").
 *
 * Copies a skill folder into `new/` or a backup copy temp without following a
 * link it can see: every entry is typed by `lstat`, a file is opened
 * `O_RDONLY|O_NOFOLLOW` and its descriptor must be the inode the walk typed,
 * a symlink is recreated from its verbatim text and must still be the link
 * inode the walk typed after that text is read, and a directory must keep the
 * identity `lstat` gave it from before its names are read until after its
 * children are typed. A single swap of an entry or a parent directory between
 * its check and its use is refused: as `changed-during-copy`, or as
 * `unreadable` (ENOENT) when the swapped-in path no longer holds the entry at
 * all. Nothing is copied from it either way. What it does not
 * refuse is a double swap: a parent swapped for a link while its children are
 * typed, restored for its identity check, then swapped in again when a child
 * is opened. That can read outside bytes into the copy; the caller's hash of
 * the copy against `preTree` (below) keeps such a build from being published.
 *
 * Each directory's children are typed together before any is copied. That is
 * the plan's window (a type check, then later use), and it is what lets a test
 * put a swap between the check and the use through `afterEntry`.
 *
 * On failure it leaves what it already wrote and removes nothing: the caller's
 * abort cleanup owns the destination.
 *
 * It is not a snapshot: a file edited in place while it is read can reach the
 * copy with either version, or a mix. The caller catches that by hashing the
 * COPY and comparing it with `preTree` (A1 plan §3.3 step 1, "verify the copy's
 * untouched part matches `preTree`"), which an edit restored before a later
 * re-hash of the live folder cannot pass.
 *
 * @module @skillsmith/core/services/skill-tree.copy
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { syncDirectory } from '../install/dir-sync.js'
import { O_NOFOLLOW, writeFullBuffer } from '../utils/safe-fs.js'

export type CopyFailureReason =
  /** A FIFO, socket, device (or a non-directory root) in the source. */
  | 'unsupported-entry'
  /** A source read failed. */
  | 'unreadable'
  /** A destination write failed. */
  | 'write-failed'
  /** `destAbs` already exists; nothing was written. */
  | 'dest-exists'
  /** A source path changed type or identity after it was typed. */
  | 'changed-during-copy'

export type CopyResult =
  | { ok: true }
  | { ok: false; reason: CopyFailureReason; path: string; errno: string | null }

/** @internal Test seam. */
export interface CopyHooks {
  /**
   * Called once an entry exists at the destination, with its path relative to
   * the root: after a file or symlink is written, and for a directory after
   * its `mkdir`, before its children.
   */
  afterEntry?: (rel: string) => void
  /**
   * Called once a directory's names are read and before its children are
   * typed, with the directory's path relative to the root (`''` for the root).
   */
  afterListed?: (rel: string) => void
}

type Failure = Extract<CopyResult, { ok: false }>

const S_IMODE = 0o7777

const fail = (reason: CopyFailureReason, p: string, err: unknown): Failure => ({
  ok: false,
  reason,
  path: p,
  errno: errno(err),
})

function errno(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : null
}

/** An errno that means the path no longer resolves the way it was typed. */
const pathChanged = (err: unknown): boolean => {
  const c = errno(err)
  return c === 'EINVAL' || c === 'ENOTDIR' || c === 'ELOOP'
}

/** The same directory the walk typed: not swapped for a link or another directory. */
const sameDir = (a: BigIntStats, b: BigIntStats): boolean =>
  b.isDirectory() && a.dev === b.dev && a.ino === b.ino

/** `changed-during-copy` when `dirAbs` is no longer the directory typed, `unreadable` when it can't be checked, else null. */
async function dirChanged(dirAbs: string, typed: BigIntStats): Promise<Failure | null> {
  try {
    if (sameDir(typed, await fs.promises.lstat(dirAbs, { bigint: true }))) return null
  } catch (err) {
    return fail('unreadable', dirAbs, err)
  }
  return { ok: false, reason: 'changed-during-copy', path: dirAbs, errno: null }
}

async function syncOrFail(dir: string): Promise<Failure | null> {
  const s = await syncDirectory(dir)
  return s.outcome === 'failed' ? fail('write-failed', dir, { code: s.code }) : null
}

/**
 * `typed` is the `lstat` the walk took when it typed this entry. The opened
 * descriptor must be that same inode: `O_NOFOLLOW` guards only the last path
 * component, so a parent directory swapped for a link after its own checks
 * would otherwise let this open read a file from outside the skill.
 */
async function copyFile(
  srcAbs: string,
  destAbs: string,
  typed: BigIntStats
): Promise<Failure | null> {
  const mode = Number(typed.mode) & S_IMODE
  let src: fs.promises.FileHandle
  try {
    // O_NONBLOCK: a path swapped for a FIFO must fail the fstat below, not block the open.
    src = await fs.promises.open(
      srcAbs,
      fs.constants.O_RDONLY | O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
  } catch (err) {
    const code = errno(err)
    return fail(
      code === 'ELOOP' || code === 'ENOTDIR' ? 'changed-during-copy' : 'unreadable',
      srcAbs,
      err
    )
  }
  try {
    let data: Buffer
    try {
      const opened = await src.stat({ bigint: true })
      if (!opened.isFile() || opened.dev !== typed.dev || opened.ino !== typed.ino) {
        return { ok: false, reason: 'changed-during-copy', path: srcAbs, errno: null }
      }
      data = await src.readFile()
    } catch (err) {
      return fail('unreadable', srcAbs, err)
    }
    let dest: fs.promises.FileHandle
    try {
      dest = await fs.promises.open(
        destAbs,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
        0o600
      )
    } catch (err) {
      return fail('write-failed', destAbs, err)
    }
    try {
      await writeFullBuffer(dest, data)
      await dest.chmod(mode)
      await dest.sync()
    } catch (err) {
      return fail('write-failed', destAbs, err)
    } finally {
      await dest.close().catch(() => undefined)
    }
    return null
  } finally {
    await src.close().catch(() => undefined)
  }
}

interface Typed {
  name: string
  st: BigIntStats
}

async function copyDir(
  srcAbs: string,
  destAbs: string,
  rel: string,
  typed: BigIntStats,
  hooks: CopyHooks | undefined
): Promise<Failure | null> {
  // The path must be the directory that was typed both before its names are
  // read and after its children are typed: `readdir` and each child's `lstat`
  // resolve `srcAbs` as an intermediate component, so a directory swapped for a
  // link anywhere in that span would list, and type, entries outside the skill.
  // One check after the typing covers the whole span. What it cannot see is a
  // swap undone before it runs (link in, then back): the children typed then
  // are outside inodes, so each later open either fails `copyFile`'s inode
  // match or, only if the link is swapped in AGAIN at that open, copies them.
  // That double race is the path-based residual (ADR-166 D-0); the caller's
  // hash of the copy against `preTree` (§3.3 step 1) still refuses the build.
  let names: string[]
  try {
    if (!sameDir(typed, await fs.promises.lstat(srcAbs, { bigint: true }))) {
      return { ok: false, reason: 'changed-during-copy', path: srcAbs, errno: null }
    }
    names = (await fs.promises.readdir(srcAbs)).sort()
  } catch (err) {
    return fail('unreadable', srcAbs, err)
  }
  hooks?.afterListed?.(rel)
  const entries: Typed[] = []
  for (const name of names) {
    try {
      entries.push({ name, st: await fs.promises.lstat(path.join(srcAbs, name), { bigint: true }) })
    } catch (err) {
      // A listed name gone missing is most often the directory itself having
      // been swapped; say so when it was, rather than `unreadable`.
      return (await dirChanged(srcAbs, typed)) ?? fail('unreadable', path.join(srcAbs, name), err)
    }
  }
  const moved = await dirChanged(srcAbs, typed)
  if (moved !== null) return moved
  // Refuse an unsupported entry before writing any sibling of it.
  for (const { name, st } of entries) {
    if (!st.isDirectory() && !st.isFile() && !st.isSymbolicLink()) {
      return { ok: false, reason: 'unsupported-entry', path: path.join(srcAbs, name), errno: null }
    }
  }
  for (const { name, st } of entries) {
    const childSrc = path.join(srcAbs, name)
    const childDest = path.join(destAbs, name)
    const childRel = rel ? `${rel}/${name}` : name
    let f: Failure | null
    if (st.isDirectory()) f = await copyDirEntry(childSrc, childDest, childRel, st, hooks)
    else if (st.isSymbolicLink()) f = await copyLink(childSrc, childDest, st)
    else f = await copyFile(childSrc, childDest, st)
    if (f !== null) return f
    if (!st.isDirectory()) hooks?.afterEntry?.(childRel)
  }
  return null
}

/**
 * `typed` is the walk's `lstat` of this link. `readlink` resolves the parent
 * by path, so after it the path must still be that same link inode: a parent
 * swapped for a link after its own checks would otherwise hand back the text
 * of a link outside the skill (round 3, SMI-6531), the symlink counterpart of
 * `copyFile`'s descriptor check.
 */
async function copyLink(
  srcAbs: string,
  destAbs: string,
  typed: BigIntStats
): Promise<Failure | null> {
  let text: string
  try {
    text = await fs.promises.readlink(srcAbs)
  } catch (err) {
    // EINVAL: no longer a link. ENOTDIR, ELOOP: a parent stopped being a
    // directory (the same mapping `copyFile` uses).
    return fail(pathChanged(err) ? 'changed-during-copy' : 'unreadable', srcAbs, err)
  }
  try {
    const now = await fs.promises.lstat(srcAbs, { bigint: true })
    if (!now.isSymbolicLink() || now.dev !== typed.dev || now.ino !== typed.ino) {
      return { ok: false, reason: 'changed-during-copy', path: srcAbs, errno: null }
    }
  } catch (err) {
    return fail(pathChanged(err) ? 'changed-during-copy' : 'unreadable', srcAbs, err)
  }
  try {
    await fs.promises.symlink(text, destAbs)
  } catch (err) {
    return fail('write-failed', destAbs, err)
  }
  return null
}

async function copyDirEntry(
  srcAbs: string,
  destAbs: string,
  rel: string,
  typed: BigIntStats,
  hooks: CopyHooks | undefined
): Promise<Failure | null> {
  try {
    await fs.promises.mkdir(destAbs, { mode: 0o700 })
  } catch (err) {
    return fail('write-failed', destAbs, err)
  }
  hooks?.afterEntry?.(rel)
  const f = await copyDir(srcAbs, destAbs, rel, typed, hooks)
  if (f !== null) return f
  try {
    await fs.promises.chmod(destAbs, Number(typed.mode) & S_IMODE)
  } catch (err) {
    return fail('write-failed', destAbs, err)
  }
  return syncOrFail(destAbs)
}

/**
 * Copies the directory `srcAbs` to `destAbs`, which must not exist (its parent
 * must). Never follows a link; recreates symlinks verbatim; preserves file and
 * directory modes. Returns `{ ok: true }` or the first failure, leaving what it
 * wrote (it removes nothing).
 */
export async function copyTreeNoFollow(
  srcAbs: string,
  destAbs: string,
  /** @internal */
  hooks?: CopyHooks
): Promise<CopyResult> {
  let root: BigIntStats
  try {
    root = await fs.promises.lstat(srcAbs, { bigint: true })
  } catch (err) {
    return fail('unreadable', srcAbs, err)
  }
  if (!root.isDirectory()) {
    return { ok: false, reason: 'unsupported-entry', path: srcAbs, errno: null }
  }
  try {
    await fs.promises.mkdir(destAbs, { mode: 0o700 })
  } catch (err) {
    return fail(errno(err) === 'EEXIST' ? 'dest-exists' : 'write-failed', destAbs, err)
  }
  const f = await copyDir(srcAbs, destAbs, '', root, hooks)
  if (f !== null) return f
  try {
    await fs.promises.chmod(destAbs, Number(root.mode) & S_IMODE)
  } catch (err) {
    return fail('write-failed', destAbs, err)
  }
  return (await syncOrFail(destAbs)) ?? { ok: true }
}
