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
    if (!(k in out)) out[k] = partial[k]
  }
  return out
}

/** True when the tree is gone from its original location. */
export function isSuccess(result) {
  return result.status === 'removed' || result.status === 'quarantined'
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
