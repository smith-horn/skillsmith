/**
 * LocalFilesystemAdapter helpers (SMI-4287)
 *
 * Typed filesystem wrappers and symlink containment helpers used by
 * LocalFilesystemAdapter. These surface `AdapterError` return values instead
 * of throwing, so the adapter can continue scanning past individual failures
 * (permission, symlink escape, loop) and aggregate them into
 * `SourceSearchResult.warnings`.
 */

import { promises as fs, type Dirent, type Stats } from 'fs'
import { platform } from 'os'
import { validatePath } from '../validation/index.js'
import type { AdapterError } from './types.js'

/**
 * Success / failure result envelope used by `safeFs` helpers.
 *
 * @typeParam T - Type of the successful value
 */
export type FsResult<T> = { ok: true; value: T } | { ok: false; error: AdapterError }

/**
 * Map a Node filesystem error to an `AdapterError.code`.
 */
function mapErrnoToCode(err: unknown): AdapterError['code'] {
  const code = (err as NodeJS.ErrnoException)?.code
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission'
    case 'ENOENT':
      return 'not-found'
    case 'ELOOP':
      return 'loop'
    default:
      return 'io'
  }
}

/**
 * Build a human-friendly message for an AdapterError.
 */
function describe(code: AdapterError['code'], path: string): string {
  switch (code) {
    case 'permission':
      return `Cannot read: ${path}`
    case 'not-found':
      return `Not found: ${path}`
    case 'loop':
      return `Symlink loop detected: ${path}`
    case 'symlink-escape':
      return `Symlink outside root, skipped: ${path}`
    case 'io':
      return `Filesystem error: ${path}`
  }
}

/**
 * Wrap a throwing `fs` call into an `FsResult<T>`.
 */
async function wrap<T>(path: string, op: () => Promise<T>): Promise<FsResult<T>> {
  try {
    return { ok: true, value: await op() }
  } catch (error) {
    const code = mapErrnoToCode(error)
    return {
      ok: false,
      error: {
        code,
        path,
        message: describe(code, path),
        cause: error,
      },
    }
  }
}

/**
 * Safe filesystem wrappers that return `FsResult<T>` instead of throwing.
 */
export const safeFs = {
  readdir(path: string): Promise<FsResult<Dirent[]>> {
    return wrap(path, () => fs.readdir(path, { withFileTypes: true }))
  },
  stat(path: string): Promise<FsResult<Stats>> {
    return wrap(path, () => fs.stat(path))
  },
  readFile(path: string, encoding: BufferEncoding = 'utf-8'): Promise<FsResult<string>> {
    return wrap(path, () => fs.readFile(path, encoding))
  },
  realpath(path: string): Promise<FsResult<string>> {
    return wrap(path, () => fs.realpath(path))
  },
} as const

/**
 * Normalise a filesystem path for case-insensitive comparison on macOS / APFS
 * (and Windows, when support is added). Other Linux / ext4 / xfs filesystems
 * are case-sensitive, so we leave them untouched.
 */
function normaliseForFs(input: string): string {
  // APFS (macOS default) and NTFS (Windows) are case-insensitive in practice.
  // Linux ext4/btrfs/xfs are case-sensitive.
  return platform() === 'darwin' || platform() === 'win32' ? input.toLowerCase() : input
}

/**
 * Resolve `candidate` to a realpath and verify it remains within `root`.
 *
 * Delegates containment to `validatePath` after running `fs.realpath` on both
 * the candidate and the root — this catches symlinks pointing outside the
 * root even when the unresolved lexical path is contained.
 *
 * Returns `{ ok: true, value: resolvedRealpath }` on success. On failure
 * returns an `AdapterError` with:
 * - `symlink-escape` if the target resolves outside the root
 * - `loop` on `ELOOP` (circular symlinks)
 * - `permission` / `not-found` / `io` for other filesystem errors
 *
 * Does NOT throw for containment violations (caller drives the warning list).
 */
export async function resolveSafeRealpath(
  candidate: string,
  root: string
): Promise<FsResult<string>> {
  const candidateResult = await safeFs.realpath(candidate)
  if (!candidateResult.ok) return candidateResult

  const rootResult = await safeFs.realpath(root)
  if (!rootResult.ok) return rootResult

  const normalisedCandidate = normaliseForFs(candidateResult.value)
  const normalisedRoot = normaliseForFs(rootResult.value)

  try {
    validatePath(normalisedCandidate, normalisedRoot)
  } catch {
    // Report the symlink path the user can identify (not the opaque
    // realpath target). Including the target would leak the external
    // location, which is exactly what the guard is protecting against.
    return {
      ok: false,
      error: {
        code: 'symlink-escape',
        path: candidate,
        message: describe('symlink-escape', candidate),
      },
    }
  }

  return { ok: true, value: candidateResult.value }
}
