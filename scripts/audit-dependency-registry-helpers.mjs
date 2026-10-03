#!/usr/bin/env node
/**
 * Helper for audit-standards.mjs Check 76 (SMI-6949, ADR-176): the dependency
 * registry (.github/dependency-registry.json) is complete, well-formed and
 * unexpired. Pure logic: every input is a parameter, including today's date,
 * and the filesystem probe for `pinnedBy`, so tests pin all of them. The only
 * side-effecting entry points are readDependencyRegistryInputs() (file reads)
 * and emitGithubActionsReport() (annotations + step summary).
 *
 * Enforced vs not (see the plan's "Owner rules" table): tier ceilings, the
 * 14-day warn window, the fail-on-expiry date and the absence of any opt-out
 * are enforced here; "fix now when a patch exists", "R1 with outside input is
 * never accepted" and "remove an unused R4 dependency" need data this static,
 * network-free check does not have and are NOT enforced.
 *
 * Dates are UTC calendar days. They are parsed strictly (YYYY-MM-DD, round-trip
 * validated) and compared as Date.UTC day numbers, never as local-time Dates.
 */

import { readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanDuplicateJsonKeys } from './audit-dependency-registry-json.mjs'
import {
  findAmbiguousOverrideKeys,
  hasOwn,
  isNonEmptyString,
  isRegularFile,
  lockHasPackage,
  lockProblem,
  pinnedByProblem,
  validateAcceptanceTypes,
  validateOverrideEntryTypes,
} from './audit-dependency-registry-fields.mjs'

export const REGISTRY_PATH = '.github/dependency-registry.json'
export const TIER_CEILING_DAYS = Object.freeze({ R1: 30, R2: 90, R3: 90, R4: 180 })
export const WARN_WINDOW_DAYS = 14
const GHSA_RE = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/
const CVE_RE = /^CVE-\d{4}-\d{4,}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isAdvisoryId = (s) => typeof s === 'string' && (GHSA_RE.test(s) || CVE_RE.test(s))

/** Day number of a strictly valid UTC `YYYY-MM-DD`, or null. */
export function utcDayNumber(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null
  const ms = Date.parse(`${s}T00:00:00Z`)
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) return null
  return ms / 86400000
}

/** Override leaves of a package.json `overrides` map, keyed `a > b > .`. */
export function collectOverrideLeaves(overrides, prefix = []) {
  const leaves = new Map()
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const path = [...prefix, key]
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of collectOverrideLeaves(value, path)) leaves.set(k, v)
    } else {
      leaves.set(path.join(' > '), value)
    }
  }
  return leaves
}

const f = (message, fix) => ({ severity: 'fail', message, fix })
const w = (message, fix) => ({ severity: 'warn', message, fix })

function checkOverrides({ pkg, registry }, out) {
  const leaves = collectOverrideLeaves(pkg?.overrides)
  const entries = registry.overrides ?? {}
  for (const bad of findAmbiguousOverrideKeys(pkg?.overrides)) {
    out.push(
      f(
        `Check 76: package.json override key "${bad}" contains " > ", which collides with the nesting separator used by the registry`,
        'Rename the override key, or express the nesting as a nested overrides object'
      )
    )
  }
  for (const key of leaves.keys()) {
    if (!hasOwn(entries, key)) {
      out.push(
        f(
          `Check 76: override "${key}" has no entry in ${REGISTRY_PATH}`,
          `Add overrides["${key}"] (pin, reason, advisories, introducedBy, crossesMajor, removeWhen)`
        )
      )
    }
  }
  for (const [key, entry] of Object.entries(entries)) {
    if (!leaves.has(key)) {
      out.push(
        f(
          `Check 76: registry entry "${key}" has no matching package.json override`,
          `Delete overrides["${key}"] from ${REGISTRY_PATH}, or restore the override`
        )
      )
      continue
    }
    const e = entry && typeof entry === 'object' ? entry : {}
    if (e.pin !== leaves.get(key)) {
      out.push(
        f(
          `Check 76: override "${key}" pin ${JSON.stringify(e.pin)} != package.json ${JSON.stringify(leaves.get(key))}`,
          `Set overrides["${key}"].pin to the exact package.json value`
        )
      )
    }
    for (const field of ['reason', 'removeWhen']) {
      if (!isNonEmptyString(e[field])) {
        out.push(f(`Check 76: override "${key}" has an empty or missing "${field}"`))
      }
    }
    for (const field of ['crossesMajor', 'introducedBy']) {
      if (!hasOwn(e, field)) {
        out.push(f(`Check 76: override "${key}" is missing the key "${field}"`))
      }
    }
    validateOverrideEntryTypes(key, e, out)
    if (!Array.isArray(e.advisories)) {
      out.push(f(`Check 76: override "${key}" advisories is not an array`))
    } else {
      for (const id of e.advisories) {
        if (!isAdvisoryId(id)) {
          out.push(
            f(
              `Check 76: override "${key}" advisory ${JSON.stringify(id)} is not a full GHSA or CVE id`,
              'Use the full id, for example GHSA-xxxx-xxxx-xxxx'
            )
          )
        }
      }
    }
  }
  return { overrideLeaves: leaves.size, registryOverrides: Object.keys(entries).length }
}

function acceptanceLabel(a) {
  return `${a.advisory} (${a.package}, tier ${a.tier}, owner ${a.owner})`
}

function checkAcceptance(a, ctx, out, windowEntries) {
  const { today, lock, root, exists } = ctx
  if (!a || typeof a !== 'object') {
    out.push(f('Check 76: an acceptances entry is not an object'))
    return
  }
  const label = acceptanceLabel(a)
  for (const field of ['package', 'severity', 'owner', 'basis']) {
    if (!isNonEmptyString(a[field]))
      out.push(f(`Check 76: acceptance ${label} has an empty "${field}"`))
  }
  if (!isAdvisoryId(a.advisory)) {
    out.push(
      f(`Check 76: acceptance advisory ${JSON.stringify(a.advisory)} is not a full GHSA or CVE id`)
    )
  }
  validateAcceptanceTypes(a, label, out)
  if (a.scope !== 'dev') out.push(f(`Check 76: acceptance ${label} scope must be "dev"`))
  if (!hasOwn(TIER_CEILING_DAYS, a.tier)) {
    out.push(f(`Check 76: acceptance ${label} tier must be one of R1, R2, R3, R4`))
  }
  if (isNonEmptyString(a.package) && !lockHasPackage(lock, a.package)) {
    out.push(
      f(
        `Check 76: acceptance ${label} names package "${a.package}", which is not in package-lock.json`,
        'Delete the acceptance if the package is gone, or correct the package name'
      )
    )
  }
  const acc = utcDayNumber(a.accepted)
  const exp = utcDayNumber(a.expires)
  const todayN = utcDayNumber(today)
  if (acc === null)
    out.push(
      f(
        `Check 76: acceptance ${label} accepted ${JSON.stringify(a.accepted)} is not a valid UTC YYYY-MM-DD date`
      )
    )
  if (exp === null)
    out.push(
      f(
        `Check 76: acceptance ${label} expires ${JSON.stringify(a.expires)} is not a valid UTC YYYY-MM-DD date`
      )
    )
  if (acc !== null && exp !== null) {
    if (exp <= acc)
      out.push(
        f(
          `Check 76: acceptance ${label} expires ${a.expires} is not after accepted ${a.accepted} (UTC)`
        )
      )
    const ceiling = hasOwn(TIER_CEILING_DAYS, a.tier) ? TIER_CEILING_DAYS[a.tier] : undefined
    if (ceiling !== undefined && exp - acc > ceiling) {
      out.push(
        f(
          `Check 76: acceptance ${label} spans ${exp - acc} days (UTC), above the tier ${a.tier} ceiling of ${ceiling}`,
          `Set expires <= accepted + ${ceiling} days`
        )
      )
    }
  }
  if (acc !== null && todayN !== null && acc > todayN) {
    out.push(
      f(`Check 76: acceptance ${label} accepted ${a.accepted} is after today ${today} (UTC)`)
    )
  }
  if (a.tier === 'R4') {
    const hasPin = a.pinnedBy !== undefined && a.pinnedBy !== null
    const pinProblem = hasPin ? pinnedByProblem(a.pinnedBy, root, exists) : null
    if (pinProblem) {
      out.push(
        f(
          `Check 76: acceptance ${label} pinnedBy ${JSON.stringify(a.pinnedBy)} ${pinProblem}`,
          'Point pinnedBy at the repo-relative test file (*.test.* / *.spec.*) that pins the R4 condition'
        )
      )
    }
    if (!hasPin && !isNonEmptyString(a.tracking)) {
      out.push(
        f(
          `Check 76: R4 acceptance ${label} has neither pinnedBy (a test file) nor a tracking issue`,
          'Add pinnedBy: <repo path to the test> or tracking: <SMI-id of the issue that adds it>'
        )
      )
    } else if (!hasPin) {
      out.push(
        w(
          `Check 76: R4 acceptance ${label} is tracked by ${a.tracking} only; the R4 condition is unpinned (no test checks it yet)`,
          'Add pinnedBy: <repo path to a test that pins the R4 condition>'
        )
      )
    }
  }
  if (exp !== null && todayN !== null) {
    if (todayN >= exp) {
      out.push(
        f(
          `Check 76: acceptance ${label} expired ${a.expires} (UTC). Re-triage: if still unfixed, set accepted=${today} and expires <= today+${hasOwn(TIER_CEILING_DAYS, a.tier) ? TIER_CEILING_DAYS[a.tier] : '<ceiling>'}d in ${REGISTRY_PATH}; if fixed, delete the entry. No opt-out exists; every code PR fails until this is done.`
        )
      )
    } else if (todayN >= exp - WARN_WINDOW_DAYS) {
      windowEntries.push({
        advisory: a.advisory,
        package: a.package,
        expires: a.expires,
        owner: a.owner,
      })
      out.push(
        w(
          `Check 76: acceptance ${label} expires ${a.expires} (UTC) in ${exp - todayN} day(s), owner ${a.owner}`,
          `Re-triage before ${a.expires}: renew within the tier ceiling or delete the entry`
        )
      )
    }
  }
}

/**
 * @param {object} input
 * @param {object|null} input.pkg parsed root package.json
 * @param {string|null} input.registryText raw registry text (duplicate-key scan)
 * @param {object|null} input.lock parsed package-lock.json
 * @param {string} input.today UTC YYYY-MM-DD, injected by the caller
 * @param {string} [input.root] repo root for pinnedBy lookups
 * @param {(p: string) => boolean} [input.exists] probe, true iff the JOINED path is a regular file
 * @returns {{findings: Array, examined: object, windowEntries: Array, evaluated: boolean}}
 */
export function evaluateDependencyRegistry(input) {
  const { pkg, registryText, lock, today, root = '.', exists = isRegularFile } = input
  const findings = []
  const windowEntries = []
  const notEvaluated = (why) => ({
    findings: [
      f(`Check 76: NOT EVALUATED - ${why}`, `Restore ${REGISTRY_PATH} and package-lock.json`),
    ],
    examined: { overrides: 0, acceptances: 0 },
    windowEntries,
    evaluated: false,
  })
  if (utcDayNumber(today) === null)
    return notEvaluated(`today ${JSON.stringify(today)} is not a UTC YYYY-MM-DD date`)
  if (!pkg || typeof pkg !== 'object') return notEvaluated('package.json is missing or unparseable')
  if (!lock || typeof lock !== 'object')
    return notEvaluated('package-lock.json is missing or unparseable')
  const lockWhy = lockProblem(lock)
  if (lockWhy) return notEvaluated(lockWhy)
  if (typeof registryText !== 'string') return notEvaluated(`${REGISTRY_PATH} is missing`)
  let registry
  try {
    registry = JSON.parse(registryText)
  } catch (err) {
    return notEvaluated(`${REGISTRY_PATH} is not valid JSON (${err.message})`)
  }
  if (
    !registry ||
    typeof registry.overrides !== 'object' ||
    registry.overrides === null ||
    Array.isArray(registry.overrides) ||
    !Array.isArray(registry.acceptances)
  ) {
    return notEvaluated(`${REGISTRY_PATH} lacks an "overrides" object and an "acceptances" array`)
  }
  for (const dup of scanDuplicateJsonKeys(registryText)) {
    findings.push(
      f(
        `Check 76: duplicate key "${dup.key}" at ${dup.path || '<root>'} in ${REGISTRY_PATH} (JSON.parse keeps only the last one)`,
        'Delete the duplicate; keep the one that is meant'
      )
    )
  }
  const counts = checkOverrides({ pkg, registry }, findings)
  const ctx = { today, lock, root, exists }
  const seen = new Set()
  for (const a of registry.acceptances) {
    checkAcceptance(a, ctx, findings, windowEntries)
    if (a && typeof a === 'object' && typeof a.advisory === 'string') {
      if (seen.has(a.advisory)) {
        findings.push(
          f(
            `Check 76: advisory ${a.advisory} is accepted twice`,
            'Keep one acceptance per advisory'
          )
        )
      }
      seen.add(a.advisory)
    }
  }
  return {
    findings,
    examined: {
      overrides: counts.registryOverrides,
      overrideLeaves: counts.overrideLeaves,
      acceptances: registry.acceptances.length,
    },
    windowEntries,
    evaluated: true,
  }
}

/** Reads the three real files; returns null for any that is missing or unparseable. */
export function readDependencyRegistryInputs(root = '.') {
  const readJson = (rel) => {
    try {
      return JSON.parse(readFileSync(join(root, rel), 'utf8'))
    } catch {
      return null
    }
  }
  let registryText = null
  try {
    registryText = readFileSync(join(root, REGISTRY_PATH), 'utf8')
  } catch {
    registryText = null
  }
  return { pkg: readJson('package.json'), lock: readJson('package-lock.json'), registryText, root }
}

/** UTC today, computed by the caller, never inside the evaluator. */
export const utcToday = () => new Date().toISOString().slice(0, 10)

/** Emits ::warning annotations and a step-summary table when running in GitHub Actions. */
export function emitGithubActionsReport(windowEntries, env = process.env, write = console.log) {
  if (env.GITHUB_ACTIONS !== 'true' || windowEntries.length === 0) return
  for (const e of windowEntries) {
    write(
      `::warning file=${REGISTRY_PATH}::${e.advisory} expires ${e.expires} (UTC), owner ${e.owner}`
    )
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = windowEntries.map(
      (e) => `| ${e.advisory} | ${e.package} | ${e.expires} | ${e.owner} |`
    )
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Dependency registry: acceptances expiring within ${WARN_WINDOW_DAYS} days (UTC)\n\n| Advisory | Package | Expires | Owner |\n|---|---|---|---|\n${rows.join('\n')}\n\n`
    )
  }
}

/**
 * Runs Check 76 end to end. `reporters` are audit-standards' pass/warn/fail.
 * Returns the number of failures reported (for the --only dispatcher).
 */
export function runDependencyRegistryCheck({ pass, warn, fail }, opts = {}) {
  const inputs = readDependencyRegistryInputs(opts.root ?? '.')
  const result = evaluateDependencyRegistry({ ...inputs, today: opts.today ?? utcToday() })
  let failures = 0
  const reporters = { pass, warn, fail }
  for (const line of result.findings) {
    reporters[line.severity](line.message, line.fix)
    if (line.severity === 'fail') failures++
  }
  if (result.evaluated && failures === 0) {
    pass(
      `Check 76: dependency registry coherent (${result.examined.overrides} override entries for ${result.examined.overrideLeaves} override leaves, ${result.examined.acceptances} acceptances examined)`
    )
  }
  emitGithubActionsReport(result.windowEntries, opts.env ?? process.env)
  return failures
}

/** Check 11 (override exact-pin) text, kept here so a test can pin it (SMI-6949 section 5). */
export function exactPinOverrideWarning(count) {
  return {
    message: `${count} npm override(s) target exact-pinned dependencies and the resolved tree has no version that satisfies the override`,
    fix: 'Inspect `npm ls <dep>` and package-lock.json; see .claude/development/ci-reference.md, section "npm Overrides (Transitive Vulnerability Fixes)". Record a deliberate exception in .github/dependency-registry.json.',
  }
}
