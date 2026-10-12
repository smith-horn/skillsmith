// C4 additions to the harness result schema (SMI-6715), split out of
// result-schema.mjs to keep both files under the length limit. Imports nothing
// from result-schema.mjs, so there is no cycle. Behaviour is unchanged by the
// split; result-schema.selftest.mjs and result-schema.c4.selftest.mjs pin it.

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
  if (!C4_STATUSES.has(record.outcome?.status)) return null
  const pre = record.precondition
  if (!isPlain(pre)) return null
  for (const key of Reflect.ownKeys(pre)) {
    if (typeof key !== 'string') return null
    const v = strictOwn(pre, key)
    if (!v.ok) return null
    if (key !== 'controlExpected' && v.value !== true) return null
  }
  for (const key of C4_REQUIRED_PRECONDITIONS) if (!strictOwn(pre, key).ok) return null

  const uf = record.userFiles
  if (!isPlain(uf)) return null
  const get = (k) => {
    const v = strictOwn(uf, k)
    return v.ok ? v.value : undefined
  }
  const [checked, lost, changed] = [get('checked'), get('lost'), get('changed')]
  if (!isCount(checked) || !isCount(lost) || !isCount(changed) || checked < 1) return null
  const hasD = Reflect.ownKeys(uf).includes('displaced')
  const hasX = Reflect.ownKeys(uf).includes('deleted')
  if (hasD || hasX) {
    const [d, x] = [get('displaced'), get('deleted')]
    if (!isCount(d) || !isCount(x) || d + x !== lost) return null
  }
  return { lost, changed }
}
