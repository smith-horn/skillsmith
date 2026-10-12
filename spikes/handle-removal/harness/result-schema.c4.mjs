// C4 additions to the harness result schema (SMI-6715), split out of
// result-schema.mjs to keep both files under the length limit. Imports nothing
// from result-schema.mjs, so there is no cycle. Behaviour is unchanged by the
// split; result-schema.selftest.mjs, result-schema.c4.selftest.mjs,
// result-schema.c4.classify.selftest.mjs, result-schema.c4.shapes.selftest.mjs
// and result-schema.c4.gate.selftest.mjs pin it.

import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Anything the removal machinery creates beside a tree it is removing is
 * named with this prefix -- V2's own private quarantine directory
 * (`.skillsmith-rm-<opId>`, walk.mjs) and C4's trash root
 * (`.skillsmith-trash`, quarantine.mjs). Matching on the PREFIX rather than
 * either exact name is deliberate: a leftover from a naming scheme this
 * scanner has not been told about must still be counted, not silently
 * reported as zero.
 */
export const QUARANTINE_PREFIX = '.skillsmith-'

export const MAX_REPORTED_PATHS = 8

const C4_TRASH_ROOT = '.skillsmith-trash'
const NO_SCAN = (scanError) => ({
  dirs: null,
  entries: null,
  paths: [],
  scanError,
  expected: { present: null, entries: null, path: null },
  litter: null,
})

/**
 * C4's variant of the scan (SMI-6715). C4 -- unlike V0/V1 -- DOES create a
 * quarantine: `<parent>/.skillsmith-trash/<opId>/` holding the moved tree entry
 * plus a `<entry>.json` sidecar. Layout measured by executing quarantineTree
 * on a scratch fixture, not read off the source: a `quarantined` call leaves
 * exactly `.skillsmith-trash/<opId>/{<name>-<rnd>/, <name>-<rnd>.json}`; a
 * `kept` call that failed AFTER the op directory was created (the pre-rename
 * identity re-check) leaves `.skillsmith-trash/<opId>/` EMPTY; a `kept` that
 * failed before it (guard-hash mismatch) leaves nothing at all.
 *
 * So the same directory means three different things depending on the outcome,
 * which is why the scan takes `{status, opId}` from the outcome:
 *  - status `quarantined`: THIS op dir's contents are the expected result of a
 *    successful move. Reported in `expected`, excluded from `dirs`/`entries`.
 *  - status `kept`/`stopped`: THIS op dir, when empty, is litter (`litter`),
 *    not stranding. When NON-empty it is unexpected and counted.
 *  - everything else under `.skillsmith-*`, including any other op dir and any
 *    non-directory child of the trash root, is an unexpected leftover.
 * The trash root itself is a container, not a leftover: only its children count.
 * A scan that cannot run (missing status/opId, unreadable parent) reports nulls,
 * never 0.
 */
export function scanC4Leftovers(parentAbs, options) {
  const status = options?.status
  const opId = options?.opId
  if (!['quarantined', 'kept', 'stopped'].includes(status)) {
    return NO_SCAN(`c4-scan-needs-status:${String(status)}`)
  }
  if (
    typeof opId !== 'string' ||
    opId === '' ||
    opId === '.' ||
    opId === '..' ||
    /[\\/]/.test(opId)
  ) {
    return NO_SCAN('c4-scan-needs-opId')
  }
  let names
  try {
    names = readdirSync(parentAbs)
  } catch (err) {
    return NO_SCAN(err.code ?? String(err))
  }
  let dirs = 0
  let entries = 0
  let litter = 0
  const expected = { present: false, entries: 0, path: null }
  const paths = []
  const report = (p) => {
    if (paths.length < MAX_REPORTED_PATHS) paths.push(p)
  }
  for (const name of names.sort()) {
    if (!name.startsWith(QUARANTINE_PREFIX)) continue
    const abs = path.join(parentAbs, name)
    let isRealDir
    try {
      isRealDir = lstatSync(abs).isDirectory()
    } catch (err) {
      return NO_SCAN(err.code ?? String(err))
    }
    if (name !== C4_TRASH_ROOT || !isRealDir) {
      // Not C4's trash root (V2's `.skillsmith-rm-*`, or a trash root that is
      // not a real directory): generic accounting, as for V2.
      dirs += 1
      let inner
      try {
        inner = isRealDir ? readdirSync(abs) : ['<not-a-directory>']
      } catch (err) {
        return NO_SCAN(err.code ?? String(err))
      }
      entries += inner.length
      for (const child of inner.sort()) report(`${name}/${child}`)
      continue
    }
    let children
    try {
      children = readdirSync(abs)
    } catch (err) {
      return NO_SCAN(err.code ?? String(err))
    }
    for (const op of children.sort()) {
      const opAbs = path.join(abs, op)
      let inner
      try {
        inner = lstatSync(opAbs).isDirectory() ? readdirSync(opAbs) : null
      } catch (e) {
        return NO_SCAN(e.code ?? String(e))
      }
      if (inner === null) {
        entries += 1 // a stray non-directory child of the trash root
        report(`${name}/${op}`)
        continue
      }
      if (op === opId) {
        if (status === 'quarantined') {
          expected.present = inner.length > 0
          expected.entries = inner.length
          expected.path = `${name}/${op}`
          continue
        }
        if (inner.length === 0) {
          litter += 1
          continue
        }
      }
      dirs += 1
      entries += inner.length
      for (const child of inner.sort()) report(`${name}/${op}/${child}`)
    }
  }
  return { dirs, entries, paths, scanError: null, expected, litter }
}

/**
 * C4 records (SMI-6715) are recognised by candidate or attack label ONLY, so no
 * pre-existing record can be reclassified: none carries these values.
 */
const C4_CANDIDATES = new Set(['C4', 'C4-naive'])
export function isC4Cell(cell) {
  const attack = cell?.attack
  return (
    C4_CANDIDATES.has(cell?.candidate) ||
    (typeof attack === 'string' && (attack.endsWith('-C4') || attack.endsWith('-C4-OOM')))
  )
}

/**
 * Snapshots a C4 precondition or userFiles object into a fresh plain object, or
 * THROWS. Accepted shape: a plain object (Object.prototype / null prototype)
 * whose every key -- strings, symbols and non-enumerables included, enumerated
 * with Reflect.ownKeys -- is an own, enumerable DATA property. Each value is
 * read once, from its descriptor, so an accessor, an inherited key, a
 * non-enumerable key or a Proxy cannot show makeRecord one value and
 * classifyRecord another. The throw is deliberate: makeRecord is called by a
 * runner, which records a throw as harness-error (never-ran), so a malformed
 * shape cannot be laundered into a clean-looking passing record.
 */
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * True only if JSON.parse(JSON.stringify(v)) is the SAME value as v: primitives
 * (finite numbers only), plain arrays and plain objects, own enumerable DATA
 * properties only, no `toJSON` anywhere, no `__proto__` / `constructor` /
 * `prototype` key, no cycles. This is what makes the runner (which classifies
 * the in-memory record) and the summary (which classifies what was persisted)
 * agree BY CONSTRUCTION for C4 records: a record that is not JSON-safe is
 * refused by makeRecord, classified never-ran by classifyRecord, and refused by
 * appendJsonl, so no persisted copy can differ from the classified one.
 */
export function jsonSafe(v, seen = new Set(), depth = 0) {
  if (v === null || v === undefined) return true
  const t = typeof v
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(v)
  if (t !== 'object' || depth > 12 || seen.has(v)) return false
  const proto = Object.getPrototypeOf(v)
  const isArr = Array.isArray(v)
  if (isArr ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false
  seen.add(v)
  try {
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string') return false
      if (isArr && key === 'length') continue
      if (key === 'toJSON' || BANNED_KEYS.has(key)) return false
      const d = Object.getOwnPropertyDescriptor(v, key)
      if (!d || !d.enumerable || !('value' in d)) return false
      if (!jsonSafe(d.value, seen, depth + 1)) return false
    }
    return true
  } finally {
    seen.delete(v)
  }
}

/** The four objects classifyRecord reads for a C4 record, all JSON-safe. */
export function c4RecordJsonSafe(record) {
  return ['cell', 'precondition', 'outcome', 'userFiles'].every((k) => jsonSafe(record?.[k]))
}

export function c4Snapshot(obj, label) {
  if (!isPlain(obj)) {
    throw new TypeError(`makeRecord: C4 ${label} must be a plain object`)
  }
  const out = {}
  for (const key of Reflect.ownKeys(obj)) {
    const v = typeof key === 'string' ? strictOwn(obj, key) : { ok: false }
    if (!v.ok) {
      throw new TypeError(
        `makeRecord: C4 ${label} key ${String(key)} is not an own enumerable data property`
      )
    }
    if (key === 'toJSON' || BANNED_KEYS.has(key)) {
      throw new TypeError(`makeRecord: C4 ${label} key ${key} is not allowed`)
    }
    // precondition / userFiles / cell hold scalars only; only `outcome` may nest
    // (quarantineLeft, a plain scan result).
    if (label !== 'outcome' && v.value !== null && typeof v.value === 'object') {
      throw new TypeError(`makeRecord: C4 ${label} key ${key} must be a primitive`)
    }
    if (!jsonSafe(v.value)) {
      throw new TypeError(
        `makeRecord: C4 ${label} key ${key} is not JSON-safe (its persisted form could differ from the classified one)`
      )
    }
    out[key] = v.value
  }
  return out
}
export function c4UserFileExtras(userFiles) {
  const out = {}
  for (const k of ['displaced', 'deleted']) {
    if (Object.hasOwn(userFiles, k)) out[k] = userFiles[k]
  }
  return out
}

const C4_STATUSES = new Set(['quarantined', 'kept', 'stopped', 'harness-error'])
/**
 * Every outcome.status a C4 record may carry. 'not-run' is a non-error run that
 * did not happen (a clean A13 caller-hash race): it classifies never-ran and,
 * with mutationApplied === false, is a non-landing. Any status outside this set
 * is a fault, never a non-landing (see cell-tally.mjs).
 */
export const C4_KNOWN_STATUSES = new Set([...C4_STATUSES, 'not-run'])
const C4_REQUIRED_PRECONDITIONS = ['hookFired', 'mutationApplied', 'traceMatched']

/** Own, enumerable, data (non-accessor) property value, or {ok:false}. */
function strictOwn(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key)
  if (!d || !d.enumerable || !('value' in d)) return { ok: false }
  return { ok: true, value: d.value }
}
const isPlain = (o) => {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}
const isCount = (v) => Number.isSafeInteger(v) && v >= 0

/**
 * The C4-only clauses of classifyRecord. Returns 'never-ran' when the record
 * cannot support a verdict, or null to continue to the bytes check.
 *
 * INHERITED PROPERTIES DO NOT COUNT. The legacy filter iterates
 * Object.entries, which skips inherited keys, so `Object.create({hookFired:
 * false})` classified as `passed` -- a measured fail-open (see selftest). For C4
 * the precondition and userFiles must be plain objects (Object.prototype or
 * null prototype) whose every key is an own enumerable data property; anything
 * else is never-ran.
 */
export function c4Validate(record) {
  // 'not-run' is known but is not a run that can be scored: never-ran.
  if (!C4_STATUSES.has(record.outcome?.status)) return null
  const pre = record.precondition
  if (!isPlain(pre)) return null
  for (const key of Reflect.ownKeys(pre)) {
    if (typeof key !== 'string') return null
    const v = strictOwn(pre, key)
    if (!v.ok) return null
    if (v.value !== true && key !== 'controlExpected') return null
  }
  // controlExpected is REQUIRED and strictly true like the rest (Sol F6b): it is
  // exempt from the any-false-is-never-ran sweep only in the sense that a cell
  // without a paired control is handled by CONTROL_SPEC, not here -- and every
  // C4 attack module sets it to the literal true.
  for (const key of [...C4_REQUIRED_PRECONDITIONS, 'controlExpected']) {
    const v = strictOwn(pre, key)
    if (!v.ok || v.value !== true) return null
  }

  const uf = record.userFiles
  if (!isPlain(uf)) return null
  const get = (k) => {
    const v = strictOwn(uf, k)
    return v.ok ? v.value : undefined
  }
  // displaced/deleted are REQUIRED (Sol F6a): a loss with no recoverable-vs-gone
  // split proves nothing, and "if present" let an omission read as a pass.
  const [checked, lost, changed] = [get('checked'), get('lost'), get('changed')]
  const [displaced, deleted] = [get('displaced'), get('deleted')]
  if (![checked, lost, changed, displaced, deleted].every(isCount) || checked < 1) return null
  if (displaced + deleted !== lost) return null
  // lost + changed <= checked (Sol F6c): more bytes lost than were checked is an
  // inconsistent record, not a loss to count.
  if (lost + changed > checked) return null
  return { lost, changed }
}
