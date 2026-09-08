/**
 * Shared filesystem + lock seams for SMI-6444's two independently-locked
 * artifacts: the disposition ledger (`smi5879-dispose-terminal.ledger.ts`,
 * short read-mutate-write critical sections) and the `.sample.json` sidecar
 * (`smi5879-dispose-terminal.sidecar.ts`, one hours-long exclusive claim per
 * in-flight sample). They deliberately hold DIFFERENT locks — see plan Item 8
 * — but share this identical, injectable I/O surface so the atomic
 * temp-file-plus-rename pattern is written once.
 * @module scripts/indexer/smi5879-dispose-terminal.io
 *
 * `acquireOwnedLock` is imported from the `@skillsmith/core/config/owned-lock`
 * SUBPATH, never the root barrel, which pulls native modules (plan Item 8 /
 * Surface Grounding).
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { StuckLockError, acquireOwnedLock } from '@skillsmith/core/config/owned-lock'

export type LockRelease = () => void

export interface LockAcquireOptions {
  timeoutMs?: number
  label: string
}

/**
 * Signature-compatible with `acquireOwnedLock` (synchronous, returns a
 * release function). Injected so tests can prove a lock spans the right
 * sequence without exercising `owned-lock.ts`'s own internals, which have
 * their own coverage (plan Item 9).
 */
export type LockAcquirer = (target: string, opts: LockAcquireOptions) => LockRelease

/** Every method is synchronous — the write protocol's ordering guarantees
 *  depend on it (nothing may interleave inside a step). */
export interface FileIoDeps {
  acquireLock: LockAcquirer
  fileExists: (path: string) => boolean
  readFile: (path: string) => string
  writeFile: (path: string, data: string) => void
  rename: (from: string, to: string) => void
  removeFile: (path: string) => void
  /** Sibling temp path in the SAME directory — a rename must not cross devices. */
  tempPathFor: (path: string) => string
}

export const defaultFileIoDeps: FileIoDeps = {
  acquireLock: (target, opts) =>
    acquireOwnedLock(target, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      label: opts.label,
    }),
  fileExists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
  rename: (from, to) => renameSync(from, to),
  removeFile: (path) => rmSync(path, { force: true }),
  tempPathFor: (path) => `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Add ONE line of context to a propagating {@link StuckLockError} without
 * changing anything else about it — the error already names both lock files,
 * its reason, and the manual unstick procedure, so re-wrapping it in a new
 * error class would lose exactly the information an operator needs (plan
 * Item 8: "propagates as-is ... the producer's own error wrapper adds one
 * line of context").
 */
export function acquireWithContext(acquire: () => LockRelease, contextLine: string): LockRelease {
  try {
    return acquire()
  } catch (error) {
    if (error instanceof StuckLockError) {
      error.message = `${error.message}\n${contextLine}`
    }
    throw error
  }
}

/**
 * Write `data` to `path` via a sibling temp file plus rename, so a reader
 * (or a crash) never observes a torn file. Used for every `.sample.json`
 * progress checkpoint; the LEDGER's write is deliberately NOT this function —
 * it needs the extra destination-digest recheck between validation and
 * rename (plan Item 8's five-step protocol).
 */
export function writeFileAtomically(deps: FileIoDeps, path: string, data: string): void {
  const tempPath = deps.tempPathFor(path)
  let renamed = false
  try {
    deps.writeFile(tempPath, data)
    deps.rename(tempPath, path)
    renamed = true
  } finally {
    if (!renamed) deps.removeFile(tempPath)
  }
}
