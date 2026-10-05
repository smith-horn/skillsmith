/**
 * SMI-6995 — the shared three-way state-file read, lifted out of
 * `ruflo-bridge-state.ts`'s own private `readRawState` (the one reader of
 * the six session-priming state consumers that got this right from the
 * start) and made generic so the other five readers — `reindex-state.ts`,
 * `liveness-state.ts`, `autoheal-state.ts`, `mcp-disconnect-state.ts`,
 * `probe.ts` — can delegate to ONE implementation instead of each carrying
 * its own copy of a `try { readFileSync + JSON.parse } catch { return {} }`
 * block that collapses "never written", "corrupt" and "could not be read"
 * into the same silent null. Six implementations of one read is six chances
 * to collapse it, and five had taken it (SMI-6995 plan, M1/M10). Wave 2
 * wires the functions below into those five modules; this file (Wave 1) is
 * not yet called from production — only its own tests exercise it today.
 *
 * ## The invariant this module exists to hold, stated once
 *
 * A producer must always be able to overwrite corrupt state. A consumer must
 * never render corrupt state as healthy. **No function below serves both.**
 * These are two reads of the SAME file with OPPOSITE failure policies, and
 * conflating them is the exact mistake this plan's own first draft made
 * (review finding 2) — "fail-soft so a corrupt file recovers" cannot coexist
 * with "a malformed read must not look like no-prior-run" inside one
 * function. So the names below say which policy they carry, not just what
 * they read:
 *
 * - **Consumer APIs** — {@link readEntryResult} — report the failure. A
 *   malformed or unreadable file renders a banner line naming the fault,
 *   because a corrupt state file is usually itself a symptom, and the
 *   banners exist precisely to surface what a developer cannot otherwise
 *   see. Silent only on genuine absence (`missing` — "has not run yet").
 * - **Producer APIs** — {@link readEntryForUpdate},
 *   {@link readStateWithClassification} — never fail on the READ half (see
 *   each one's own doc comment for exactly what that promise does and does
 *   not cover). A write path that read corrupt state as an error would
 *   become permanently unwritable, and the module could never recover.
 * - **The shared primitive** — {@link readRawState} — is neither; it is the
 *   one classification both policies are built from, so the five readers it
 *   replaces keep matching the bridge's own four-way split exactly.
 * - **The recovery primitives** — {@link quarantineCorruptState} and its
 *   single-call writer counterpart {@link writeEntryWithRecovery} (both
 *   defined in `state-read.quarantine.ts` and re-exported here — see that
 *   file's own top comment for why) — let a producer satisfy its own
 *   "always overwritable" contract WITHOUT losing the corrupt bytes, and
 *   without the gap between "we noticed it's corrupt" and "we did something
 *   about it" that a caller doing those as two separate steps would leave
 *   open for another process to land in.
 *
 * ## SMI-6995 round-2 adversarial review — this file answers all 12 findings
 *
 * Findings 1 (validator-throw), 5 (null-vs-undefined), 9 (weak assertions)
 * and 12 (unbounded read) are answered in place below, in
 * {@link readRawState}, {@link readEntryResult} and {@link readEntryForUpdate}.
 * Findings 3 and 4 are structural: `readStateFailSoft` — the original
 * producer whole-state read — is GONE. It returned `{}` on every failure
 * and threw away WHY, so a caller had no way to know it needed to
 * quarantine before overwriting — the exact silent-discard shape this whole
 * module exists to remove, reproduced one layer down inside its own first
 * draft. {@link readStateWithClassification} replaces it as the ONLY
 * whole-state producer read, so the signal cannot be lost at a call site.
 * {@link writeEntryWithRecovery} closes the read-then-quarantine TOCTOU by
 * doing read + quarantine + merge + atomic write as ONE call. Findings 2, 7
 * and 8 (quarantine destination exclusivity, directory refusal, symlink
 * refusal) live in `state-read.quarantine.ts`, re-exported from here so
 * every caller still imports from this one path — the split exists only to
 * stay under CLAUDE.md's 500-line pre-commit gate, not a semantic boundary.
 * Findings 10 and 11 were reviewed as sound; nothing changed for them.
 */

import { readFileSync, statSync } from 'node:fs'

export {
  quarantineCorruptState,
  writeEntryWithRecovery,
  QUARANTINE_DEST_MAX_ATTEMPTS,
} from './state-read.quarantine.js'

// ---- The shared three-way (really four-way) classification --------------

/**
 * The consumer-facing result. Four axes, never collapsed into each other:
 * `missing` ("has not run yet" — the healthy, steady-state case for most of
 * these banners, so it renders nothing) is a DIFFERENT fact from `malformed`
 * (the bytes are there but don't parse, or don't shape up as JSON) or
 * `unreadable` (the bytes could not even be read — permissions, a directory
 * standing where a file is expected, the size ceiling below, or some other
 * non-ENOENT errno). `ok` carries the validated entry.
 */
export type StateReadResult<T> =
  | { status: 'ok'; entry: T }
  | { status: 'missing' }
  | { status: 'malformed'; detail: string }
  | { status: 'unreadable'; detail: string }

/**
 * Hard ceiling on how large a state file {@link readRawState} will read,
 * checked via `statSync` BEFORE any `readFileSync`/`JSON.parse` call
 * (SMI-6995 finding 12 — this read runs synchronously on a `SessionStart`
 * hook path, where an unbounded read of a huge or attacker-controlled file
 * could stall the hook or exhaust memory). These files hold a handful of
 * small JSON entries keyed by repo path — a real entry is low hundreds of
 * bytes, so even a few hundred concurrent worktrees land nowhere near six
 * figures of total bytes. 1 MiB is roughly three orders of magnitude over
 * that realistic ceiling: generous enough that no legitimate state file
 * ever trips it, while still bounding the worst case.
 */
export const MAX_STATE_FILE_BYTES = 1_048_576 // 1 MiB

/**
 * The whole-file read both policies are built from. Lifted VERBATIM in
 * semantics from `ruflo-bridge-state.ts`'s private `readRawState` (now
 * deleted there in favor of this one): `ENOENT` is `missing`; any other
 * read errno is `unreadable`, carrying that errno (or the error's own
 * message when the errno is absent); a file over {@link MAX_STATE_FILE_BYTES}
 * is `unreadable` WITHOUT being read at all (finding 12); a `JSON.parse`
 * throw is `malformed`, carrying the parse error's message; a value that
 * parses but is falsy, not an object, or an array is also `malformed` — a
 * state file is always a JSON object keyed by repo path, never a bare array
 * or scalar.
 *
 * `S extends object` (not `unknown`): every caller's state shape is a
 * `Record<string, Entry>`, and requiring `object` here is what lets the
 * `Array.isArray`/typeof guard below double as the type guard that narrows
 * `unknown` to `S` on the `ok` branch — there is no runtime check possible
 * beyond "parsed to a non-array object," so the generic can promise no more
 * than that either.
 */
export function readRawState<S extends object>(
  path: string
):
  | { ok: true; state: S }
  | { ok: false; kind: 'missing' | 'malformed' | 'unreadable'; detail: string } {
  // `statSync` first, deliberately BEFORE any read of the bytes — this is
  // what lets the size ceiling below reject an oversized file without ever
  // calling `readFileSync` on it (finding 12). Its own ENOENT/other-errno
  // handling mirrors the `readFileSync` catch below exactly, because the
  // file can legitimately not exist at this step too.
  let size: number
  try {
    size = statSync(path).size
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT')
      return { ok: false, kind: 'missing', detail: 'state file does not exist' }
    return { ok: false, kind: 'unreadable', detail: code ?? errMessage(err) }
  }
  if (size > MAX_STATE_FILE_BYTES) {
    return {
      ok: false,
      kind: 'unreadable',
      detail: `state file is ${size} bytes, over the ${MAX_STATE_FILE_BYTES}-byte limit — refusing to read without parsing (SMI-6995 finding 12)`,
    }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    // Re-handles ENOENT/other-errno here too: a TOCTOU window exists between
    // the `statSync` above and this read (e.g. the file is deleted in
    // between) — rare, but the fallback must classify it the same way the
    // first check would have, not throw or report something unexpected.
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT')
      return { ok: false, kind: 'missing', detail: 'state file does not exist' }
    return { ok: false, kind: 'unreadable', detail: code ?? errMessage(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, kind: 'malformed', detail: `state file does not parse: ${errMessage(err)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, kind: 'malformed', detail: 'state file is not a JSON object' }
  }
  return { ok: true, state: parsed as S }
}

// ---- Consumer API: report the failure -------------------------------------

/**
 * The consumer entry point for a single keyed entry. `validate` checks every
 * field a renderer actually reads (a `typeof` spot-check accepts garbage
 * like `{lastVerdict: "banana"}`, which then reads as `ok` and renders
 * nothing — the exact collapse this module exists to remove, recreated one
 * layer down; SMI-6995 plan review finding 1) and returns an error string,
 * or `null` when the candidate is valid. A `missing` result covers BOTH "the
 * file itself is absent" and "the file is fine but this key isn't in it" —
 * those are the same fact to a caller deciding whether to render ("has not
 * run yet"), unlike `malformed`/`unreadable`, which are always worth saying
 * something about. A present entry whose value is literally JSON `null` is
 * also `missing`, not `malformed` (finding 5 — `candidate === undefined ||
 * candidate === null`, not `undefined` alone: the two mean the same thing
 * to a caller, "there is nothing usable here yet," and only one of them is
 * reachable by writing JSON at all).
 *
 * `validate` is caller-supplied and therefore untrusted to behave: a
 * throwing validator must not take down the "never fails" promise this
 * function makes to its own callers (finding 1) — caught and reported as
 * `malformed`, naming that the validator itself threw.
 */
export function readEntryResult<T>(
  key: string,
  path: string,
  validate: (candidate: unknown) => string | null
): StateReadResult<T> {
  const raw = readRawState<Record<string, unknown>>(path)
  if (!raw.ok) {
    if (raw.kind === 'missing') return { status: 'missing' }
    return { status: raw.kind, detail: raw.detail }
  }
  const candidate = raw.state[key]
  if (candidate === undefined || candidate === null) return { status: 'missing' }
  let err: string | null
  try {
    err = validate(candidate)
  } catch (thrown) {
    return { status: 'malformed', detail: `validator itself threw: ${errMessage(thrown)}` }
  }
  if (err) return { status: 'malformed', detail: err }
  return { status: 'ok', entry: candidate as T }
}

// ---- Producer API: never fail on the read half -----------------------------

/**
 * The producer's read-modify-write counterpart to {@link readEntryResult}:
 * same `validate` contract (including the finding-1 try/catch around it —
 * see that function's doc comment), but it never fails and it tells the
 * caller whether it is about to discard history rather than silently doing
 * so.
 *
 * `priorWasCorrupt` is `true` exactly when the file OR this key's own entry
 * could not be read cleanly — a malformed/unreadable whole file (every key's
 * history is at risk, not just this one — see {@link quarantineCorruptState}
 * for why that matters), a present entry rejected by `validate`, OR a
 * `validate` call that itself threw (finding 1). It is `false` for a
 * genuinely missing file, for a file that parses fine but simply has never
 * had this key, and for a present entry whose value is literally JSON
 * `null` (finding 5 — same `undefined`-or-`null` test as
 * {@link readEntryResult}, so the two functions never disagree about what
 * counts as "nothing here yet" for the same file) — none of those is a
 * loss, there was nothing there to lose. A caller that sees
 * `priorWasCorrupt: true` should log that it is discarding prior history
 * before overwriting (SMI-6995 plan review finding 2) rather than
 * proceeding silently.
 */
export function readEntryForUpdate<T>(
  key: string,
  path: string,
  validate: (candidate: unknown) => string | null
): { entry: T | null; priorWasCorrupt: boolean } {
  const raw = readRawState<Record<string, unknown>>(path)
  if (!raw.ok) {
    // A genuinely missing file has nothing to lose; a malformed/unreadable
    // one puts every key in the file at risk, not just this one.
    return { entry: null, priorWasCorrupt: raw.kind !== 'missing' }
  }
  const candidate = raw.state[key]
  if (candidate === undefined || candidate === null) return { entry: null, priorWasCorrupt: false }
  let err: string | null
  try {
    err = validate(candidate)
  } catch {
    return { entry: null, priorWasCorrupt: true }
  }
  if (err) return { entry: null, priorWasCorrupt: true }
  return { entry: candidate as T, priorWasCorrupt: false }
}

/**
 * The producer's whole-state read, replacing the old `readStateFailSoft`
 * (SMI-6995 finding 3 — removed from this module's public surface
 * entirely, not deprecated-in-place, because leaving it reachable would
 * leave the exact defect it names reachable too). `readStateFailSoft`
 * returned `{}` on every failure and threw away WHY, so a caller physically
 * could not know it needed to quarantine before overwriting. This function
 * is now the ONLY whole-state producer read, so a caller cannot lose the
 * signal by forgetting a step: `classification` is always present, and
 * `needsQuarantine` is a derived convenience — `true` for `malformed` and
 * `unreadable`, `false` for `ok`/`missing` — specifically so a caller does
 * not have to re-derive that policy itself and get it wrong at one of
 * several call sites (there will be five, once Wave 2 wires this in).
 * `state` is always a usable `S` (`{}` when the file could not be read), so
 * a caller can merge into it unconditionally without its own null check;
 * `detail` is `null` only when `classification` is `'ok'`.
 *
 * Never throws, matching the function it replaces — see {@link readRawState}
 * for why a corrupt read must never become an exception on this path. A
 * caller that wants to ALSO quarantine before overwriting should prefer
 * {@link writeEntryWithRecovery}, which does the read, the quarantine, the
 * merge and the atomic write as one call so another process cannot
 * interleave between them (finding 4) — use this function directly only
 * when the caller needs the classification without writing anything yet.
 */
export function readStateWithClassification<S extends object>(
  path: string
): {
  state: S
  classification: 'ok' | 'missing' | 'malformed' | 'unreadable'
  detail: string | null
  needsQuarantine: boolean
} {
  const raw = readRawState<S>(path)
  if (raw.ok) {
    return { state: raw.state, classification: 'ok', detail: null, needsQuarantine: false }
  }
  return {
    state: {} as S,
    classification: raw.kind,
    detail: raw.detail,
    needsQuarantine: raw.kind === 'malformed' || raw.kind === 'unreadable',
  }
}

// ---- internal helpers ------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
