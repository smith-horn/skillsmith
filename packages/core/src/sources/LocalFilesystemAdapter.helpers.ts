/**
 * LocalFilesystemAdapter helpers (SMI-4287, SMI-4319, SMI-4320)
 *
 * Typed filesystem wrappers and symlink containment helpers used by
 * LocalFilesystemAdapter. These surface `AdapterError` return values instead
 * of throwing, so the adapter can continue scanning past individual failures
 * (permission, symlink escape, loop) and aggregate them into
 * `SourceSearchResult.warnings`.
 *
 * SMI-4320: drops platform-based `normaliseForFs` in favour of byte-wise
 * `startsWith(root + sep)` on realpath outputs. The FS itself canonicalises
 * case via `realpath` — platform heuristics miscategorise case-sensitive
 * volumes (HFS+ case-sensitive macOS volumes, ext4 case-folded dirs).
 * `resolveSafeRealpath` now accepts an `allowSymlinksOutsideRoot` opt-in
 * (see SMI-4287) so direct-access callers can inherit the same containment
 * policy as the scan loop.
 */

import { promises as fs, type Dirent, type Stats } from 'fs'
import { sep } from 'path'
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
 * Byte-wise containment check on two realpath outputs (SMI-4320).
 *
 * Compares raw realpath bytes: `candidateReal === rootReal` or
 * `candidateReal.startsWith(rootReal + sep)`. No platform lowercasing — the
 * filesystem is authoritative. Case-insensitive volumes (APFS default, NTFS)
 * already canonicalise case through `fs.realpath`; case-sensitive volumes
 * (HFS+ case-sensitive, ext4 case-folded) keep distinct paths distinct.
 *
 * The trailing-separator guard is load-bearing: without `+ sep`,
 * `rootDir = /a/root` would accept `/a/rootfoo` as contained.
 */
export function isRealpathContained(candidateReal: string, rootReal: string): boolean {
  return candidateReal === rootReal || candidateReal.startsWith(rootReal + sep)
}

/**
 * Options accepted by `resolveSafeRealpath`.
 *
 * - `allowSymlinksOutsideRoot` (SMI-4287): when `true`, skip the containment
 *   re-check and return the realpath unconditionally. Callers that opt in
 *   accept the security tradeoff — used by dev-install tooling that scans
 *   linked sibling packages.
 */
export interface ResolveSafeRealpathOptions {
  allowSymlinksOutsideRoot?: boolean
}

/**
 * Resolve `candidate` to a realpath and verify it remains within `root`.
 *
 * Runs `fs.realpath` on both the candidate and the root, then performs a
 * byte-wise `startsWith(rootReal + sep)` check (SMI-4320). On case-insensitive
 * volumes the FS canonicalises case inside `realpath`; on case-sensitive
 * volumes distinct cases remain distinct — both outcomes are correct.
 *
 * Returns `{ ok: true, value: resolvedRealpath }` on success. On failure
 * returns an `AdapterError` with:
 * - `symlink-escape` if the target resolves outside the root
 * - `loop` on `ELOOP` (circular symlinks)
 * - `permission` / `not-found` / `io` for other filesystem errors
 *
 * Does NOT throw for containment violations (caller drives the warning list).
 *
 * SMI-4287 opt-in: when `opts.allowSymlinksOutsideRoot === true`, containment
 * is skipped entirely. The loop-detection + other realpath errors still apply.
 *
 * TOCTOU caveat: this is a check-then-use pattern. Between the realpath
 * check and a subsequent `fs.readFile`, a malicious actor with write access
 * inside `rootDir` could swap the symlink target. True atomicity requires
 * fd-based I/O (`fs.open` + fstat-by-fd + read-by-fd) and is out of scope
 * here — this helper closes the 99% case where the attack window is
 * scan-to-fetch (minutes to hours). See plan doc for the residual risk.
 */
export async function resolveSafeRealpath(
  candidate: string,
  root: string,
  opts: ResolveSafeRealpathOptions = {}
): Promise<FsResult<string>> {
  const candidateResult = await safeFs.realpath(candidate)
  if (!candidateResult.ok) return candidateResult

  if (opts.allowSymlinksOutsideRoot === true) {
    return candidateResult
  }

  const rootResult = await safeFs.realpath(root)
  if (!rootResult.ok) return rootResult

  if (!isRealpathContained(candidateResult.value, rootResult.value)) {
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
