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
 * to collapse it, and five had taken it (SMI-6995 plan, M1/M10).
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
 * - **Producer APIs** — {@link readStateFailSoft}, {@link readEntryForUpdate}
 *   — never fail. A write path that read corrupt state as an error would
 *   become permanently unwritable, and the module could never recover. Both
 *   degrade to an empty/absent read on any failure, by design — never change
 *   either to throw or to report an error.
 * - **The shared primitive** — {@link readRawState} — is neither; it is the
 *   one classification both policies are built from, so the five readers it
 *   replaces keep matching the bridge's own four-way split exactly.
 * - **The recovery primitive** — {@link quarantineCorruptState} — lets a
 *   producer satisfy its own "always overwritable" contract WITHOUT losing
 *   the corrupt bytes. A producer's own overwrite (`writeEntry`'s
 *   `const state = readState(path); state[key] = entry; write(state)`
 *   shape, `reindex-state.ts:135-140` and the same shape in three siblings)
 *   rebuilds the WHOLE file from a fail-soft read — so when that read
 *   degrades to `{}` because the file is corrupt, the next write does not
 *   lose only the key being written, it drops every other key the file
 *   held. These files are keyed by repo path, so a developer with several
 *   worktrees loses all of them, silently, on the next successful run of
 *   ANY one of them. Quarantining the corrupt bytes to a timestamped
 *   sibling path before that overwrite makes the loss recoverable and
 *   loggable instead of silent and total — required before a producer
 *   overwrites corrupt state, not optional.
 */

import { readFileSync, renameSync } from 'node:fs'

// ---- The shared three-way (really four-way) classification --------------

/**
 * The consumer-facing result. Four axes, never collapsed into each other:
 * `missing` ("has not run yet" — the healthy, steady-state case for most of
 * these banners, so it renders nothing) is a DIFFERENT fact from `malformed`
 * (the bytes are there but don't parse, or don't shape up as JSON) or
 * `unreadable` (the bytes could not even be read — permissions, a directory
 * standing where a file is expected, or some other non-ENOENT errno). `ok`
 * carries the validated entry.
 */
export type StateReadResult<T> =
  | { status: 'ok'; entry: T }
  | { status: 'missing' }
  | { status: 'malformed'; detail: string }
  | { status: 'unreadable'; detail: string }

/**
 * The whole-file read both policies are built from. Lifted VERBATIM in
 * semantics from `ruflo-bridge-state.ts`'s private `readRawState` (now
 * deleted there in favor of this one): `ENOENT` is `missing`; any other
 * read errno is `unreadable`, carrying that errno (or the error's own
 * message when the errno is absent); a `JSON.parse` throw is `malformed`,
 * carrying the parse error's message; a value that parses but is falsy, not
 * an object, or an array is also `malformed` — a state file is always a
 * JSON object keyed by repo path, never a bare array or scalar.
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
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
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
 * something about.
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
  const err = validate(candidate)
  if (err) return { status: 'malformed', detail: err }
  return { status: 'ok', entry: candidate as T }
}

// ---- Producer API: never fail ---------------------------------------------

/**
 * Fail-soft whole-state read. `{}` on ANY error — missing, malformed, or
 * unreadable alike. This is what a `writeEntry`-shaped producer reads before
 * merging in the key it is about to write, so a corrupt or absent file never
 * blocks a future write from recovering it. **Never change this to throw or
 * to return a result type** — that would make a corrupt state file
 * permanently unwritable, which is worse than the silent collapse this
 * module exists to fix elsewhere. A caller that overwrites what this
 * returns MUST call {@link quarantineCorruptState} first when the read was
 * not from a genuinely missing file (see that function's own doc comment) —
 * this function cannot tell the caller that itself, because it has already
 * thrown the distinction away by design; use {@link readRawState} directly
 * when the caller needs to know WHY before deciding whether to quarantine.
 */
export function readStateFailSoft<S extends object>(path: string): S {
  const raw = readRawState<S>(path)
  return raw.ok ? raw.state : ({} as S)
}

/**
 * The producer's read-modify-write counterpart to {@link readEntryResult}:
 * same `validate` contract, but it never fails and it tells the caller
 * whether it is about to discard history rather than silently doing so.
 *
 * `priorWasCorrupt` is `true` exactly when the file OR this key's own entry
 * could not be read cleanly — a malformed/unreadable whole file (every key's
 * history is at risk, not just this one — see {@link quarantineCorruptState}
 * for why that matters) OR an entry present but rejected by `validate`. It
 * is `false` for a genuinely missing file and for a file that parses fine
 * but simply has never had this key — neither of those is a loss, there was
 * nothing there to lose. A caller that sees `priorWasCorrupt: true` should
 * log that it is discarding prior history before overwriting (SMI-6995 plan
 * review finding 2) rather than proceeding silently.
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
  const err = validate(candidate)
  if (err) return { entry: null, priorWasCorrupt: true }
  return { entry: candidate as T, priorWasCorrupt: false }
}

/**
 * Quarantines corrupt state before a producer overwrites it: renames `path`
 * to `${path}.corrupt-<ISO, colons and dots replaced with dashes>` and
 * returns the new path, so the bytes survive instead of being silently
 * replaced by the producer's own recovery write.
 *
 * **Required before any producer overwrites state it read as malformed or
 * unreadable — never optional.** `writeEntry`'s whole-file-rebuild shape
 * (`const state = readStateFailSoft(path); state[key] = entry; write(state)`)
 * drops every OTHER key in the file when the read degrades to `{}`, not just
 * the one being written (this module's own top-of-file doc comment has the
 * full blast-radius accounting) — these state files are keyed by repo path,
 * so a developer with several worktrees loses every one of them, silently,
 * the next time any single one of them next writes successfully. Quarantine
 * first and the loss becomes a sibling file on disk and a log line instead.
 *
 * **Must never throw — this runs on a recovery path inside a hook**, where
 * an exception would turn "repair a corrupt file" into "crash the write
 * that was trying to repair it." Returns `null`, not an error, for both "the
 * path doesn't exist" (ENOENT — nothing to quarantine; a producer sees this
 * on a genuinely missing file, which never had corrupt bytes to move in the
 * first place) and "the rename itself failed" (permissions, cross-device,
 * anything else) — a caller that gets `null` proceeds with its own recovery
 * write regardless, exactly as it would have before this function existed;
 * quarantine is a best-effort improvement on that path, not a precondition
 * for it.
 */
export function quarantineCorruptState(path: string): string | null {
  const dest = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    renameSync(path, dest)
    return dest
  } catch {
    return null
  }
}

// ---- internal helpers ------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
