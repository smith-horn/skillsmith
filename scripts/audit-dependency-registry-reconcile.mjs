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
 * Scope (ADR-176, SMI-6971): the registry records DEV-scope acceptances; the
 * production gate (`npm audit --omit=dev`) is separate. An unaccepted advisory
 * is printed as informational instead of failing ONLY when an install npm
 * reports as affected by it is a production install (not `dev`, not
 * `devOptional`), because only then does the production gate, which audits
 * production installs, see it. The package NAME is never consulted: a
 * production copy npm does not report as affected proves nothing.
 *
 * Affected installs are the report's `vulnerabilities[<pkg>].nodes` (lockfile
 * paths), looked up in package-lock.json's `packages`. `nodes` is per PACKAGE,
 * the union over every cause in that entry's `via`, so it pins installs to one
 * advisory only when that advisory is the entry's sole cause or every affected
 * install has the same scope. Every other case fails closed: no usable `nodes`,
 * an affected path absent from the lockfile, an unusable lockfile, or a mix of
 * production and dev installs that cannot be attributed to this advisory.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY_PATH } from './audit-dependency-registry-helpers.mjs'

const GHSA_IN_URL = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/
const f = (message, fix) => ({ severity: 'fail', message, fix })
const info = (message) => ({ severity: 'info', message })
const key = (id, pkg) => `${id}\u0000${pkg}`
const isProdInstall = (entry) => entry.dev !== true && entry.devOptional !== true

/** The advisory id of an object `via` item: the GHSA in `url`, else `src:<source>`, else null. */
function advisoryId(item) {
  const m = typeof item.url === 'string' ? GHSA_IN_URL.exec(item.url) : null
  return m ? m[0] : item.source !== undefined ? `src:${item.source}` : null
}

/**
 * The affected installs npm reports for package entry `v`, and whether advisory
 * `id` is that entry's only cause. `nodes` is null when absent, empty, or not
 * all non-empty strings.
 */
function affectedBy(v, id) {
  const usable =
    !!v &&
    typeof v === 'object' &&
    Array.isArray(v.nodes) &&
    v.nodes.length > 0 &&
    v.nodes.every((n) => typeof n === 'string' && n !== '')
  const sole =
    !!v &&
    typeof v === 'object' &&
    Array.isArray(v.via) &&
    v.via.every((x) => x !== null && typeof x === 'object' && advisoryId(x) === id)
  return { nodes: usable ? [...v.nodes] : null, sole }
}

/**
 * Scope of one unaccepted advisory record, from the installs npm reports as affected.
 * @returns {{scope: 'production'|'dev'|'unknown', prod?: string[], why?: string}}
 */
function scopeOf(lock, e) {
  const unknown = (why) => ({ scope: 'unknown', why })
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
    return unknown('package-lock.json is missing or unusable')
  }
  if (e.nodes === null) {
    return unknown(
      `npm audit reports no usable "nodes" for ${e.pkg}, so the affected installs could not be determined`
    )
  }
  const prod = []
  for (const path of e.nodes) {
    const entry = Object.hasOwn(lock.packages, path) ? lock.packages[path] : undefined
    if (!entry || typeof entry !== 'object') {
      return unknown(
        `affected install "${path}" is not in package-lock.json, so the affected installs could not be determined`
      )
    }
    if (isProdInstall(entry)) prod.push(path)
  }
  if (prod.length === 0) return { scope: 'dev' }
  if (prod.length === e.nodes.length || e.sole) return { scope: 'production', prod }
  return unknown(
    `npm reports ${e.pkg}'s affected installs as one set across several causes, some production and some dev, so the installs this advisory affects could not be determined`
  )
}

/**
 * Direct advisories in an npm audit v2 report: one entry per object `via` item
 * (string `via` items are transitive links, not advisories). The id is the GHSA
 * in `url`, else `src:<source>`; an item with neither is unusable. Each record
 * carries the `nodes` of its package's own entry, `vulnerabilities[pkg]`, and
 * `sole`: whether the advisory is that entry's only `via` cause.
 * @returns {{problem: string|null, entries: Map<string, {id: string, pkg: string, severity: string, nodes: string[]|null, sole: boolean}>}}
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
      const id = advisoryId(item)
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
      const own = Object.hasOwn(vulns, pkg) ? vulns[pkg] : undefined
      entries.set(key(id, pkg), { id, pkg, severity: item.severity, ...affectedBy(own, id) })
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
    const { scope, prod, why } = scopeOf(lock, e)
    if (scope === 'production') {
      out.push(
        info(
          `Check 76 reconcile (informational): advisory ${e.id} (${e.pkg}, ${e.severity}) has no acceptance; npm audit reports it affecting production install(s) ${prod.join(', ')}, so it is production scope, outside this registry, and governed by the production audit gate (npm audit --omit=dev)`
        )
      )
      continue
    }
    const tail = why ? `; ${why}; it is not treated as production` : ''
    out.push(
      f(
        `Check 76 reconcile: unaccepted advisory ${e.id} (${e.pkg}, ${e.severity}) is reported by npm audit and has no acceptance${tail}`,
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
