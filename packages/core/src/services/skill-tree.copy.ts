/**
 * SMI-6531 (A1 step 3): the no-follow tree copy (A1 plan §3.4 "Copying").
 *
 * Copies a skill folder into `new/` or a backup copy temp without ever reading
 * through a link: every entry is typed by `lstat`, a file is opened
 * `O_RDONLY|O_NOFOLLOW` and `fstat`ed on the descriptor, a symlink is
 * recreated from its verbatim text, and a directory is re-checked against the
 * identity `lstat` gave it before its names are read. A path swapped between
 * the type check and its use is refused as `changed-during-copy`, never copied
 * as whatever it became.
 *
 * Each directory's children are typed together before any is copied. That is
 * the plan's window (a type check, then later use), and it is what lets a test
 * put a swap between the check and the use through `afterEntry`.
 *
 * On failure it leaves what it already wrote and removes nothing: the caller's
 * abort cleanup owns the destination. A foreign change that does not trip a
 * check here is caught by step 4's tree hash.
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

/** The same directory the walk typed: not swapped for a link or another directory. */
const sameDir = (a: BigIntStats, b: BigIntStats): boolean =>
  b.isDirectory() && a.dev === b.dev && a.ino === b.ino

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
  // The path must still be the directory that was typed, before and after its
  // names are read: readdir follows a link, so a swapped-in link would list
  // (and the children would be read from) a directory outside the skill.
  let names: string[]
  try {
    if (!sameDir(typed, await fs.promises.lstat(srcAbs, { bigint: true }))) {
      return { ok: false, reason: 'changed-during-copy', path: srcAbs, errno: null }
    }
    names = (await fs.promises.readdir(srcAbs)).sort()
    if (!sameDir(typed, await fs.promises.lstat(srcAbs, { bigint: true }))) {
      return { ok: false, reason: 'changed-during-copy', path: srcAbs, errno: null }
    }
  } catch (err) {
    return fail('unreadable', srcAbs, err)
  }
  const entries: Typed[] = []
  for (const name of names) {
    try {
      entries.push({ name, st: await fs.promises.lstat(path.join(srcAbs, name), { bigint: true }) })
    } catch (err) {
      return fail('unreadable', path.join(srcAbs, name), err)
    }
  }
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
    else if (st.isSymbolicLink()) f = await copyLink(childSrc, childDest)
    else f = await copyFile(childSrc, childDest, st)
    if (f !== null) return f
    if (!st.isDirectory()) hooks?.afterEntry?.(childRel)
  }
  return null
}

async function copyLink(srcAbs: string, destAbs: string): Promise<Failure | null> {
  let text: string
  try {
    text = await fs.promises.readlink(srcAbs)
  } catch (err) {
    // EINVAL: no longer a link.
    return fail(errno(err) === 'EINVAL' ? 'changed-during-copy' : 'unreadable', srcAbs, err)
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
