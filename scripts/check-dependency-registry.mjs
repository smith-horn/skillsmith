#!/usr/bin/env node
/**
 * Standalone Check 76 (SMI-6949): the dependency registry is coherent and no
 * acceptance has lapsed. Used by .github/workflows/dependency-registry-expiry.yml,
 * which runs WITHOUT `npm ci`, so this file's import closure must stay node
 * builtins plus repo files only (audit-standards.mjs imports `semver` at top
 * level and cannot run there). Exits 0 when clean, 1 on any failure or crash, 2 on bad usage.
 *
 * `--reconcile-audit <audit.json>` instead reconciles the registry's acceptances
 * against `npm audit --json --package-lock-only` output (exit 1 on any failure;
 * an unaccepted advisory npm reports affecting a production install is only
 * informational -- see audit-dependency-registry-reconcile.mjs for the rule).
 *
 * `--reconcile-audit <audit.json> --seed <lockfile>` reconciles one `seeds` section against
 * an audit run inside that seed's directory; every unaccepted advisory fails
 * (audit-dependency-registry-reconcile-seed.mjs). `--list-seeds` prints the `seeds` keys,
 * one per line, for the workflow's loop (SMI-6954).
 */
import { runDependencyRegistryCli } from './audit-dependency-registry-helpers.mjs'
import { runReconcileCli } from './audit-dependency-registry-reconcile.mjs'
import { runSeedReconcileCli } from './audit-dependency-registry-reconcile-seed.mjs'
import { listSeedKeys } from './audit-dependency-registry-seeds.mjs'

const USAGE =
  'usage: check-dependency-registry.mjs [--list-seeds | --reconcile-audit <audit.json> [--seed <lockfile>]]'

try {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    process.exit(runDependencyRegistryCli() === 0 ? 0 : 1)
  } else if (args.length === 1 && args[0] === '--list-seeds') {
    const r = listSeedKeys()
    if (r.error) {
      console.error(`Check 76 --list-seeds: ${r.error}`)
      process.exit(1)
    }
    for (const k of r.keys) console.log(k)
    process.exit(0)
  } else if (args.length === 2 && args[0] === '--reconcile-audit' && args[1]) {
    process.exit(runReconcileCli(args[1]) === 0 ? 0 : 1)
  } else if (
    args.length === 4 &&
    args[0] === '--reconcile-audit' &&
    args[1] &&
    args[2] === '--seed' &&
    args[3]
  ) {
    process.exit(runSeedReconcileCli(args[1], args[3]) === 0 ? 0 : 1)
  } else {
    console.error(USAGE)
    process.exit(2)
  }
} catch (err) {
  console.error(`Check 76 crashed: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
}
