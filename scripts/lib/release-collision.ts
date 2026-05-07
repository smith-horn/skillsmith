/**
 * Release collision-rule helpers extracted from prepare-release.ts (SMI-4783)
 * to keep the orchestrator under the 500-line file-length budget. Public
 * surface preserved verbatim — same exports, same semantics.
 */

import { execFileSync } from 'child_process'

import semver from 'semver'

import { type PackageSpec } from './version-utils.js'
// SMI-4530: shared with scripts/check-publish-collision.mjs. Drift between the
// two reserved-range definitions was the root cause of PR #824's stuck publish.
import { RESERVED_RANGES, filterReservedVersions } from './reserved-ranges.mjs'
// SMI-4531: full collision-rule unification. Both prepare-release.ts and
// check-publish-collision.mjs now consume the same per-rule evaluators.
import {
  evaluateReservedRange,
  evaluateAlreadyPublished,
  evaluateLiveMax,
} from './collision-rules.mjs'

// --- Types ---

export interface BumpPlan {
  spec: PackageSpec
  currentVersion: string
  newVersion: string
}

export interface CollisionCheckResult {
  ok: boolean
  errors: string[]
  report: string[]
}

export interface NpmLookup {
  latest: string | null
  allVersions: string[] | null
}

// --- NPM Registry Lookup ---

/**
 * Fetch all published versions from npm for a package and return the highest valid semver.
 * Returns null ONLY when npm reports E404 (package does not exist).
 * Throws for any other error (network, timeout, malformed JSON, non-404 npm error) — fail closed.
 */
export async function fetchNpmLatest(pkg: string): Promise<string | null> {
  let stdout: string
  try {
    stdout = execFileSync('npm', ['view', pkg, 'versions', '--json'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    })
  } catch (err: unknown) {
    const e = err as { code?: string; stderr?: string | Buffer; message?: string }
    const stderrText =
      typeof e.stderr === 'string'
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString('utf-8')
          : ''
    const is404 = e.code === 'E404' || /E404/.test(stderrText) || /E404/.test(e.message ?? '')
    if (is404) {
      return null
    }
    throw new Error(
      `npm view ${pkg} failed (fail-closed): ${e.message ?? 'unknown error'}${stderrText ? '\n' + stderrText : ''}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    throw new Error(
      `npm view ${pkg} returned malformed JSON (fail-closed): ${(err as Error).message}`
    )
  }

  // npm view returns either a string (single version) or an array.
  let versions: string[]
  if (typeof parsed === 'string') {
    versions = [parsed]
  } else if (Array.isArray(parsed)) {
    versions = parsed.filter((v): v is string => typeof v === 'string')
  } else {
    throw new Error(`npm view ${pkg} returned unexpected shape (fail-closed): ${typeof parsed}`)
  }

  const valid = versions.filter((v) => semver.valid(v))
  if (valid.length === 0) {
    return null
  }
  const sorted = semver.rsort([...valid])
  return sorted[0] ?? null
}

export async function fetchAllPublishedVersions(pkg: string): Promise<string[] | null> {
  // Same as fetchNpmLatest but returns the full list (for equals-published check).
  // Returns null on E404; throws on other errors.
  let stdout: string
  try {
    stdout = execFileSync('npm', ['view', pkg, 'versions', '--json'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    })
  } catch (err: unknown) {
    const e = err as { code?: string; stderr?: string | Buffer; message?: string }
    const stderrText =
      typeof e.stderr === 'string'
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString('utf-8')
          : ''
    const is404 = e.code === 'E404' || /E404/.test(stderrText) || /E404/.test(e.message ?? '')
    if (is404) return null
    throw new Error(
      `npm view ${pkg} failed (fail-closed): ${e.message ?? 'unknown error'}${stderrText ? '\n' + stderrText : ''}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    throw new Error(
      `npm view ${pkg} returned malformed JSON (fail-closed): ${(err as Error).message}`
    )
  }
  if (typeof parsed === 'string') return [parsed]
  if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
  throw new Error(`npm view ${pkg} returned unexpected shape (fail-closed): ${typeof parsed}`)
}

// --- Collision Guard ---

/**
 * Evaluate the collision rules for a planned bump against the npm registry state.
 * Pure function — does NOT perform network I/O. Callers must supply lookups.
 *
 * SMI-4531: Rules 3 and 2 are now delegated to the shared
 * `scripts/lib/collision-rules.mjs` module — same evaluators
 * `check-publish-collision.mjs` consumes. Rule 1 (reserved-range) lives in
 * `checkReservedVersionRanges` for legacy ordering reasons (it runs in a
 * separate pass before this function in `main()`); the wrapper below also
 * checks Rule 1 defensively so callers that invoke `checkVersionCollision`
 * alone still get correct precedence.
 *
 * Rule 1 — reserved range                → refuse UNCONDITIONALLY (no override).
 * Rule 3 — proposed in published list    → refuse UNCONDITIONALLY (no override).
 *                                          Error must not mention any flag.
 * Rule 2 — proposed <= live max,
 *          not in published list         → refuse unless --allow-downgrade.
 *
 * Multi-package contract: errors accumulate across plans; never short-circuit.
 */
export function checkVersionCollision(
  plans: BumpPlan[],
  lookups: Map<string, NpmLookup>,
  opts: { allowDowngrade: boolean }
): CollisionCheckResult {
  const errors: string[] = []
  const report: string[] = []

  for (const plan of plans) {
    const { spec, newVersion } = plan
    const lookup = lookups.get(spec.name)
    if (!lookup) {
      errors.push(`${spec.name}: internal error — no npm lookup recorded (fail-closed).`)
      continue
    }
    const { latest, allVersions } = lookup

    // New package on npm (E404) — proceed silently.
    if (allVersions === null) {
      report.push(`  ${spec.name}: new on npm (proposed ${newVersion}) → proceed`)
      continue
    }

    // Rule 1 — reserved range (defensive; main() runs checkReservedVersionRanges first).
    const r1 = evaluateReservedRange(spec.name, newVersion)
    if (!r1.ok) {
      errors.push(r1.message)
      continue
    }

    // Rule 3 — exact-equal-published (no override).
    const r3 = evaluateAlreadyPublished(spec.name, newVersion, allVersions)
    if (!r3.ok) {
      errors.push(r3.message)
      continue
    }

    // Rule 2 — live-max <= refuse (overridable via --allow-downgrade).
    const live = filterReservedVersions(spec.name, allVersions, semver)
    if (!live.length) {
      // No live anchor (every entry is reserved). Proceed — Rule 3 already
      // covered the "republish any existing version" case.
      report.push(
        `  ${spec.name}: proposed ${newVersion} (no live versions published yet, all reserved) → proceed`
      )
      continue
    }

    const r2 = evaluateLiveMax(spec.name, newVersion, live, { allowDowngrade: opts.allowDowngrade })
    if (!r2.ok) {
      errors.push(r2.message)
      continue
    }

    const liveMax = live.reduce((a, b) => (semver.gt(a, b) ? a : b))
    if (semver.gt(newVersion, liveMax)) {
      report.push(`  ${spec.name}: proposed ${newVersion} > highest published ${liveMax} → proceed`)
    } else {
      // r2.ok was true → either allowDowngrade=true or live was empty.
      report.push(
        `  ${spec.name}: proposed ${newVersion} <= highest published ${liveMax} (--allow-downgrade set) → proceed`
      )
    }
    // Suppress unused-variable lint for `latest` — kept on the type for now to
    // preserve the public NpmLookup shape; downstream consumers may still read it.
    void latest
  }

  return { ok: errors.length === 0, errors, report }
}

/**
 * Re-export the shared `RESERVED_RANGES` map for downstream consumers and tests
 * that previously imported it from this module.
 *
 * MUST stay in sync with scripts/check-publish-collision.mjs (the publish.yml
 * workflow guard). Both now consume `scripts/lib/reserved-ranges.mjs` as the
 * single source of truth — drift between the two collision implementations was
 * the SMI-4530 failure mode and must not return. See SMI-4531 for the full
 * unification follow-up (Rules 1/2/3 still duplicated by design — the shim
 * avoids pulling tsx into GitHub Actions).
 *
 * SMI-4207 / ADR-115 background: `@skillsmith/core@2.0.0`–`2.1.2` were
 * self-published in January 2026 during an aborted version-strategy experiment
 * and rolled back. The `>=2.0.0 <3.0.0` range is permanently deprecated; the
 * next major for `@skillsmith/core` jumps from 0.x straight to 3.0.0.
 */
export { RESERVED_RANGES }

/**
 * Refuse proposed versions that fall inside reserved/orphaned ranges.
 *
 * Belt-and-suspenders on top of `checkVersionCollision`: the npm-latest guard alone would
 * catch `@skillsmith/core@2.1.3` indirectly, but this rule states the skip explicitly and
 * refuses unconditionally — no `--allow-downgrade` override. Error message points at ADR-115.
 *
 * SMI-4531: Thin wrapper around `evaluateReservedRange` from the shared
 * `scripts/lib/collision-rules.mjs` module. Multi-package contract preserved
 * — errors accumulate per-plan; never short-circuit.
 *
 * Pure function — no network I/O.
 */
export function checkReservedVersionRanges(plans: BumpPlan[]): CollisionCheckResult {
  const errors: string[] = []
  const report: string[] = []

  for (const plan of plans) {
    const { spec, newVersion } = plan
    const result = evaluateReservedRange(spec.name, newVersion)
    if (!result.ok) {
      errors.push(result.message)
      continue
    }
    report.push(`  ${spec.name}: proposed ${newVersion} outside reserved ranges → proceed`)
  }

  return { ok: errors.length === 0, errors, report }
}

/**
 * Resolve npm lookups for every plan. Separated from checkVersionCollision so tests can
 * inject lookups without patching network. Throws (fail-closed) on any non-404 npm error.
 */
export async function resolveNpmLookups(plans: BumpPlan[]): Promise<Map<string, NpmLookup>> {
  const lookups = new Map<string, NpmLookup>()
  for (const plan of plans) {
    const allVersions = await fetchAllPublishedVersions(plan.spec.name)
    let latest: string | null = null
    if (allVersions !== null) {
      // Exclude reserved ranges (SMI-4207 / ADR-115) from the "live" pool used to compute
      // `latest`. Deprecated orphaned versions must not block normal bumps on the live line.
      // `allVersions` retains the full list — Rule 3's isPublished check still catches
      // attempts to republish any existing semver, reserved or not.
      const valid = filterReservedVersions(
        plan.spec.name,
        allVersions.filter((v) => semver.valid(v)),
        semver
      )
      latest = valid.length === 0 ? null : (semver.rsort([...valid])[0] ?? null)
    }
    lookups.set(plan.spec.name, { latest, allVersions })
  }
  return lookups
}
