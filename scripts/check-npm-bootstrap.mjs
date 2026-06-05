#!/usr/bin/env node
/**
 * SMI-5122: Pre-publish fail-fast for an unregistered new npm package.
 *
 * The publish.yml `pre-publish-check` job's existing `Check version
 * availability` step only asks "does <pkg>@<version> exist?". A brand-new
 * package added to PUBLISHABLE_PACKAGES_JSON that was never published gets
 * `<x>_exists=false` and proceeds to a publish job that dies with an opaque
 * E404 — because npm OIDC trusted-publishing CANNOT bootstrap a package that
 * does not already exist on npm. The package must first be registered as a
 * trusted publisher on npmjs.com.
 *
 * This shim distinguishes "package has zero versions on npm" (a hard,
 * actionable failure) from "the network/registry was unreachable" (must NOT
 * block a publish — mirror Check 21's SMI-5080 graceful-skip approach). The
 * network-error signal list is intentionally copied from Check 21
 * (scripts/audit-standards.mjs, SMI-5080) plus the npm-specific E* error
 * codes, so that a flaky registry or a CA-less Docker image degrades to a
 * non-blocking `::warning::`, never a false `::error::`.
 *
 * Usage: node scripts/check-npm-bootstrap.mjs <pkg>
 *
 * Exit codes:
 *   0  package exists on npm (≥1 version)            → log ok
 *   0  existence could not be verified (network)     → ::warning::, skip gate
 *   1  package has no versions on npm (missing/404)  → ::error::, block publish
 *   2  usage error (missing args)
 */
import { execFileSync } from 'node:child_process'

/**
 * Network/registry-unreachable signals. The first group mirrors Check 21's
 * SMI-5080 list verbatim (scripts/audit-standards.mjs); the second group adds
 * the npm/node DNS + socket error codes that surface as `npm view` stderr.
 */
const NETWORK_ERROR_REGEX =
  /unable to access|Could not resolve host|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|certificate/i

/** npm "package does not exist" signals. */
const NOT_FOUND_REGEX = /E404|404 Not Found|is not in this registry/i

/**
 * Classify the result of an `npm view <pkg> version` invocation.
 *
 * Conservative by design: any empty-stdout case that does not clearly match a
 * not-found signal is treated as `'network-error'` (never block on ambiguity).
 *
 * @param {{ stdout?: string, stderr?: string }} io
 * @returns {'exists' | 'missing' | 'network-error'}
 */
export function classifyNpmExistence({ stdout = '', stderr = '' } = {}) {
  if (String(stdout).trim()) return 'exists'
  if (NOT_FOUND_REGEX.test(String(stderr))) return 'missing'
  if (NETWORK_ERROR_REGEX.test(String(stderr))) return 'network-error'
  // Empty stdout, no recognizable signal — fail open (do not block).
  return 'network-error'
}

/**
 * Build the actionable error message for a missing (never-published) package.
 *
 * @param {string} pkg
 * @returns {string}
 */
export function bootstrapErrorMessage(pkg) {
  return (
    `${pkg} is in PUBLISHABLE_PACKAGES_JSON (.github/workflows/publish.yml) and ` +
    `PACKAGE_SPECS (scripts/lib/version-utils.ts) but has no versions on npm. ` +
    `OIDC trusted-publishing cannot bootstrap a new package — first register it as ` +
    `a trusted publisher on npmjs.com (Settings -> Trusted Publisher -> repo ` +
    `smith-horn/skillsmith, workflow publish.yml). ` +
    `See publishing-guide.md (New-package onboarding).`
  )
}

/**
 * Run `npm view <pkg> version`, capturing both stdout and stderr, and classify.
 *
 * `npm view` exits non-zero on a 404, so the stderr is read off the thrown
 * error's `.stderr` field in that path.
 *
 * @param {string} pkg
 * @param {{ exec?: typeof execFileSync }} [deps] - injectable for tests
 * @returns {'exists' | 'missing' | 'network-error'}
 */
export function checkNpmExistence(pkg, deps = {}) {
  const exec = deps.exec || execFileSync
  try {
    const stdout = exec('npm', ['view', pkg, 'version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
    })
    return classifyNpmExistence({ stdout, stderr: '' })
  } catch (err) {
    const stdout = err && err.stdout ? String(err.stdout) : ''
    const stderr = err && err.stderr ? String(err.stderr) : String((err && err.message) || '')
    return classifyNpmExistence({ stdout, stderr })
  }
}

// CLI entrypoint. Only runs when invoked directly, not when imported in tests.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-npm-bootstrap.mjs')

if (isMain) {
  const [, , pkg] = process.argv
  if (!pkg) {
    console.error('usage: check-npm-bootstrap.mjs <pkg>')
    process.exit(2)
  }

  const verdict = checkNpmExistence(pkg)
  if (verdict === 'exists') {
    console.log(`✓ ${pkg} exists on npm — bootstrap gate satisfied`)
    process.exit(0)
  }
  if (verdict === 'network-error') {
    console.log(`::warning::could not verify ${pkg} existence, skipping bootstrap gate`)
    process.exit(0)
  }
  // 'missing'
  console.error(`::error::${bootstrapErrorMessage(pkg)}`)
  process.exit(1)
}
