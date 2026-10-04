#!/usr/bin/env node
/**
 * Check 76 --reconcile-audit (SMI-6949 round 3): ties the registry's accepted
 * advisories to what `npm audit --json --package-lock-only` actually reports.
 * Name presence in the lockfile cannot show that an acceptance is for the right
 * package or that the advisory is still live; this can. Pure functions plus one
 * file-reading entry point. Import closure: node builtins and repo files only
 * (the scheduled workflow runs it without `npm ci`).
 *
 * Fails closed: an audit file that is unreadable, not JSON, not the v2 report
 * shape, or that carries an `error` object is a failure, never a clean result.
 *
 * Scope (ADR-176): the registry records DEV-scope acceptances; the production
 * gate (`npm audit --omit=dev`) is separate. An audit advisory with no acceptance
 * fails here unless its package has a production install in package-lock.json,
 * in which case it is printed as informational. A package the lockfile cannot
 * place (absent, or an unusable lockfile) is never treated as production.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY_PATH } from './audit-dependency-registry-helpers.mjs'
import { lockOccurrences } from './audit-dependency-registry-fields.mjs'

const GHSA_IN_URL = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/
const f = (message, fix) => ({ severity: 'fail', message, fix })
const info = (message) => ({ severity: 'info', message })
const key = (id, pkg) => `${id}\u0000${pkg}`

/** 'production' (some non-dev install), 'dev' (every install dev), or 'unknown' (cannot be placed). */
function scopeOf(lock, pkg) {
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
    return 'unknown'
  }
  const occ = lockOccurrences(lock, pkg)
  if (occ.length === 0) return 'unknown'
  return occ.some((o) => !o.dev) ? 'production' : 'dev'
}

/**
 * Direct advisories in an npm audit v2 report: one entry per object `via` item
 * (string `via` items are transitive links, not advisories). The id is the GHSA
 * in `url`, else `src:<source>`; an item with neither is unusable.
 * @returns {{problem: string|null, entries: Map<string, {id: string, pkg: string, severity: string}>}}
 */
export function reduceAudit(audit) {
  const bad = (problem) => ({ problem, entries: new Map() })
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    return bad('the audit output is not a JSON object')
  }
  if (audit.error !== undefined) {
    return bad(`npm audit reported an error: ${JSON.stringify(audit.error).slice(0, 200)}`)
  }
  if (audit.auditReportVersion !== 2) {
    return bad(
      `auditReportVersion ${JSON.stringify(audit.auditReportVersion)} is not the supported 2`
    )
  }
  const vulns = audit.vulnerabilities
  if (!vulns || typeof vulns !== 'object' || Array.isArray(vulns)) {
    return bad('the audit output has no "vulnerabilities" object')
  }
  const entries = new Map()
  for (const [name, v] of Object.entries(vulns)) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.via)) {
      return bad(`vulnerability "${name}" has no "via" array`)
    }
    for (const item of v.via) {
      if (item === null || typeof item !== 'object') continue
      const m = typeof item.url === 'string' ? GHSA_IN_URL.exec(item.url) : null
      const id = m ? m[0] : item.source !== undefined ? `src:${item.source}` : null
      const pkg = typeof item.name === 'string' && item.name ? item.name : null
      if (id === null || pkg === null || typeof item.severity !== 'string') {
        return bad(`an advisory under "${name}" has no usable id, package or severity`)
      }
      const prior = entries.get(key(id, pkg))
      if (prior && prior.severity !== item.severity) {
        return bad(
          `advisory ${id} (${pkg}) is reported with conflicting severities "${prior.severity}" and "${item.severity}"`
        )
      }
      entries.set(key(id, pkg), { id, pkg, severity: item.severity })
    }
  }
  return { problem: null, entries }
}

/**
 * Findings reconciling the registry's acceptances against a parsed audit report:
 * `fail` findings, plus `info` findings for production-scope advisories (not failures).
 * `lock` is the parsed package-lock.json; without a usable one nothing is production.
 */
export function reconcileAudit(registry, audit, lock) {
  const { problem, entries } = reduceAudit(audit)
  if (problem) {
    return [
      f(
        `Check 76 reconcile: the npm audit output is unusable: ${problem}`,
        'Re-run npm audit --json --package-lock-only and inspect its output'
      ),
    ]
  }
  if (!registry || !Array.isArray(registry.acceptances)) {
    return [f(`Check 76 reconcile: ${REGISTRY_PATH} has no "acceptances" array`)]
  }
  const out = []
  const accepted = new Set()
  for (const a of registry.acceptances) {
    if (!a || typeof a !== 'object') continue
    accepted.add(key(a.advisory, a.package))
    const same = [...entries.values()].filter((e) => e.id === a.advisory)
    const hit = same.find((e) => e.pkg === a.package)
    if (same.length === 0) {
      out.push(
        f(
          `Check 76 reconcile: accepted advisory ${a.advisory} (${a.package}) is absent from the npm audit report`,
          'If it is fixed, delete the acceptance; if the id is wrong, correct it'
        )
      )
    } else if (!hit) {
      out.push(
        f(
          `Check 76 reconcile: accepted advisory ${a.advisory} is not for package "${a.package}"; npm audit reports it for ${same.map((e) => `"${e.pkg}"`).join(', ')}`,
          'Correct the acceptance package'
        )
      )
    } else if (hit.severity !== a.severity) {
      out.push(
        f(
          `Check 76 reconcile: accepted advisory ${a.advisory} (${a.package}) is recorded as ${a.severity} but npm audit reports ${hit.severity}`,
          'Correct the acceptance severity'
        )
      )
    }
  }
  for (const e of entries.values()) {
    if (accepted.has(key(e.id, e.pkg))) continue
    const scope = scopeOf(lock, e.pkg)
    if (scope === 'production') {
      out.push(
        info(
          `Check 76 reconcile (informational): advisory ${e.id} (${e.pkg}, ${e.severity}) has no acceptance; ${e.pkg} has a production install, so it is production scope, outside this registry, and governed by the production audit gate (npm audit --omit=dev)`
        )
      )
      continue
    }
    const why =
      scope === 'unknown'
        ? `; ${e.pkg} could not be placed in package-lock.json, so its scope is unknown and it is not treated as production`
        : ''
    out.push(
      f(
        `Check 76 reconcile: unaccepted advisory ${e.id} (${e.pkg}, ${e.severity}) is reported by npm audit and has no acceptance${why}`,
        `Fix it (override or upgrade), or add an acceptance to ${REGISTRY_PATH}`
      )
    )
  }
  return out
}

/** Reads the registry and an audit file and reports through `out`. Returns the failure count. */
export function runReconcileCli(auditPath, opts = {}, out = console.log) {
  const root = opts.root ?? '.'
  out('\nCheck 76 reconcile: registry acceptances vs npm audit (SMI-6949)')
  const fail = (m, fix) => {
    out(`✗ ${m}`)
    if (fix) out(`  Fix: ${fix}`)
  }
  let registry
  let audit
  try {
    registry = JSON.parse(readFileSync(join(root, REGISTRY_PATH), 'utf8'))
  } catch (err) {
    fail(`Check 76 reconcile: cannot read ${REGISTRY_PATH} (${err.message})`)
    return 1
  }
  try {
    audit = JSON.parse(readFileSync(auditPath, 'utf8'))
  } catch (err) {
    fail(
      `Check 76 reconcile: the npm audit output is unusable: cannot read or parse ${auditPath} (${err.message})`
    )
    return 1
  }
  let lock = null
  try {
    lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  } catch {
    // fail closed: with no usable lockfile no unaccepted advisory can be placed in production scope
  }
  const findings = reconcileAudit(registry, audit, lock)
  const failures = findings.filter((x) => x.severity === 'fail')
  const infos = findings.filter((x) => x.severity === 'info')
  for (const x of infos) out(`ℹ ${x.message}`)
  for (const x of failures) fail(x.message, x.fix)
  if (failures.length === 0) {
    const tail =
      infos.length === 0
        ? 'no unaccepted advisories'
        : `no unaccepted dev-scope advisories; ${infos.length} production-scope advisories listed as informational (production audit gate)`
    out(
      `✓ Check 76 reconcile: ${registry.acceptances.length} acceptances match the npm audit report; ${tail}`
    )
  }
  return failures.length
}
