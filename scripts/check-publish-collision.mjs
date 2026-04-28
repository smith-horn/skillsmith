#!/usr/bin/env node
/**
 * SMI-4188: Pre-publish npm collision mirror guard.
 *
 * Mirrors scripts/prepare-release.ts checkVersionCollision logic as a
 * single-package ESM shim callable directly from GitHub Actions without
 * a tsx runtime. Shares fixtures with prepare-release tests under
 * scripts/tests/fixtures/npm-view/.
 *
 * MUST stay in sync with scripts/prepare-release.ts collision logic.
 * RESERVED_RANGES is now shared via scripts/lib/reserved-ranges.mjs (SMI-4530)
 * so the reserved-range carve-out can never drift between the two guards
 * again — this was the root cause of PR #824's stuck publish. The rest of
 * Rules 1/2/3 (live-pool max, exact-equal-published refusal, error message
 * format) is still duplicated by design (the shim avoids pulling tsx into
 * GitHub Actions). See SMI-4531 for the full unification follow-up.
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

import { filterReservedVersions, isReserved } from './lib/reserved-ranges.mjs'

/**
 * Evaluate a proposed publish against the registry response.
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

  // SMI-4530 / ADR-115: refuse proposed versions that fall inside a reserved
  // range BEFORE computing max — otherwise the diagnostic ("<= highest
  // published") would be both wrong and misleading. Mirrors prepare-release.ts
  // checkReservedVersionRanges. No override flag applies.
  if (semver.valid(targetVersion) && isReserved(pkg, targetVersion, semver)) {
    return {
      code: 1,
      message:
        `${pkg}: proposed ${targetVersion} falls inside the reserved 2.x range ` +
        `(>=2.0.0 <3.0.0). This range is permanently deprecated on npm — the next ` +
        `major must jump to 3.0.0 or later. No override flag applies. ` +
        `See ADR-115 (docs/internal/adr/115-skillsmith-core-version-namespace-reconciliation.md).`,
    }
  }

  // Exact-equal-published check uses the FULL cleaned list, NOT the filtered
  // live list. The reservation is a "you can't reuse this number" rule — even
  // versions inside a reserved range are forbidden from republish.
  if (cleaned.includes(targetVersion)) {
    // Compute a max for the diagnostic — prefer the live max (post-filter) so
    // the message is informative; fall back to the unfiltered max if every
    // published version is reserved.
    const liveForMessage = filterReservedVersions(pkg, cleaned, semver)
    const maxForMessage = (liveForMessage.length ? liveForMessage : cleaned).reduce((a, b) =>
      semver.gt(a, b) ? a : b
    )
    return {
      code: 1,
      message: `${pkg}: proposed ${targetVersion} is already published on npm (highest published: ${maxForMessage})`,
    }
  }

  if (!semver.valid(targetVersion)) {
    return { code: 1, message: `${pkg}: proposed version ${targetVersion} is not a valid semver` }
  }

  // SMI-4530 / ADR-115: filter reserved-range versions out of the "live" pool
  // used to compute `max`. Orphaned 2.x entries on @skillsmith/core must not
  // block normal patches on the live 0.5.x line.
  const live = filterReservedVersions(pkg, cleaned, semver)
  if (!live.length) {
    return {
      code: 0,
      message: `${pkg}: no live versions published yet (all entries inside reserved range), proceeding`,
    }
  }

  const max = live.reduce((a, b) => (semver.gt(a, b) ? a : b))

  if (semver.lte(targetVersion, max)) {
    return { code: 1, message: `${pkg}: proposed ${targetVersion} <= highest published ${max}` }
  }

  return {
    code: 0,
    message: `${pkg}: proposed ${targetVersion} > highest published ${max}, safe to publish`,
  }
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
