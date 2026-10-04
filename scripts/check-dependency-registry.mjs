#!/usr/bin/env node
/**
 * Standalone Check 76 (SMI-6949): the dependency registry is coherent and no
 * acceptance has lapsed. Used by .github/workflows/dependency-registry-expiry.yml,
 * which runs WITHOUT `npm ci`, so this file's import closure must stay node
 * builtins plus repo files only (audit-standards.mjs imports `semver` at top
 * level and cannot run there). Exits 1 on any failure or crash.
 *
 * `--reconcile-audit <audit.json>` instead reconciles the registry's acceptances
 * against `npm audit --json --package-lock-only` output (exit 1 on any finding).
 */
import { runDependencyRegistryCli } from './audit-dependency-registry-helpers.mjs'
import { runReconcileCli } from './audit-dependency-registry-reconcile.mjs'

try {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    process.exit(runDependencyRegistryCli() === 0 ? 0 : 1)
  } else if (args.length === 2 && args[0] === '--reconcile-audit' && args[1]) {
    process.exit(runReconcileCli(args[1]) === 0 ? 0 : 1)
  } else {
    console.error('usage: check-dependency-registry.mjs [--reconcile-audit <audit.json>]')
    process.exit(2)
  }
} catch (err) {
  console.error(`Check 76 crashed: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
}
