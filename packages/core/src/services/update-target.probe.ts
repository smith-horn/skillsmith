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
 *     one of `dir`, `skillMdPath`, a `writeSet` member joined onto `dir`, or
 *     (F3: an absolute write-set entry, refused before `path.join` so it is
 *     never silently re-rooted under `dir`) the caller-supplied absolute path
 *     itself — filesystem paths the caller already owns, never file content.
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
 * `.skillsmith-staging/` RECORD CHECK: §4.2 says a missing tracked folder
 * named by a `.skillsmith-staging/` record is `recovery-pending`, not
 * plain-missing. The default implementation of that check
 * (`defaultRecoveryPendingChecker`, a documented A1-placeholder — see its
 * own module, `update-target.probe.recovery.ts`, for the full ambiguity
 * writeup) lives in a sibling file, re-exported from here; this module only
 * owns the injectable seam (`ProbeInput.checkRecoveryPending`) and the call
 * site that invokes it.
 */

import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'

import { hasGitAncestorBetween, type GitWalkResult } from './skill-installation.target-guard.js'
import { isRealpathInside } from './skill-installation.realpath-containment.js'
import { defaultRecoveryPendingChecker } from './update-target.probe.recovery.js'

/** Re-exported so `update-target.probe.ts` remains the one public import
 * point for this probe's whole surface — the implementation lives in
 * `update-target.probe.recovery.ts` (a documented A1-placeholder; see that
 * module's fileoverview). */
export { defaultRecoveryPendingChecker }

/** Sanitized `{ path, errno }` — see this module's fileoverview. */
export interface ProbeError {
  path: string
  errno: string
}

/** The `hasGitAncestorBetween` result kind this probe ever surfaces inside an `ok` outcome — a real `.git` ancestor. A `kind: 'error'` walk result short-circuits into `probe-failed` instead and never reaches here. */
export type ProbeGitAncestorFound = Extract<GitWalkResult, { kind: 'found' }>

/**
 * Three-state git-ancestor result — `found` and `none` both mean the walk
 * RAN and reached a conclusive answer; `undetermined` means it did NOT run
 * at all.
 *
 * `hasGitAncestorBetween` bounds its walk at `skillsDir`'s own realpath, but
 * its own doc comment states that bound is safe only as a PRECONDITION the
 * caller has already proven ("rule (c) has already proven a symlinked
 * `installPath`'s realpath resolves inside (real) `skillsDir` before this
 * ever runs") — `hasGitAncestorBetween` does not verify this itself. A prior
 * fix here made `checkPresence` follow a symlinked `dir` to a directory
 * (matching rule (c)'s FIRST clause) but never checked the SECOND clause
 * (realpath containment) before calling `hasGitAncestorBetween` anyway. For
 * a symlink whose realpath resolves OUTSIDE `skillsDir` — the shipped
 * `fan-out.ts:224-226` relative-symlink shape (e.g. `~/.cursor/skills/<skill>`
 * -> `../../.claude/skills/<skill>`) is exactly this, not a hypothetical
 * attack — the walk's stop condition (`current === stopAtAbs`) is never met,
 * so it climbs ancestors until its own 64-iteration cap or the filesystem
 * root, and can report a `.git` far outside `skillsDir` (e.g. at `$HOME`) as
 * a legitimate ancestor.
 *
 * `undetermined` is the fix: when {@link isRealpathInside} says `dir`'s
 * realpath does not resolve inside `skillsDir`, the walk is never called at
 * all — `undetermined` is reported instead. It is NOT a permissive "no git
 * repo found" (that is `none`); it means "the walk that would tell us was
 * never run," and it is what the classifier (not this probe) must decide
 * what to do with — see §4.3 row 10 / UD22 ("one folder, several manifest
 * keys") in the design doc. The probe reports; it never decides.
 */
export type ProbeGitAncestor =
  | ProbeGitAncestorFound
  | { kind: 'none' }
  | { kind: 'undetermined'; reason: 'realpath-escapes-skills-dir' }

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
  /** Never `null` — see {@link ProbeGitAncestor}'s own doc comment for the three states and why there is deliberately no permissive default for "the walk didn't run." */
  gitAncestor: ProbeGitAncestor
  /** sha256 of SKILL.md's current raw bytes — duplicated into `files` too, exposed directly since the retry rule is keyed on SKILL.md specifically. `null` when SKILL.md exists but is not a regular file (a symlink, a directory, or another non-regular type) — check `skillMdEntryType` (or, equivalently, `files[0].entryType`; SKILL.md is always first) to tell that case apart. A genuinely missing/unreadable SKILL.md never reaches `ok` at all; it is `probe-failed` or `unreadable` instead. */
  skillMdHash: string | null
  /** Set only when `skillMdHash` is `null` — the reason it's null, placed on THIS SAME object so a `null` hash can never be read bare, one level removed from its own explanation in `files[0]`. This module's fileoverview (THE CENTRAL PROPERTY) names exactly that shape — `hasRecordedLocalEdit` (`skill-identity-classification.ts`) reading a bare `null` local hash as "no edit evidence, safe to overwrite" — as the permissive-value-from-undetermined-state bug this probe exists to remove; a type change from `string` to `string | null` on `skillMdHash` alone would let `if (!probe.skillMdHash)` compile silently past that same shape one level down. */
  skillMdEntryType?: 'symlink' | 'directory' | 'other'
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

/** Rule (missing check): `dir` must exist AND be a directory, and its SKILL.md must exist. A non-directory occupying `dir` is not "missing" (retrying won't fix it) — it is an immediate metadata error.
 *
 * `dir` is `stat`'d (follows symlinks), never `lstat`'d — a fan-out-symlinked
 * skill directory (`fan-out.ts:226`'s `fsp.symlink(relTarget, staged, 'dir')`)
 * is a shipped install shape, and `skill-installation.target-guard.ts`'s own
 * `isUsableDirectory` rule (c) already treats "a symlink that resolves to a
 * directory inside `skillsDir`" as usable — this probe must classify the
 * same shape the same way, not fabricate an `ENOTDIR` no syscall produced
 * (an `lstat` on a symlink-to-directory reports the symlink itself, never a
 * directory). Following the link also makes the git walk below reachable
 * through it: `hasGitAncestorBetween`'s realpath branch runs whenever `dir`'s
 * realpath differs from its lexical path — which this check letting a
 * symlinked `dir` past is ONE way to reach (measured: it also runs for a
 * perfectly ordinary, non-symlink `dir` whose LEXICAL ANCESTOR is a symlink,
 * since `fs.realpath` resolves every path component, not just the final
 * one — this check says nothing about that case one way or the other). A
 * broken symlink correctly falls into the retry/missing path below (`stat`
 * reports `ENOENT` for a symlink whose target is gone); a real non-directory
 * file still fails `isDirectory()` with a genuine `ENOTDIR`.
 */
async function checkPresence(dir: string, skillMdPath: string): Promise<PresenceResult> {
  try {
    const dirStat = await fs.stat(dir)
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

/** Dedupe `writeSet` against a leading `SKILL.md`, preserving first-seen order
 * (determinism). Dedupes by NORMALIZED path, not the raw string —
 * `'./SKILL.md'` and `'SKILL.md'` name the same file and must collapse to
 * one probed entry with one hash, not two `files` rows where only the
 * literal `'SKILL.md'` spelling ever populates `skillMdHash`. This does NOT
 * collapse every equivalent spelling: `path.normalize` strips a leading
 * `./` and redundant/internal separators, but a TRAILING separator survives
 * (`path.normalize('SKILL.md/')` -> `'SKILL.md/'`, measured), so that spells
 * a second, undeduped row. That's deliberately left as-is rather than
 * stripped: a trailing separator asserts "this must be a directory" to
 * `lstat` on some platforms, a genuinely different filesystem question than
 * the bare name — collapsing it would hide a case where the two entries can
 * legitimately behave differently. The extra row is fail-closed (an
 * unnecessary probe, never a missed one), not a regression. */
function orderedWriteSet(writeSet: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ['SKILL.md', ...writeSet]) {
    const rel = path.normalize(raw)
    if (seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return out
}

/** A write-set member must resolve inside `dir` — refuses a `..`-escaping
 * entry rather than reading whatever it points at. An ABSOLUTE entry is
 * refused earlier, by the caller, before it ever reaches `path.join`:
 * joining an absolute path onto `dir` silently DISCARDS `dir`
 * (`path.join('/root/skill', '/etc/passwd')` -> `'/root/skill/etc/passwd'`),
 * so this containment check alone would pass on a path it never actually
 * contained, and the `rel` reported back would describe different bytes
 * than the ones hashed. */
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
    // The default checker never throws (it fails safe to `false`
    // internally), but an INJECTED `checkRecoveryPending` (`ProbeInput`) is
    // caller-supplied and can reject — the only uncaught surface left in
    // this probe. Contain it the same way every other failure mode here is
    // contained: a seam crash fails CLOSED into `probe-failed`, never
    // propagates past this function as an unhandled rejection.
    let pending: boolean
    try {
      pending = await checkRecoveryPending({ skillsDir, dir, dirName })
    } catch (err) {
      return { kind: 'probe-failed', error: sanitizeError(dir, err) }
    }
    if (pending) return { kind: 'recovery-pending' }
    // `path: dir` here names an entry that, for the dangling-symlink case
    // (F1), DOES still exist on disk — `dir` is the symlink itself, which
    // `readdir`/`ls` on its parent would still list. The ENOENT describes
    // its TARGET (what `stat` tried to follow and couldn't), not `dir`'s own
    // presence. Don't read this as a second, fabricated "no such entry" on
    // top of a real one — it's the same single failure `checkPresence`
    // already observed, reported through the one path this probe ever names.
    return { kind: 'probe-failed', error: { path: dir, errno: 'ENOENT' } }
  }

  // Finding SMI-6532 (round following A0.6): `hasGitAncestorBetween` may
  // only be called once its precondition — `dir`'s realpath resolves inside
  // `skillsDir` — is PROVEN, never assumed. `checkPresence` above (F1) only
  // proved `dir` follows to A directory; it never proved that directory is
  // inside `skillsDir`. Without this check, a symlink whose realpath escapes
  // `skillsDir` (the shipped `fan-out.ts:224-226` shape) makes the walk's
  // stop condition unreachable, and it climbs ancestors until its own
  // 64-iteration cap or the filesystem root — see `ProbeGitAncestor`'s own
  // doc comment for the full mechanism and why the escaping case reports
  // `undetermined`, never `probe-failed` (that would erase F1's benefit for
  // every in-bounds symlinked target) and never a bare `null`/`none` (that
  // would be exactly the permissive-value-from-undetermined-state shape this
  // module's fileoverview says it exists to remove).
  let gitAncestor: ProbeGitAncestor
  if (await isRealpathInside(dir, skillsDir)) {
    const gitWalk = await hasGitAncestorBetween(dir, skillsDir)
    if (gitWalk !== null && gitWalk.kind === 'error') {
      return { kind: 'probe-failed', error: { path: gitWalk.path, errno: gitWalk.errorCode } }
    }
    gitAncestor = gitWalk ?? { kind: 'none' }
  } else {
    gitAncestor = { kind: 'undetermined', reason: 'realpath-escapes-skills-dir' }
  }

  const files: ProbedFile[] = []
  let skillMdFile: ProbedFile | undefined
  for (const rel of orderedWriteSet(writeSet)) {
    // Refuse an absolute entry BEFORE `path.join`, not after: joining one
    // onto `dir` discards `dir` and produces a path that WOULD pass the
    // containment check below, hashing bytes at a location the reported
    // `rel` disagrees with (§4.2, F3).
    if (path.isAbsolute(rel)) {
      return { kind: 'unreadable', error: { path: rel, errno: 'EINVAL' } }
    }
    const abs = path.join(dir, rel)
    if (!isContained(dir, abs)) {
      return { kind: 'unreadable', error: { path: abs, errno: 'EINVAL' } }
    }
    const probed = await probeOneFile(abs, rel)
    if ('error' in probed) return { kind: 'unreadable', error: probed.error }
    files.push(probed.file)
    if (rel === 'SKILL.md') skillMdFile = probed.file
  }

  // orderedWriteSet always puts a normalized 'SKILL.md' first, so the loop
  // above always ran probeOneFile for it — this branch is defensive, not a
  // real path through the code.
  if (skillMdFile === undefined) {
    return { kind: 'probe-failed', error: { path: skillMdPath, errno: 'ENOENT' } }
  }

  if (skillMdFile.sha256 === null && skillMdFile.entryType === undefined) {
    // The presence check above just confirmed SKILL.md exists as SOME
    // filesystem entry; a null hash with NO entryType means probeOneFile's
    // own lstat hit ENOENT — it vanished in the gap between that check and
    // this read, a fresh miss, not a crash. Report it the same way
    // plain-missing is reported, never as a permissive `ok`.
    //
    // A null hash WITH an entryType (symlink/directory/other) is a
    // DIFFERENT case: SKILL.md exists but isn't a regular file. That is
    // data for the (pure) classifier to route into §4.3 row 12
    // (`unsupported-entry`), not a probe failure — it falls through to `ok`
    // below with `skillMdHash: null` and the type preserved on
    // `skillMdEntryType` (and, equivalently, `files[0].entryType`).
    return { kind: 'probe-failed', error: { path: skillMdPath, errno: 'ENOENT' } }
  }

  return {
    kind: 'ok',
    gitAncestor,
    skillMdHash: skillMdFile.sha256,
    skillMdEntryType: skillMdFile.entryType,
    files,
  }
}
