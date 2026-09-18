// SMI-6676 N-1: ONE result shape that both removal paths satisfy.
//
// THE DEFECT THIS REMOVES. `hybrid.mjs`'s `removeTree()` returns whichever
// path ran, verbatim, with no reshaping -- and which path runs depends on an
// env var, a child-process probe and the platform, none of which the caller can
// see. So the contract varied by runtime condition:
//
//   outcome       native (walk.mjs)              fallback (quarantine.mjs)
//   kept          {status, treeHash}             {status, reason, path, treeHash}
//   success       {status:'removed', treeHash}   {status:'quarantined', path, sidecarPath, opId}
//   stopped       {status, reason, path, errno}  {status, reason, path, entry, errno}
//
// A caller switching on `result.reason` for a `kept` got `undefined` from the
// native path. Worse, the fallback's SUCCESS carried no `treeHash` at all --
// and that is the field the A1 plan's UD14, UD15 and UD17 require in order to
// authorize a removal ("its whole tree hash equals postTree exactly, compared
// under lock 1 immediately before removal"). The owner's 2026-09-17 decision
// ships the fallback, so that was the missing field on the path that ships.
//
// This is the same class as the `guardHash`/`treeHash` PARAMETER-name mismatch
// the spike already found and fixed -- a caller doing exactly what it was told
// and silently getting a different contract -- but on the RETURN side, which
// that fix did not touch.
//
// WHY A NORMALIZER RATHER THAN EDITING 18 RETURN SITES. Every `return` in both
// modules is a separate opportunity to omit a field, which is how the shapes
// drifted in the first place. One function that every result passes through
// makes divergence structurally impossible instead of a thing reviewers must
// keep noticing.

/** Every field a removal result carries, in a fixed order. */
export const RESULT_FIELDS = [
  'status',
  'reason',
  'path',
  'entry',
  'treeHash',
  'errno',
  'opId',
  'sidecarPath',
  // F13: `detail` was carried by some returns and silently dropped by others,
  // surviving only through the pass-through loop below. A field observable on
  // two returns and discarded on three is worse than one that never existed:
  // a caller reading it gets `undefined` and cannot tell "no diagnosis" from
  // "diagnosis thrown away". Declared, so every result has it.
  'detail',
  // R5-10: `hybrid.mjs` added this on the fallback branch and not the native
  // one, so `removeTree` -- the SHIPPED entry point, and the surface this
  // module's own header is about -- returned 10 keys one way and 9 the other.
  // That is the N-1 defect itself, on the dispatcher, surviving the fix for it
  // because the parity suite compared `removeVR` against `quarantineTree`
  // directly and never `removeTree` against `removeTree`.
  'fallbackTrigger',
]

/** Outcomes either path may report. `removed` and `quarantined` are both success. */
export const RESULT_STATUSES = new Set(['removed', 'quarantined', 'kept', 'stopped'])

/**
 * Normalizes a partial result to the full shape. Absent fields become `null`,
 * never `undefined`: `undefined` is indistinguishable from "this path forgot to
 * set it", while `null` states that the field does not apply to this outcome.
 * A caller can then branch on a value instead of on which module answered.
 */
export function shapeResult(partial) {
  if (!partial || typeof partial !== 'object') {
    throw new TypeError(`shapeResult: expected a result object, got ${String(partial)}`)
  }
  if (!RESULT_STATUSES.has(partial.status)) {
    throw new TypeError(`shapeResult: unknown status ${JSON.stringify(partial.status)}`)
  }
  const out = {}
  for (const f of RESULT_FIELDS) out[f] = partial[f] ?? null
  // Preserve anything a path adds beyond the contract rather than dropping it
  // silently -- dropping would be this defect's own failure mode, inverted.
  for (const k of Object.keys(partial)) {
    // m-6: this used `!(k in out)`, and `in` walks the prototype chain -- so any
    // extra key that collides with `Object.prototype` (`toString`,
    // `constructor`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`) was reported
    // as already present and SILENTLY DROPPED. Measured: all five dropped, while
    // a control key (`sidecarError`) survived. That is precisely the failure the
    // comment above says this loop prevents, inside the loop that prevents it.
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = partial[k]
  }
  return out
}

/** True when the tree is gone from its original location. */
export function isSuccess(result) {
  return result.status === 'removed' || result.status === 'quarantined'
}

/**
 * THE ONE PLACE EITHER REMOVAL PATH LEARNS WHAT ITS GUARD IS.
 *
 * F10/F14 (confirmation round, 2026-09-17). The fix before this one validated
 * the `treeHash` alias inside `quarantine.mjs` and its commit message claimed
 * "both spellings now normalize". Measured, that was true of ONE FILE:
 * `walk.mjs` neither validated the alias nor read it, so on the native path
 *
 *   removeVR(t, { treeHash: 'WRONG' })  -> removed, origin GONE
 *   removeVR(t, { treeHash: null })     -> removed, origin GONE
 *
 * while the fallback refused all three. That is the ORIGINAL parameter-name
 * defect with the two paths swapped, re-created by the fix for it -- and my new
 * tests missed it because all six cases called `quarantineTree`, in a file that
 * already imports `removeVR`. Second time in one commit that the author
 * red-tested the spelling in the file he had just edited.
 *
 * It also closes F14, a TOCTOU inside the same fix: validating `options.guardHash`
 * and then letting the inner function RE-READ `options.guardHash` is an assertion
 * about a property the function does not own. Measured with a getter returning a
 * valid hash on read 1 and `null` after: validation passed, the second read
 * yielded no guard, and the tree was moved unguarded.
 *
 * So: read each property EXACTLY ONCE, resolve, validate, and return the value.
 * Callers must pass the RESULT down and never consult `options` again.
 *
 * @returns {string|undefined} the resolved guard hash, or undefined for no guard
 */
/**
 * A single path segment, never a path. Shared so both removal paths enforce it.
 */
export function assertPathSegment(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string, got ${String(value)}`)
  }
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new TypeError(
      `${label} must be a single path segment, not a path. Got ${JSON.stringify(value)}. ` +
        `A traversing value escapes the parked root entirely and lands the tree in ` +
        `attacker-chosen storage while reporting success.`
    )
  }
}

/**
 * SNAPSHOT EVERY OPTION ONCE, VALIDATE THE SNAPSHOT, RETURN PLAIN DATA.
 *
 * R5-1/R5-2 (round 5, 2026-09-17). The previous fix resolved `guardHash` once
 * and passed it down -- and did that for `guardHash` ALONE. `opId` was still
 * validated by reading `options.opId` twice and then USED from a third read, the
 * object spread that forwarded options to the inner function. Measured: a getter
 * answering `'op-benign'` for reads 1-2 and `'../../loot'` for read 3, with a
 * valid `guardHash` and a 0700 landing directory, produced
 *
 *   status: 'quarantined', origin GONE,
 *   user bytes AND the sidecar (carrying originPath + treeHash) in attacker storage
 *
 * -- the exact `../../loot` escape an existing case was written to prevent, and
 * the exact sentence the previous fix's own comment used, one identifier over.
 *
 * And `walk.mjs` never validated `opId` at all, interpolating it straight into a
 * directory name: the one-file shape again, in the commit that fixed the
 * one-file shape for `guardHash`.
 *
 * Both were instances of one thing: **the fix was applied per-option instead of
 * to the mechanism.** So this returns a fully-materialised plain object. Every
 * property is read exactly once, here; nothing downstream consults `options`
 * again; and a getter cannot answer differently on a later read because there
 * are no later reads. A new option added tomorrow is covered without anyone
 * remembering this rule.
 */
/**
 * Every option either removal path consumes. Derived from the actual reads in
 * `quarantine.mjs`, `walk.mjs` and `hybrid.mjs` -- not from memory. A read this
 * list misses falls back to the extras loop below, which is own-enumerable-only,
 * so ADD TO THIS LIST when you add an option that matters.
 */
export const REMOVAL_OPTION_KEYS = [
  'guardHash',
  'treeHash',
  'opId',
  'expectIdentity',
  'maxBirthtimeNs',
  'nativeShim',
  'variant',
  'hooks',
  'kind',
  'client',
  'rootKey',
  'maxHeldFds',
]

export function resolveRemovalOptions(options = {}) {
  // C-1 (round 6, 2026-09-17): THE PREVIOUS VERSION WAS `{ ...options }`, AND A
  // SPREAD IS OWN-ENUMERABLE-ONLY. The code it replaced read `options.guardHash`
  // DIRECTLY, which traverses the prototype chain. So the "read once" fix
  // silently narrowed what could be read at all -- and the narrowing resolved to
  // `undefined`, which this module defines as "no guard, proceed".
  //
  // Measured, parent commit vs that commit, ordinary non-hostile option shapes:
  //
  //   class R { get guardHash() { return 'WRONG' } }
  //     before -> kept, origin SURVIVES      after -> quarantined, origin GONE
  //     native: before -> kept               after -> removed, UNRECOVERABLE
  //   Object.create({ guardHash: null })
  //     before -> TypeError (refused)        after -> quarantined, origin GONE
  //
  // A fail-CLOSED guard became fail-OPEN, on both paths, in the commit whose
  // message claimed "validated equals used, for every option". Neither shape is
  // hostile: a class instance with a getter and `Object.create(defaults)` are
  // ordinary JavaScript. No case in either suite passed anything but an object
  // literal, which is why it landed.
  //
  // THE RULE THIS ENCODES: an option that cannot be read must fail CLOSED. So
  // every known option is read by DIRECT PROPERTY ACCESS -- prototype-aware,
  // non-enumerable-aware -- exactly once, and the snapshot is built from those
  // reads rather than from a spread.
  const snap = {}

  // Extras first: anything a caller attaches that this module does not know
  // about. Own-enumerable-only is correct HERE -- these are pass-through values,
  // not security inputs, and the known keys are excluded so none is read twice.
  for (const k of Object.keys(options)) {
    if (!REMOVAL_OPTION_KEYS.includes(k)) snap[k] = options[k]
  }

  // The known options: one direct read each. This is the line that fixes C-1.
  for (const k of REMOVAL_OPTION_KEYS) snap[k] = options[k]

  snap.guardHash = resolveGuardHash({ guardHash: snap.guardHash, treeHash: snap.treeHash })
  snap.treeHash = undefined
  if (snap.opId !== undefined) assertPathSegment('opId', snap.opId)
  return snap
}

export function resolveGuardHash(options = {}) {
  // Exactly one read of each, captured before any validation. A getter that
  // changes its answer between reads cannot make the validated value differ
  // from the used value, because there is only one read and one value.
  const g = options.guardHash
  const t = options.treeHash
  normalizeGuardHash(g)
  normalizeGuardHash(t)
  if (g !== undefined && t !== undefined && g !== t) {
    throw new TypeError(
      `guardHash and treeHash were both supplied with different values ` +
        `(${JSON.stringify(g)} vs ${JSON.stringify(t)}). ` +
        `treeHash is a deprecated alias for guardHash; pass exactly one. ` +
        `Resolving this by precedence would silently guard against a hash the ` +
        `caller may not have meant, on the destructive path.`
    )
  }
  return g ?? t
}

/**
 * ONE MEANING FOR `guardHash`, ENFORCED RATHER THAN CONVENTIONAL.
 *
 * `null` used to mean OPPOSITE things on the two removal paths, and the
 * destructive reading won on the path that ships. Measured, same call, same
 * fixture:
 *
 *   native   removeVR(t, { guardHash: null })        -> kept,        origin PRESERVED
 *   fallback quarantineTree(p, n, { guardHash: null }) -> quarantined, origin MOVED
 *
 * `walk.mjs` tested `guardHash !== undefined && guardHash !== treeHash`, so
 * `null` was a mismatch and refused. `quarantine.mjs` tested
 * `guardHash !== undefined && guardHash !== null`, so `null` was "no guard,
 * proceed". Which path runs depends on an env var and a child-process probe the
 * caller cannot see, so `guardHash: maybeHash() ?? null` -- an idiom a caller
 * would write without thinking -- destroys data on one path and refuses on the
 * other, unpredictably.
 *
 * This is the THIRD instance of one class. The parameter-rename fix made the
 * input NAME agree; `shapeResult` made the RETURN agree; the input SEMANTICS
 * were still divergent.
 *
 * NEITHER READING IS ADOPTED, because both are defensible and a caller passing
 * `null` has not said which they meant. Treating a genuinely ambiguous input as
 * either "guard" or "no guard" is a function guessing at missing evidence,
 * which is the defect this whole spike documents. So:
 *
 *   undefined  -> no guard. Explicit, and the caller had to omit the key.
 *   string     -> guard with that hash.
 *   anything else, null included -> TypeError, before anything is touched.
 */
export function normalizeGuardHash(guardHash) {
  if (guardHash === undefined) return undefined
  if (typeof guardHash === 'string' && guardHash.length > 0) return guardHash
  throw new TypeError(
    `guardHash must be a non-empty string, or omitted entirely for no guard. ` +
      `Got ${guardHash === null ? 'null' : typeof guardHash}. ` +
      `null is refused deliberately: it read as "no guard" on one removal path ` +
      `and "a hash that never matches" on the other, so it could delete or refuse ` +
      `depending on which path ran.`
  )
}
