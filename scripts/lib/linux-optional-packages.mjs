/**
 * SMI-6050 Wave 1 — shared derivation of "Tier B" linux-only optional
 * platform binaries from package-lock.json.
 *
 * See docs/internal/implementation/smi-6050-worktree-linux-optional-platform-binaries.md
 * ("What Changes" #1) for full rationale. Both the host (compose-file
 * generation, scripts/_lib.sh) and the Docker image build call this same
 * script so package-lock.json stays the single source of truth for which
 * linux-optional packages need to be seeded into worktree containers —
 * npm silently skips `optionalDependencies` entries whose `os` field
 * doesn't match the installing platform, so any build tool shipping its
 * native logic that way (turbo, Astro's compiler, Rollup/Rolldown,
 * Lightning CSS, ruvector, ...) is invisible on a macOS host tree that a
 * Linux worktree container reads read-only.
 *
 * `package-lock.json`'s `packages` map is keyed by `node_modules/...`
 * relative paths — including nested positions like
 * `node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu`
 * where a dependency vendors its own independently-versioned copy. Those
 * nested keys are real, first-class entries in the map already; this
 * module does not need to derive or reconstruct them.
 *
 * Filtering is `os` field only (`os: ["linux"]` exactly) — `cpu` is left
 * unfiltered, since every arch/libc variant for a linux-only family is
 * itself a distinct, real package-lock.json entry that needs its own seed.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// scripts/lib/linux-optional-packages.mjs -> repo root is two levels up.
// Resolved from this file's own location (not process.cwd()) so the CLI
// entry point below works correctly regardless of invocation directory —
// including from inside a Docker build stage where cwd is /app but this
// file has been COPY'd to /app/scripts/lib/linux-optional-packages.mjs.
const REPO_ROOT = join(__dirname, '..', '..')
const DEFAULT_LOCKFILE_PATH = join(REPO_ROOT, 'package-lock.json')

/**
 * Denylist of package-name-scope prefixes to exclude from the derived list,
 * matched against the LAST `node_modules/`-relative segment of a path (i.e.
 * the package's own local scope, regardless of nesting depth) so a future
 * nested copy of one of these families is still caught.
 *
 * Each entry cites SMI-6050's plan doc "Full scope" table for the grounded
 * exclusion reason (verified consumer + why that consumer is host-only).
 * `@cloudflare/workerd-linux-*` is deliberately NOT in this list — the
 * original draft excluded it on a factually-wrong "no wrangler usage"
 * claim; plan-review corrected this (see plan doc "Review Summary" #3).
 */
const DENYLIST = [
  {
    // excluded: supabase CLI — CLAUDE.md documents pooler/CLI access as
    // host-only (`varlock run --` scripts, "host tool — not inside the
    // container"). See SMI-6050 plan doc "Full scope" table.
    prefix: '@supabase/cli-linux',
  },
  {
    // excluded: vsce/vscode-extension packaging — ADR-113: vscode-extension
    // explicitly has no Docker. See SMI-6050 plan doc "Full scope" table.
    prefix: '@vscode/vsce-sign-linux',
  },
  {
    // excluded: confirmed sole consumer is @vercel/cli-auth (traced via the
    // package-lock.json dependency graph); `vercel --prod` deploys run on
    // host per CLAUDE.md's Website deploy docs, never inside a worktree
    // container. See SMI-6050 plan doc "Full scope" table.
    prefix: '@napi-rs/keyring-linux',
  },
]

const NODE_MODULES_SEGMENT = 'node_modules/'

/**
 * Returns the package's own local scope/name segment — everything after
 * the LAST `node_modules/` occurrence in a package-lock.json path key.
 * For a root-level entry this is the whole path minus the leading
 * `node_modules/`; for a nested entry (e.g.
 * `node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu`) this
 * strips the parent's own `node_modules/...` prefix, giving
 * `@rolldown/binding-linux-arm64-gnu` — the part the denylist patterns are
 * written against.
 *
 * @param {string} pkgPath
 * @returns {string}
 */
function localScopeSegment(pkgPath) {
  const idx = pkgPath.lastIndexOf(NODE_MODULES_SEGMENT)
  if (idx === -1) return pkgPath
  return pkgPath.slice(idx + NODE_MODULES_SEGMENT.length)
}

/**
 * @param {string} pkgPath
 * @returns {boolean}
 */
function isDenylisted(pkgPath) {
  const scope = localScopeSegment(pkgPath)
  return DENYLIST.some(({ prefix }) => scope.startsWith(prefix))
}

/**
 * @param {unknown} descriptor - a package-lock.json `packages` entry value
 * @returns {boolean}
 */
function isLinuxOnly(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return false
  const os = /** @type {{ os?: unknown }} */ (descriptor).os
  return Array.isArray(os) && os.length === 1 && os[0] === 'linux'
}

/**
 * @param {string} lockfilePath
 * @returns {Record<string, unknown>}
 */
function readLockfilePackages(lockfilePath) {
  const raw = readFileSync(lockfilePath, 'utf8')
  const parsed = JSON.parse(raw)
  return parsed && typeof parsed === 'object' && parsed.packages ? parsed.packages : {}
}

/**
 * Reads `lockfilePath` and returns every `packages` entry whose `os` field
 * is exactly `["linux"]`, minus the DENYLIST families above — sorted
 * lexicographically. Each returned string is the exact
 * `node_modules/...`-relative path as it appears as a package-lock.json
 * key, unmodified (no sanitization — that's a separate concern for a later
 * wave's Docker volume-name derivation).
 *
 * @param {string} lockfilePath
 * @returns {string[]}
 */
export function deriveLinuxOptionalPackagePaths(lockfilePath) {
  const packages = readLockfilePackages(lockfilePath)
  const result = []
  for (const [pkgPath, descriptor] of Object.entries(packages)) {
    if (!isLinuxOnly(descriptor)) continue
    if (isDenylisted(pkgPath)) continue
    result.push(pkgPath)
  }
  return result.sort()
}

/**
 * Returns the resolved `version` string for a given package-lock.json path
 * (one of the paths `deriveLinuxOptionalPackagePaths` returns). Used by
 * Wave 2's seed/restore staleness-detection version marker.
 *
 * @param {string} lockfilePath
 * @param {string} pkgPath
 * @returns {string}
 */
export function resolveVersionMarker(lockfilePath, pkgPath) {
  const packages = readLockfilePackages(lockfilePath)
  const descriptor = packages[pkgPath]
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.version !== 'string') {
    throw new Error(
      `resolveVersionMarker: no resolved "version" found for "${pkgPath}" in ${lockfilePath}`
    )
  }
  return descriptor.version
}

// CLI entrypoint — only runs when invoked directly via
// `node scripts/lib/linux-optional-packages.mjs [lockfilePath]`. Prints one
// path per line to stdout and exits 0, even when there are zero matches.
// Follows this repo's existing import.meta.url-based CLI-detection idiom
// (see scripts/lib/forbid-local-publish.mjs).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('linux-optional-packages.mjs')

if (isMain) {
  const lockfilePath = process.argv[2] ?? DEFAULT_LOCKFILE_PATH
  const paths = deriveLinuxOptionalPackagePaths(lockfilePath)
  for (const p of paths) {
    console.log(p)
  }
  process.exit(0)
}
