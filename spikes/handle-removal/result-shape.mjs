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
