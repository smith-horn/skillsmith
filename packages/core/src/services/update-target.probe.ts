/**
 * @fileoverview I/O probe for the update eligibility gate (SMI-6532, A2 §4.2).
 * @module @skillsmith/core/services/update-target.probe
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.2
 *
 * `probeUpdateTarget` does ALL the filesystem I/O for one candidate update
 * target. The classifier that consumes its output (`classifyUpdateTarget`,
 * a later step — not this file) is pure and never touches `fs` itself; every
 * fact it needs about the directory on disk is a plain data field this probe
 * already produced.
 *
 * THE CENTRAL PROPERTY: a probe error never becomes a permissive value.
 * Today, `manage.update.identity.ts:66-78` turns every read error on
 * SKILL.md into `localContent = null`, and
 * `skill-identity-classification.ts:360-366` (`hasRecordedLocalEdit`) then
 * reads a `null` local hash as "no edit evidence" — i.e. a read FAILURE
 * silently classifies as "nothing changed here, safe to overwrite." This
 * probe never does that: every failure mode below produces its own
 * outcome (`probe-failed` or `unreadable`), never folds into `ok`.
 *
 * SANITIZED ERRORS. `{ path, errno }` on a failure outcome means:
 *   - `errno` is ONLY the OS error code (`err.code`, e.g. `'ENOENT'`,
 *     `'EACCES'`) — never `err.message` or `err.stack`, which can embed
 *     unbounded, implementation-specific text (and, on some libuv builds,
 *     extra syscall diagnostics).
 *   - `path` is the path THIS PROBE asked for, never `err.path`/`err.dest`
 *     read back off the exception. A symlink can make Node report a
 *     completely different path in its own error object; using our own
 *     intended path avoids ever surfacing where an attacker-planted symlink
 *     actually pointed.
 *   - No secrets are read onto this path in the first place: it is always
 *     one of `dir`, `skillMdPath`, or a `writeSet` member joined onto `dir`
 *     — filesystem paths the caller already owns, never file content.
 *
 * METADATA vs READ/HASH ERRORS (§4.2's own boundary, disambiguated here —
 * see this module's `## Ambiguity notes` in the fileoverview of the test
 * file for the reasoning): an `lstat`/`readdir` failure on `dir` itself, an
 * ancestor, or during the git walk is a METADATA error -> `probe-failed`.
 * An `lstat`/`readFile` failure on SKILL.md or any individual write-set
 * MEMBER is a READ error on that file -> `unreadable`. The directory-level
 * checks decide whether there is anything to classify at all; the per-file
 * checks decide whether what's there can be trusted for a content
 * comparison.
 *
 * RETRY RULE (§4.2): a swap in another process can leave a tracked folder's
 * path absent for up to ~15ms (E30). A tracked folder missing `ENOENT` on
 * the directory or its SKILL.md is re-probed up to 3 times, 20ms apart,
 * before it counts as missing. The delay is injectable so tests never sleep
 * for real; the retry COUNT itself must not be faked (SMI-6598) — the tests
 * in `update-target.probe.test.ts` pin exactly 3 attempts.
 *
 * `.skillsmith-staging/` RECORD CHECK — DOCUMENTED AMBIGUITY. §4.2 says a
 * missing tracked folder named by a `.skillsmith-staging/` record is
 * `recovery-pending`, not plain-missing. A1's staging writer
 * (`skill-write-lock.ts`, `skill-swap.ts`) and its `record.json` schema do
 * not exist in this tree yet (confirmed: no `skill-write-lock*`/
 * `skill-swap*` file exists under `packages/core/src/services/` as of this
 * writing). `defaultRecoveryPendingChecker` below is therefore the SAME
 * kind of placeholder as `temporaryManifestEvidenceResolver`
 * (`update-target.evidence.ts`) — injectable via `ProbeInput.
 * checkRecoveryPending`, with a best-effort default scan, swapped out once
 * A1's real record shape lands. This is flagged back to the requester as an
 * open ambiguity, not silently guessed at as settled fact.
 */

import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'

import { hasGitAncestorBetween, type GitWalkResult } from './skill-installation.target-guard.js'

/** Sanitized `{ path, errno }` — see this module's fileoverview. */
export interface ProbeError {
  path: string
  errno: string
}

/** The `hasGitAncestorBetween` result kind this probe ever surfaces inside an `ok` outcome — a real `.git` ancestor. A `kind: 'error'` walk result short-circuits into `probe-failed` instead and never reaches here. */
export type ProbeGitAncestor = Extract<GitWalkResult, { kind: 'found' }>

/** One probed write-set member (SKILL.md is always included, first). */
export interface ProbedFile {
  rel: string
  /** sha256 hex of the file's raw bytes, or `null` when nothing currently exists at this path — not itself an error (e.g. a file the write set will ADD). Hashed as bytes, never decoded/re-encoded through a string, so a binary write-set member (an asset, a script) hashes correctly. */
  sha256: string | null
  /** Set only when something other than "regular file or absent" occupies this path. `classifyUpdateTarget` turns this into `unsupported-entry` (§4.3 row 12). */
  entryType?: 'symlink' | 'directory' | 'other'
}

/** Everything the (pure) classifier needs about one on-disk target. */
export interface ProbeOk {
  kind: 'ok'
  /** A real `.git` ancestor between `dir` and `skillsDir`, or `null` when none exists. */
  gitAncestor: ProbeGitAncestor | null
  /** sha256 of SKILL.md's current raw bytes — duplicated into `files` too, exposed directly since the retry rule is keyed on SKILL.md specifically. */
  skillMdHash: string
  /** One entry per write-set member, `SKILL.md` first. */
  files: ProbedFile[]
}

export type ProbeOutcome =
  | ProbeOk
  | { kind: 'recovery-pending' }
  | { kind: 'probe-failed'; error: ProbeError }
  | { kind: 'unreadable'; error: ProbeError }

/** Asked when a tracked folder is missing on every retry attempt: does a `.skillsmith-staging/` record name it? See this module's fileoverview. */
export type RecoveryPendingChecker = (input: {
  skillsDir: string
  dir: string
  dirName: string
}) => Promise<boolean>

export interface ProbeInput {
  /** Absolute directory being probed (the update target's current location). */
  dir: string
  /** Absolute skills-root directory `dir` lives under — the git walk's upper bound. */
  skillsDir: string
  /** Basename of `dir` — used to build the `.skillsmith-staging/` lookup. */
  dirName: string
  /** Relative POSIX paths this update will touch. SKILL.md is probed regardless of whether it's listed here. */
  writeSet: readonly string[]
  /** Attempts before a missing tracked folder counts as missing. Spec: 3. */
  retryAttempts?: number
  /** Delay between attempts, ms. Spec: 20. */
  retryDelayMs?: number
  /** Injectable sleep so tests never sleep for real. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable staging-record check — see this module's fileoverview. */
  checkRecoveryPending?: RecoveryPendingChecker
}

const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 20
const STAGING_DIRNAME = '.skillsmith-staging'
const STAGING_RESERVED = new Set(['.kept', '.trash', '.quarantine'])

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `err.code`, sanitized to a bounded, known-shape errno string. See fileoverview. */
function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && code ? code : 'UNKNOWN'
}

function sanitizeError(intendedPath: string, err: unknown): ProbeError {
  return { path: intendedPath, errno: errnoOf(err) }
}

type PresenceResult =
  | { status: 'present' }
  | { status: 'missing' }
  | { status: 'error'; error: ProbeError }

/** Rule (missing check): `dir` must exist AND be a directory, and its SKILL.md must exist. A non-directory occupying `dir` is not "missing" (retrying won't fix it) — it is an immediate metadata error. */
async function checkPresence(dir: string, skillMdPath: string): Promise<PresenceResult> {
  try {
    const dirStat = await fs.lstat(dir)
    if (!dirStat.isDirectory()) {
      return { status: 'error', error: { path: dir, errno: 'ENOTDIR' } }
    }
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return { status: 'missing' }
    return { status: 'error', error: sanitizeError(dir, err) }
  }
  try {
    await fs.lstat(skillMdPath)
    return { status: 'present' }
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return { status: 'missing' }
    return { status: 'error', error: sanitizeError(skillMdPath, err) }
  }
}

/**
 * PLACEHOLDER — see this module's fileoverview `.skillsmith-staging/`
 * section. Best-effort scan: read every non-reserved entry directly under
 * `<skillsDir>/.skillsmith-staging/`, parse its `record.json`, and treat the
 * directory as named if any string VALUE anywhere in the parsed record
 * equals `dir` or `dirName`.
 *
 * Fails SAFE, not permissive: any error reading `.skillsmith-staging/`
 * itself, or one op dir's `record.json`, is treated as "not named" (false)
 * — the caller then reports plain `probe-failed` (still blocking) rather
 * than ever reaching a permissive `ok`.
 */
export const defaultRecoveryPendingChecker: RecoveryPendingChecker = async ({
  skillsDir,
  dir,
  dirName,
}) => {
  const stagingDir = path.join(skillsDir, STAGING_DIRNAME)
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(stagingDir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || STAGING_RESERVED.has(entry.name)) continue
    const recordPath = path.join(stagingDir, entry.name, 'record.json')
    let raw: string
    try {
      raw = await fs.readFile(recordPath, 'utf-8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (recordNames(parsed, dir, dirName)) return true
  }
  return false
}

function recordNames(value: unknown, dir: string, dirName: string): boolean {
  if (typeof value === 'string') return value === dir || value === dirName
  if (Array.isArray(value)) return value.some((v) => recordNames(v, dir, dirName))
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((v) => recordNames(v, dir, dirName))
  }
  return false
}

/** Probe one write-set member: lstat, classify its entry type, hash if it's a regular file. Never throws — every failure comes back as `{ error }`. */
async function probeOneFile(
  abs: string,
  rel: string
): Promise<{ file: ProbedFile } | { error: ProbeError }> {
  let st
  try {
    st = await fs.lstat(abs)
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return { file: { rel, sha256: null } }
    return { error: sanitizeError(abs, err) }
  }
  if (st.isSymbolicLink()) return { file: { rel, sha256: null, entryType: 'symlink' } }
  if (st.isDirectory()) return { file: { rel, sha256: null, entryType: 'directory' } }
  if (!st.isFile()) return { file: { rel, sha256: null, entryType: 'other' } }
  try {
    const buf = await fs.readFile(abs)
    return { file: { rel, sha256: createHash('sha256').update(buf).digest('hex') } }
  } catch (err) {
    return { error: sanitizeError(abs, err) }
  }
}

/** Dedupe `writeSet` against a leading `SKILL.md`, preserving first-seen order (determinism). */
function orderedWriteSet(writeSet: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const rel of ['SKILL.md', ...writeSet]) {
    if (seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return out
}

/** A write-set member must resolve inside `dir` — refuses a `..`-escaping or absolute entry rather than reading whatever it points at. */
function isContained(dir: string, abs: string): boolean {
  return abs === dir || abs.startsWith(dir + path.sep)
}

/**
 * Probe one candidate update target. All I/O; no classification decision —
 * see this module's fileoverview.
 */
export async function probeUpdateTarget(input: ProbeInput): Promise<ProbeOutcome> {
  const { dir, skillsDir, dirName, writeSet } = input
  const attempts = input.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS
  const delayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const sleep = input.sleep ?? defaultSleep
  const checkRecoveryPending = input.checkRecoveryPending ?? defaultRecoveryPendingChecker
  const skillMdPath = path.join(dir, 'SKILL.md')

  let missing = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const presence = await checkPresence(dir, skillMdPath)
    if (presence.status === 'present') {
      missing = false
      break
    }
    if (presence.status === 'error') {
      return { kind: 'probe-failed', error: presence.error }
    }
    missing = true
    if (attempt < attempts) await sleep(delayMs)
  }

  if (missing) {
    const pending = await checkRecoveryPending({ skillsDir, dir, dirName })
    if (pending) return { kind: 'recovery-pending' }
    return { kind: 'probe-failed', error: { path: dir, errno: 'ENOENT' } }
  }

  const gitWalk = await hasGitAncestorBetween(dir, skillsDir)
  if (gitWalk !== null && gitWalk.kind === 'error') {
    return { kind: 'probe-failed', error: { path: gitWalk.path, errno: gitWalk.errorCode } }
  }

  const files: ProbedFile[] = []
  let skillMdHash: string | null = null
  for (const rel of orderedWriteSet(writeSet)) {
    const abs = path.join(dir, rel)
    if (!isContained(dir, abs)) {
      return { kind: 'unreadable', error: { path: abs, errno: 'EINVAL' } }
    }
    const probed = await probeOneFile(abs, rel)
    if ('error' in probed) return { kind: 'unreadable', error: probed.error }
    files.push(probed.file)
    if (rel === 'SKILL.md') skillMdHash = probed.file.sha256
  }

  if (skillMdHash === null) {
    // The presence check above just confirmed SKILL.md exists; a null hash
    // here means it vanished in the gap between that check and this read —
    // a fresh miss, not a crash. Report it the same way plain-missing is
    // reported, never as a permissive `ok`.
    return { kind: 'probe-failed', error: { path: skillMdPath, errno: 'ENOENT' } }
  }

  return { kind: 'ok', gitAncestor: gitWalk, skillMdHash, files }
}
