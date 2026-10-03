/**
 * Field-level validation for audit:standards Check 76 (SMI-6949, review round 1).
 * Split out of audit-dependency-registry-helpers.mjs to keep both under the
 * file-length limit. Pure functions: filesystem probes are parameters.
 *
 * Every registry/package.json key lookup uses Object.hasOwn so a key named
 * `constructor`, `toString` or `__proto__` is looked up as DATA, never as an
 * inherited property (R1-L1).
 */

import { statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { TEST_PATTERNS } from './ci/source-patterns.mjs'

export const SEVERITIES = Object.freeze(['low', 'moderate', 'high', 'critical'])
const OWNER_RE = /^[A-Za-z0-9-]+$/
const TRACKING_RE = /^SMI-\d+$/

export const hasOwn = (obj, key) =>
  obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key)
export const isNonEmptyString = (s) => typeof s === 'string' && s.trim().length > 0

const f = (message, fix) => ({ severity: 'fail', message, fix })

/** True iff `p` is a regular file (a directory, a missing path or a socket is not). */
export const isRegularFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Why a `pinnedBy` value is unacceptable, or null. The path must be repo-relative
 * (no absolute path, no `..` escape), match the repo's test-file patterns
 * (scripts/ci/source-patterns.mjs TEST_PATTERNS) and name a regular file.
 * `isFile` receives the JOINED path (join(root, pinnedBy)).
 */
export function pinnedByProblem(pinnedBy, root, isFile) {
  if (!isNonEmptyString(pinnedBy)) return 'is not a non-empty string'
  if (isAbsolute(pinnedBy)) return 'is an absolute path; it must be repo-relative'
  const rel = relative(resolve(root), resolve(root, pinnedBy))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return 'resolves outside the repository root'
  }
  const posix = rel.split('\\').join('/')
  if (!TEST_PATTERNS.some((re) => re.test(posix))) {
    return 'is not a test file (it must match *.test.* or *.spec.*)'
  }
  if (!isFile(join(root, pinnedBy))) return 'does not name an existing regular file'
  return null
}

/** Type checks on one registry override entry (presence of the keys is checked by the caller). */
export function validateOverrideEntryTypes(key, e, out) {
  if (hasOwn(e, 'crossesMajor') && e.crossesMajor !== null && !isNonEmptyString(e.crossesMajor)) {
    out.push(
      f(
        `Check 76: override "${key}" crossesMajor must be a non-empty string or null (not a boolean)`
      )
    )
  }
  if (hasOwn(e, 'introducedBy')) {
    const ib = e.introducedBy
    if (!Array.isArray(ib) || ib.length === 0 || !ib.every(isNonEmptyString)) {
      out.push(
        f(`Check 76: override "${key}" introducedBy must be a non-empty array of non-empty strings`)
      )
    }
  }
}

/** Type checks on one acceptance entry's scalar fields. */
export function validateAcceptanceTypes(a, label, out) {
  if (isNonEmptyString(a.severity) && !SEVERITIES.includes(a.severity)) {
    out.push(
      f(
        `Check 76: acceptance ${label} severity ${JSON.stringify(a.severity)} must be one of ${SEVERITIES.join(', ')}`
      )
    )
  }
  if (isNonEmptyString(a.owner) && !OWNER_RE.test(a.owner)) {
    out.push(
      f(`Check 76: acceptance ${label} owner ${JSON.stringify(a.owner)} is not a GitHub login`)
    )
  }
  if (hasOwn(a, 'tracking') && a.tracking !== null && !TRACKING_RE.test(String(a.tracking))) {
    out.push(
      f(
        `Check 76: acceptance ${label} tracking ${JSON.stringify(a.tracking)} must be null or SMI-<number>`
      )
    )
  }
}

/** Override keys in package.json whose own text contains " > " (collides with the nesting separator). */
export function findAmbiguousOverrideKeys(overrides, prefix = []) {
  const bad = []
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const path = [...prefix, key]
    if (key.includes(' > ')) bad.push(path.join(' > '))
    if (value !== null && typeof value === 'object') {
      bad.push(...findAmbiguousOverrideKeys(value, path))
    }
  }
  return bad
}

/** True iff the lockfile has a `node_modules/<name>` entry at any nesting depth (exact path segments). */
export function lockHasPackage(lock, name) {
  const suffix = `/node_modules/${name}`
  return Object.keys(lock?.packages ?? {}).some(
    (k) => k === `node_modules/${name}` || k.endsWith(suffix)
  )
}

/** Why the lockfile cannot be evaluated, or null: `packages` exists only from lockfileVersion 2. */
export function lockProblem(lock) {
  const v = lock?.lockfileVersion
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 2) {
    return `package-lock.json lockfileVersion ${JSON.stringify(v)} is unsupported (need an integer >= 2; v1 has no "packages" map)`
  }
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    return 'package-lock.json has no "packages" object'
  }
  return null
}
