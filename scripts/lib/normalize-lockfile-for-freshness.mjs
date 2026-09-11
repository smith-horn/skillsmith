/**
 * SMI-6496 Fix 2 — shadow-hash normalization for the node_modules freshness
 * guard (scripts/lib/check-node-modules-fresh.sh).
 *
 * A weekly release-cadence commit (ADR-114) only bumps workspace-self
 * "version" fields plus the semver ranges other workspace packages declare
 * on those same internal packages — real installed bytes under
 * node_modules/* never change. The freshness guard's existing raw sha256 of
 * package-lock.json cannot tell that apart from a real dependency change, so
 * every worktree that has not yet rebased onto a release-cadence commit
 * trips the guard for no reason.
 *
 * This module computes a second, normalized hash ("shadow hash") of the
 * lockfile with workspace-self version bumps neutralized. Wave 1 uses it
 * only as a diagnostic label alongside the existing raw-hash decision — see
 * check-node-modules-fresh.sh's shadow-hash block. Wave 2 (after the shadow
 * soak period in docs/internal/process/guards-and-opt-outs.md ends) flips
 * the actual pass/fail decision onto this hash.
 *
 * Algorithm (normalize()):
 *   1. Derive the internal-package-name set from package-lock.json itself:
 *      for every packages["<key>"] where <key> is "" (root) or matches an
 *      entry in root package.json's `workspaces` glob (e.g. "packages/*"),
 *      take `entry.name ?? basename(key)`. The `?? basename(key)` fallback
 *      is required — npm omits `packages["<key>"].name` when it equals the
 *      directory's own basename (confirmed:
 *      packages/skillsmith-cli's lockfile entry has no "name" field at all);
 *      `entry.name` alone would silently drop that workspace from the set.
 *   2. For each of those workspace entries: delete the "version" field.
 *   3. For EVERY entry in the packages map (workspace or node_modules/*)
 *      with a dependencies/devDependencies/peerDependencies/
 *      optionalDependencies object: for any key in the internal-name set,
 *      replace the value (semver range) with a constant placeholder — NEVER
 *      delete the key. Neutralizing only the value, never the key's
 *      presence/absence, is the critical invariant: adding or removing any
 *      dependency (internal or external) changes the key set, which changes
 *      the hash. Only "same dependency edges, only version-number
 *      differences inside the neutralized set" is treated as cosmetic.
 *   4. Re-serialize deterministically (JSON.parse + JSON.stringify preserves
 *      V8 insertion order) and sha256 the result.
 *
 * This module never touches disk on its own (computeShadowHash takes raw
 * text, not paths) — the CLI entrypoint below does the one read pair, so
 * tests can feed content pulled straight from `git show <rev>:<path>`
 * without writing temp files.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const PLACEHOLDER = '<internal>'

/**
 * True if `key` (a package-lock.json `packages` map key, e.g.
 * "packages/core") is matched by workspace glob `glob` (e.g. "packages/*").
 * Only single-level trailing-"*" globs are supported — this repo's
 * `package.json` only ever declares `["packages/*"]`, so a fuller glob
 * matcher would be solving a problem this repo does not have.
 *
 * @param {string} key
 * @param {string} glob
 * @returns {boolean}
 */
function matchesWorkspaceGlob(key, glob) {
  if (typeof glob !== 'string' || !glob.endsWith('/*')) return false
  const prefix = glob.slice(0, -1) // "packages/"
  if (!key.startsWith(prefix)) return false
  const rest = key.slice(prefix.length)
  return rest.length > 0 && !rest.includes('/')
}

/**
 * @param {string} key - a package-lock.json `packages` map key
 * @param {string[]} workspaceGlobs
 * @returns {boolean}
 */
function isWorkspaceSelfKey(key, workspaceGlobs) {
  return key === '' || workspaceGlobs.some((glob) => matchesWorkspaceGlob(key, glob))
}

/**
 * Computes the shadow hash of a package-lock.json (as raw text), given the
 * repo-root package.json (as raw text) for its `workspaces` globs.
 *
 * @param {string} lockfileText
 * @param {string} packageJsonText
 * @returns {string} hex sha256 digest of the normalized lockfile
 * @throws {Error} on invalid JSON or an unexpected lockfile shape (missing
 *   "packages" map) — callers must fall back to the raw-byte comparison on
 *   any thrown error (fail-soft contract, never "treat as fresh").
 */
export function computeShadowHash(lockfileText, packageJsonText) {
  const lock = JSON.parse(lockfileText)
  const pkg = JSON.parse(packageJsonText)

  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('lockfile has no "packages" map — unexpected npm lockfile shape')
  }

  const workspaceGlobs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : []

  // Step 1: derive the internal-package-name set.
  const internalNames = new Set()
  for (const key of Object.keys(lock.packages)) {
    if (!isWorkspaceSelfKey(key, workspaceGlobs)) continue
    const entry = lock.packages[key]
    if (!entry || typeof entry !== 'object') continue
    const name = entry.name ?? (key === '' ? undefined : basename(key))
    if (name) internalNames.add(name)
  }

  // Steps 2 and 3: mutate a normalized copy in place (JSON.parse output is
  // ours alone — no aliasing with the caller's data).
  for (const key of Object.keys(lock.packages)) {
    const entry = lock.packages[key]
    if (!entry || typeof entry !== 'object') continue

    if (isWorkspaceSelfKey(key, workspaceGlobs)) {
      delete entry.version
    }

    for (const field of DEP_FIELDS) {
      const deps = entry[field]
      if (!deps || typeof deps !== 'object') continue
      for (const depName of Object.keys(deps)) {
        if (internalNames.has(depName)) {
          deps[depName] = PLACEHOLDER
        }
      }
    }
  }

  // Step 4: deterministic re-serialize (JSON.parse/JSON.stringify preserves
  // V8's own insertion order — the input's own key order is never reordered
  // by this module) and hash.
  const normalized = JSON.stringify(lock)
  return createHash('sha256').update(normalized).digest('hex')
}

// CLI entrypoint — only runs when invoked directly via
// `node scripts/lib/normalize-lockfile-for-freshness.mjs <package-lock.json> <package.json>`.
// Follows this repo's existing import.meta.url-based CLI-detection idiom
// (see scripts/lib/linux-optional-packages.mjs).
//
// Fail-soft contract (plan's M4): on ANY failure — missing/unreadable file,
// invalid JSON, unexpected shape — print nothing to stdout, a one-line
// reason to stderr, and exit 1. The caller (check-node-modules-fresh.sh)
// must treat a non-zero exit / empty stdout as "shadow hash unavailable"
// and fall back to the existing raw-byte comparison, never to "treat as
// fresh" — falling back to "fresh" would silently disable all drift
// detection.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('normalize-lockfile-for-freshness.mjs')

if (isMain) {
  const [, , lockfilePath, packageJsonPath] = process.argv
  try {
    if (!lockfilePath || !packageJsonPath) {
      throw new Error(
        'usage: normalize-lockfile-for-freshness.mjs <package-lock.json> <package.json>'
      )
    }
    const lockfileText = readFileSync(lockfilePath, 'utf8')
    const packageJsonText = readFileSync(packageJsonPath, 'utf8')
    const hash = computeShadowHash(lockfileText, packageJsonText)
    process.stdout.write(hash + '\n')
    process.exit(0)
  } catch (err) {
    process.stderr.write(
      `[normalize-lockfile-for-freshness] ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
  }
}
