/**
 * SMI-6995 — the shared three-way state-file read, lifted out of
 * `ruflo-bridge-state.ts`'s own private `readRawState` (the one reader of
 * the six session-priming state consumers that got this right from the
 * start) and made generic so the other readers — `reindex-state.ts`,
 * `liveness-state.ts`, `autoheal-state.ts`, `mcp-disconnect-state.ts`,
 * `probe.ts` — delegate to ONE implementation instead of each carrying
 * its own `try { readFileSync + JSON.parse } catch { return {} }` block that
 * collapses "never written", "corrupt" and "could not be read" into the
 * same silent null.
 *
 * ## The invariant this module exists to hold
 *
 * A producer must always be able to overwrite corrupt state. A consumer must
 * never render corrupt state as healthy. **No function below serves both.**
 * They are two reads of the SAME file with OPPOSITE failure policies, so the
 * names say which policy they carry:
 *
 * - **Consumer API** — {@link readEntryResult} — reports the failure. A
 *   malformed or unreadable file renders a banner line naming the fault.
 *   Genuine absence (`missing`) is its own status, never a fault; whether it
 *   renders anything is each renderer's and each caller's decision.
 * - **Producer APIs** — {@link readEntryForUpdate},
 *   {@link readStateWithClassification} — never fail on the READ half (see
 *   each one's own doc comment for exactly what that promise covers). A
 *   write path that read corrupt state as an error would become permanently
 *   unwritable.
 * - **The shared primitive** — {@link readRawState} — is neither; it is the
 *   one classification both policies are built from.
 *
 * A recovery writer (copy corrupt bytes aside, then atomically overwrite)
 * was removed from this module because nothing in production called it;
 * SMI-7041 is where it would return, with its first caller.
 *
 * ## Reader properties pinned by tests
 *
 * - `readRawState` opens `path` exactly ONCE; the size check (`fstatSync`)
 *   and the bounded read both run against that descriptor, so there is no
 *   second name resolution for a replacement to race, and the descriptor is
 *   closed on every return path.
 * - `errMessage` cannot itself throw, even for a thrown plain string,
 *   `null`, or an object whose own `toString` throws, so a misbehaving
 *   caller-supplied `validate` cannot break this module's never-throws
 *   promise.
 * - Assertions pin classification plus a non-empty explanation, not literal
 *   wording that no consumer reads.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

// ---- The shared three-way (really four-way) classification --------------

/**
 * The consumer-facing result. Four axes, never collapsed into each other:
 * `missing` ("has not run yet" — the healthy, steady-state case for most of
 * these banners; whether anything renders for it is the renderer's and its
 * caller's choice, see this file's top comment) is a DIFFERENT fact from `malformed`
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
 * checked via `fstatSync` on an already-open descriptor BEFORE any
 * `readSync`/`JSON.parse` call (SMI-6995 finding 12, round 2 — this read
 * runs synchronously on a `SessionStart` hook path, where an unbounded read
 * of a huge or attacker-controlled file could stall the hook or exhaust
 * memory). These files hold a handful of small JSON entries keyed by repo
 * path — a real entry is low hundreds of bytes, so even a few hundred
 * concurrent worktrees land nowhere near six figures of total bytes. 1 MiB
 * is roughly three orders of magnitude over that realistic ceiling:
 * generous enough that no legitimate state file ever trips it, while still
 * bounding the worst case.
 */
export const MAX_STATE_FILE_BYTES = 1_048_576 // 1 MiB

/**
 * The whole-file read both policies are built from. Lifted VERBATIM in
 * classification semantics from `ruflo-bridge-state.ts`'s private
 * `readRawState` (now deleted there in favor of this one): `ENOENT` is
 * `missing`; any other open/stat/read errno is `unreadable`, carrying that
 * errno (or the error's own message when the errno is absent); a file over
 * {@link MAX_STATE_FILE_BYTES} is `unreadable` WITHOUT being read at all
 * (finding 12, round 2); a `JSON.parse` throw is `malformed`, carrying the
 * parse error's message; a value that parses but is falsy, not an object,
 * or an array is also `malformed` — a state file is always a JSON object
 * keyed by repo path, never a bare array or scalar.
 *
 * **Single descriptor, open to close (SMI-6995 round-4 finding 4).** `path`
 * is opened exactly once. The size check (`fstatSync`) and the bounded read
 * below both run against that one descriptor — never a second
 * `statSync(path)`/`readFileSync(path)` pair that re-resolves the pathname
 * and can therefore observe a DIFFERENT file than the one just measured if
 * anything changes what `path` points at in between. The descriptor is
 * closed in a `finally` so every return path — classification success,
 * every failure branch, even a `closeSync` that itself throws (swallowed;
 * this function must never throw) — closes it exactly once.
 *
 * The read itself asks for at most `MAX_STATE_FILE_BYTES + 1` bytes, in a
 * loop that keeps requesting more only while the previous `readSync` call
 * returned a nonzero count (a single `read(2)` on a regular file is allowed
 * to return fewer bytes than requested even when more remain) — so this
 * function never buffers more than one byte over the limit regardless of
 * the file's real size, and still correctly reads a file right at the
 * boundary.
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
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT')
      return { ok: false, kind: 'missing', detail: 'state file does not exist' }
    return { ok: false, kind: 'unreadable', detail: code ?? errMessage(err) }
  }
  try {
    let size: number
    try {
      size = fstatSync(fd).size
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      return { ok: false, kind: 'unreadable', detail: code ?? errMessage(err) }
    }
    if (size > MAX_STATE_FILE_BYTES) {
      return {
        ok: false,
        kind: 'unreadable',
        detail: `state file is ${size} bytes, over the ${MAX_STATE_FILE_BYTES}-byte limit — refusing to read without parsing (SMI-6995 finding 12)`,
      }
    }

    const buf = Buffer.alloc(MAX_STATE_FILE_BYTES + 1)
    let total = 0
    while (total < buf.length) {
      let n: number
      try {
        n = readSync(fd, buf, total, buf.length - total, total)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        return { ok: false, kind: 'unreadable', detail: code ?? errMessage(err) }
      }
      if (n === 0) break // EOF — the file is no larger than what we already have
      total += n
    }
    if (total > MAX_STATE_FILE_BYTES) {
      // Only reachable if the file grew to fill the whole MAX+1 buffer
      // between the fstat above and this read loop finishing — the same
      // single-descriptor read still bounds how much we ever buffer, so
      // this is reported the same way the upfront size check reports it.
      return {
        ok: false,
        kind: 'unreadable',
        detail: `state file grew past the ${MAX_STATE_FILE_BYTES}-byte limit between the size check and the read — refusing to read further (SMI-6995 finding 4)`,
      }
    }

    const raw = buf.toString('utf8', 0, total)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return {
        ok: false,
        kind: 'malformed',
        detail: `state file does not parse: ${errMessage(err)}`,
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, kind: 'malformed', detail: 'state file is not a JSON object' }
    }
    return { ok: true, state: parsed as S }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // Never let a close failure override a classification already
      // computed above, or escape this function's own never-throws
      // contract — the fd was opened read-only and is being discarded
      // either way.
    }
  }
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
 * `malformed`, naming that the validator itself threw. `errMessage` below is
 * what renders that thrown value into text; it is itself hardened (SMI-6995
 * round-4 finding 5) so a validator that throws something hostile — a plain
 * string, `null`, or an object whose own `toString` throws — still cannot
 * escape as an uncaught exception from HERE either.
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
 * history is at risk, not just this one), a present entry rejected by `validate`, OR a
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
 * not have to re-derive that policy itself and get it wrong at a call site.
 * `state` is always a usable `S` (`{}` when the file could not be read), so
 * a caller can merge into it unconditionally without its own null check;
 * `detail` is `null` only when `classification` is `'ok'`.
 *
 * Never throws, matching the function it replaces — see {@link readRawState}
 * for why a corrupt read must never become an exception on this path.
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

/**
 * Renders any thrown value to text. Exported so tests (and any sibling
 * module) share this one hardened implementation.
 *
 * The naive version (`err instanceof Error ? err.message : String(err)`)
 * calls `String(err)` unconditionally on anything that is not an `Error`,
 * and `String()` on an object invokes that object's OWN `toString`/
 * `Symbol.toPrimitive` — which a caller-supplied value (a `validate`
 * function's thrown value, in particular) can make throw. This function
 * promises never to throw, so that possibility is wrapped in its own
 * try/catch with a fixed fallback string: a thrown plain string or `null`
 * stringifies normally (`String` never throws on primitives), and only a
 * thrown object with a hostile `toString` falls through to the fallback.
 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return '<unprintable thrown value>'
  }
}
