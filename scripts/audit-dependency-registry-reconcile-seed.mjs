/**
 * Check 76 --reconcile-audit <audit.json> --seed <lockfile> (SMI-6954, ADR-176 section 6):
 * reconciles one seed section's acceptances against `npm audit --json --package-lock-only`
 * run INSIDE that seed's directory.
 *
 * Differences from the root reconcile (audit-dependency-registry-reconcile.mjs), by design:
 * - Every unaccepted advisory fails, at any severity and any install scope. No other blocking
 *   gate or scheduled npm audit job evaluates the standing seed tree (Dependency Guard sees only
 *   a PR's added or changed seed dependencies, at high or above; Dependabot alerts are
 *   non-blocking), so there is no production or informational escape: the root reconcile's
 *   `isProdInstall` would classify all of a seed's non-dev installs as production and pass.
 * - The report must be for this seed: its `metadata.dependencies.total` must equal the seed
 *   lockfile's non-root entry count, and every affected install (`nodes`) must be a path in the
 *   seed lockfile. A root report fed to `--seed`, or an audit run from the wrong directory,
 *   fails instead of reconciling against the wrong tree.
 * - The acceptance checks (absent, wrong package, wrong severity) are shared with the root.
 *
 * Fails closed on an unreadable registry, audit or seed lockfile. Import closure: node
 * builtins and repo files only (the scheduled workflow runs it without `npm ci`).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY_PATH } from './audit-dependency-registry-helpers.mjs'
import { hasOwn, lockProblem } from './audit-dependency-registry-fields.mjs'
import { key, matchAcceptances, reduceAudit } from './audit-dependency-registry-reconcile.mjs'
import { seedKeyProblem } from './audit-dependency-registry-seeds.mjs'

const f = (message, fix) => ({ severity: 'fail', message, fix })
const RERUN = (seedKey) =>
  `Re-run the audit inside the seed directory: (cd ${seedKey.replace(/\/package-lock\.json$/, '')} && npm audit --json --package-lock-only --offline=false --prefer-offline=false --registry=https://registry.npmjs.org --userconfig=/dev/null)`

/** Why `audit` cannot be a report on `seedLock`, or null. */
function wrongTree(seedKey, audit, entries, seedLock) {
  const lockTotal = Object.keys(seedLock.packages).filter((k) => k !== '').length
  const total = audit?.metadata?.dependencies?.total
  if (typeof total !== 'number' || total !== lockTotal) {
    return `it reports ${JSON.stringify(total ?? null)} dependencies and ${seedKey} has ${lockTotal}`
  }
  for (const e of entries.values()) {
    if (e.nodes === null) {
      return `advisory ${e.id} (${e.pkg}) has no usable "nodes", so its installs cannot be placed in ${seedKey}`
    }
    const missing = e.nodes.find((n) => !hasOwn(seedLock.packages, n))
    if (missing !== undefined) return `affected install "${missing}" is not in it`
  }
  return null
}

/**
 * Findings for one seed section. `section` is `registry.seeds[seedKey]`; `seedLock` the parsed
 * seed lockfile. Only `fail` findings: nothing about a seed is informational.
 */
export function reconcileSeedAudit(seedKey, section, audit, seedLock) {
  const P = `Check 76 reconcile [${seedKey}]`
  const { problem, entries } = reduceAudit(audit)
  if (problem) return [f(`${P}: the npm audit output is unusable: ${problem}`, RERUN(seedKey))]
  const lockWhy =
    !seedLock || typeof seedLock !== 'object' ? 'not an object' : lockProblem(seedLock)
  if (lockWhy) return [f(`${P}: ${seedKey} is unusable: ${lockWhy}`)]
  if (!section || typeof section !== 'object' || !Array.isArray(section.acceptances)) {
    return [f(`${P}: seeds["${seedKey}"] in ${REGISTRY_PATH} has no "acceptances" array`)]
  }
  const why = wrongTree(seedKey, audit, entries, seedLock)
  if (why) return [f(`${P}: the npm audit report is not for ${seedKey}: ${why}`, RERUN(seedKey))]
  const out = []
  const accepted = matchAcceptances(section.acceptances, entries, out, P)
  for (const e of entries.values()) {
    if (accepted.has(key(e.id, e.pkg))) continue
    out.push(
      f(
        `${P}: unaccepted advisory ${e.id} (${e.pkg}, ${e.severity}) is reported by npm audit for ${seedKey} and has no acceptance; no other blocking gate or scheduled npm audit job evaluates the standing seed tree, so every advisory needs a fix or an acceptance at any severity and scope`,
        `Fix it with a seed override (the seed's own package.json overrides plus seeds["${seedKey}"].overrides), or add an acceptance under seeds["${seedKey}"] in ${REGISTRY_PATH}`
      )
    )
  }
  return out
}

/** `--reconcile-audit <audit> --seed <key>`: reads the inputs, reports through `out`, returns the failure count. */
export function runSeedReconcileCli(auditPath, seedKey, opts = {}, out = console.log) {
  const root = opts.root ?? '.'
  const P = `Check 76 reconcile [${seedKey}]`
  out(`\nCheck 76 reconcile: seed acceptances vs npm audit for ${seedKey} (SMI-6954)`)
  const fail = (m, fix) => {
    out(`✗ ${m}`)
    if (fix) out(`  Fix: ${fix}`)
    return 1
  }
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
  let registry
  try {
    registry = read(join(root, REGISTRY_PATH))
  } catch (err) {
    return fail(`${P}: cannot read ${REGISTRY_PATH} (${err.message})`)
  }
  const seeds = registry?.seeds
  if (seedKeyProblem(seedKey) || !seeds || typeof seeds !== 'object' || !hasOwn(seeds, seedKey)) {
    return fail(
      `${P}: ${seedKey} is not a key of "seeds" in ${REGISTRY_PATH}, so there is nothing to reconcile it against`,
      'Pass a key printed by --list-seeds'
    )
  }
  let audit
  try {
    audit = read(auditPath)
  } catch (err) {
    return fail(
      `${P}: the npm audit output is unusable: cannot read or parse ${auditPath} (${err.message})`
    )
  }
  let seedLock
  try {
    seedLock = read(join(root, seedKey))
  } catch (err) {
    return fail(`${P}: cannot read ${seedKey} (${err.message})`)
  }
  const findings = reconcileSeedAudit(seedKey, seeds[seedKey], audit, seedLock)
  for (const x of findings) fail(x.message, x.fix)
  if (findings.length === 0) {
    out(
      `✓ ${P}: ${seeds[seedKey].acceptances.length} acceptances match the npm audit report for ${seedKey}; no unaccepted advisories`
    )
  }
  return findings.length
}
