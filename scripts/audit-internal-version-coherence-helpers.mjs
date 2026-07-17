/**
 * audit-internal-version-coherence-helpers — pure decision layer for
 * audit-standards.mjs Check 58 (SMI-5715).
 *
 * Background: `packages/doc-retrieval-mcp/package.json` pinned
 * `@skillsmith/core` to `^0.8.0` while the workspace's actual
 * `@skillsmith/core` version had moved to `0.11.2` — three minor versions of
 * silent drift, invisible because nothing checked that internal
 * `@skillsmith/*`/`@smith-horn/*` dependency ranges track the workspace's
 * actual current versions. That single stale range broke both Turborepo's
 * `dependsOn: ["^build"]` task-graph edge (Turbo only creates the edge when
 * the declared range IS satisfied by the workspace version) and npm's
 * workspace-symlink resolution (a fresh worktree's first build resolved the
 * nested registry tarball instead of the hoisted workspace symlink). See
 * docs/internal/implementation/smi-5715-doc-retrieval-core-version-drift.md
 * for the full root-cause writeup.
 *
 * This module is the pure matching/decision layer only — no fs/git I/O. The
 * caller (Check 58 in audit-standards.mjs) does the `packages/*` directory
 * walk + `JSON.parse` and hands the parsed package.json content in here;
 * this module decides ok/violation/dangling per scanned dependency entry.
 *
 * Uses the real `semver` package (a transitive dependency already relied on
 * directly elsewhere in scripts/ — see scripts/lib/collision-rules.mjs and
 * scripts/check-publish-collision.mjs) rather than the minimal zero-dep
 * subset in audit-standards-helpers.mjs, which is explicitly scoped to the
 * narrower operator set used by root package.json overrides and says so in
 * its own doc comment ("DO NOT use for application code").
 */
import semver from 'semver'

const INTERNAL_SCOPES = ['@skillsmith/', '@smith-horn/']

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies']

function isInternalDepName(name) {
  return INTERNAL_SCOPES.some((scope) => name.startsWith(scope))
}

/**
 * @typedef {Object} CoherenceResult
 * @property {string} dir - workspace package directory name (e.g. 'doc-retrieval-mcp')
 * @property {string} section - 'dependencies' | 'devDependencies' | 'peerDependencies'
 * @property {string} depName - the scanned @skillsmith/*|@smith-horn/* dependency name
 * @property {string} range - the declared semver range
 * @property {'ok'|'violation'|'dangling'} status
 * @property {string} [actualVersion] - the dependency's actual workspace version (absent for 'dangling')
 */

/**
 * Walk every package's `dependencies`/`devDependencies`/`peerDependencies`
 * section for `@skillsmith/*`/`@smith-horn/*` entries and classify each
 * against the actual workspace version of the referenced package.
 *
 * A bare `*` range is skipped entirely (no result emitted) — it always
 * trivially satisfies any version. This skip is intentional: without it,
 * every legitimately-unconstrained peer dependency (e.g. an optional
 * integration that deliberately floats) would start failing this check. Do
 * not remove it.
 *
 * A scanned name with no corresponding workspace package (e.g. a typo, or
 * `packages/cli`'s `@skillsmith/enterprise` peer dep — the real package is
 * named `@smith-horn/enterprise`, tracked separately as SMI-5720) is
 * reported as 'dangling', not 'violation' — a wrong/stale package NAME is a
 * different bug class than a stale version RANGE, and must not attempt
 * `semver.satisfies()` against an unresolved version (which throws rather
 * than returning false).
 *
 * Optional peer dependencies (`peerDependenciesMeta.<name>.optional ===
 * true`) are NOT special-cased here — they are scanned and classified with
 * the exact same status/severity as a required dependency whenever the
 * range is non-wildcard and the name resolves to a real workspace package.
 * "Optional" only means the consumer doesn't require the package installed;
 * it does not exempt the declared range from version-coherence.
 *
 * @param {Record<string, {
 *   name?: string,
 *   version?: string,
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string>,
 * }>} packagesByDir - workspace package directory name → parsed package.json
 * @returns {CoherenceResult[]}
 */
export function evaluateInternalVersionCoherence(packagesByDir) {
  const workspaceVersions = new Map()
  for (const pkg of Object.values(packagesByDir)) {
    if (pkg && typeof pkg.name === 'string') {
      workspaceVersions.set(pkg.name, pkg.version)
    }
  }

  const results = []

  for (const [dir, pkg] of Object.entries(packagesByDir)) {
    if (!pkg) continue

    for (const section of SECTIONS) {
      const deps = pkg[section]
      if (!deps || typeof deps !== 'object') continue

      for (const [depName, range] of Object.entries(deps)) {
        if (!isInternalDepName(depName)) continue

        if (!workspaceVersions.has(depName)) {
          results.push({ dir, section, depName, range, status: 'dangling' })
          continue
        }

        // Skip bare '*' — see doc comment above. Checked AFTER the dangling
        // check above on purpose: a dangling name is still worth surfacing
        // even when its declared range happens to be '*' (the real problem
        // is the name doesn't resolve at all, independent of the range).
        if (range === '*') continue

        const actualVersion = workspaceVersions.get(depName)
        if (typeof actualVersion !== 'string') {
          // Resolved name, but that workspace package.json has no "version"
          // field. Guard explicitly — semver.satisfies(undefined, range)
          // throws instead of returning false.
          results.push({ dir, section, depName, range, status: 'dangling', actualVersion })
          continue
        }

        const ok = semver.satisfies(actualVersion, range)
        results.push({
          dir,
          section,
          depName,
          range,
          actualVersion,
          status: ok ? 'ok' : 'violation',
        })
      }
    }
  }

  return results
}
