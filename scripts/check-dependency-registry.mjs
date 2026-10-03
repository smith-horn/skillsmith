#!/usr/bin/env node
/**
 * Standalone Check 76 (SMI-6949): the dependency registry is coherent and no
 * acceptance has lapsed. Used by .github/workflows/dependency-registry-expiry.yml,
 * which runs WITHOUT `npm ci`, so this file's import closure must stay node
 * builtins plus repo files only (audit-standards.mjs imports `semver` at top
 * level and cannot run there). Exits 1 on any failure or crash.
 */
import { runDependencyRegistryCli } from './audit-dependency-registry-helpers.mjs'

try {
  process.exit(runDependencyRegistryCli() === 0 ? 0 : 1)
} catch (err) {
  console.error(`Check 76 crashed: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
}
