#!/usr/bin/env node
/**
 * SMI-4188: Pre-publish npm collision mirror guard.
 *
 * Single-package ESM shim callable directly from GitHub Actions without a tsx
 * runtime. Shares fixtures with prepare-release tests under
 * scripts/tests/fixtures/npm-view/.
 *
 * SMI-4531: Rules 1/2/3 are now consumed from `scripts/lib/collision-rules.mjs`
 * — the single source of truth shared with `scripts/prepare-release.ts`. Drift
 * between the two collision implementations was the root cause of PR #824's
 * stuck publish (SMI-4530 surfaced the partial fix; SMI-4531 closed it).
 *
 * Usage: node scripts/check-publish-collision.mjs <pkg> <targetVersion>
 *
 * Exit codes:
 *   0  target > max published AND target not in versions (safe to publish)
 *   0  package not yet published (E404 on npm view)
 *   0  every published version sits inside a reserved range (no live anchor)
 *   1  target inside reserved range (ADR-115 refusal)
 *   1  target <= max published OR target exact-equal published
 *   1  network / parse error (fail closed)
 *   2  usage error (missing args)
 *
 * Respects NPM_CONFIG_REGISTRY env var for GitHub Packages (enterprise).
 */
import { execFileSync } from 'node:child_process'
import semver from 'semver'

import { evaluateCollisionRules } from './lib/collision-rules.mjs'

/**
 * Evaluate a proposed publish against the registry response.
 *
 * @param {string} pkg - package name
 * @param {string} targetVersion - proposed version
 * @param {{exec?: typeof execFileSync}} [deps] - for tests
 * @returns {{code: 0 | 1, message: string}}
 */
export function evaluateCollision(pkg, targetVersion, deps = {}) {
  const exec = deps.exec || execFileSync

  let raw
  try {
    raw = exec('npm', ['view', pkg, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: 30_000,
    })
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : ''
    if (stderr.includes('E404') || stderr.includes('404 Not Found')) {
      return { code: 0, message: `${pkg}: new package (404 from npm view), proceeding` }
    }
    const msg = err && err.message ? err.message : 'unknown error'
    return { code: 1, message: `${pkg}: failed to query npm view — ${msg}` }
  }

  if (!raw || !String(raw).trim()) {
    return { code: 0, message: `${pkg}: no versions published yet, proceeding` }
  }

  let versions
  try {
    const parsed = JSON.parse(raw)
    versions = Array.isArray(parsed) ? parsed : [parsed]
  } catch (err) {
    return { code: 1, message: `${pkg}: failed to parse npm view output — ${err.message}` }
  }

  if (!versions.length) {
    return { code: 0, message: `${pkg}: no versions published yet, proceeding` }
  }

  const cleaned = versions.filter((v) => typeof v === 'string' && semver.valid(v))
  if (!cleaned.length) {
    return { code: 1, message: `${pkg}: npm view returned no valid semver entries` }
  }

  // Surface invalid-semver targets BEFORE the rule pipeline. Rule 1 already
  // tolerates invalid semver (it can't classify), so we need the explicit
  // check here to keep the historical error message stable.
  if (!semver.valid(targetVersion)) {
    return { code: 1, message: `${pkg}: proposed version ${targetVersion} is not a valid semver` }
  }

  // SMI-4531: delegate to the shared rule pipeline. allowDowngrade is fixed
  // to false here — the publish.yml guard is intentionally strict; only the
  // .ts caller (prepare-release) wires the user's --allow-downgrade flag.
  const result = evaluateCollisionRules(pkg, targetVersion, cleaned, { allowDowngrade: false })
  return result.ok ? { code: 0, message: result.message } : { code: 1, message: result.message }
}

// CLI entrypoint. Only runs when invoked directly, not when imported in tests.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-publish-collision.mjs')

if (isMain) {
  const [, , pkg, targetVersion] = process.argv
  if (!pkg || !targetVersion) {
    console.error('usage: check-publish-collision.mjs <pkg> <targetVersion>')
    process.exit(2)
  }
  const { code, message } = evaluateCollision(pkg, targetVersion)
  if (code === 0) {
    console.log(message)
  } else {
    console.error(`::error::${message}`)
  }
  process.exit(code)
}
