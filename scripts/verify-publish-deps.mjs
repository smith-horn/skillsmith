#!/usr/bin/env node
/**
 * Verify workspace dependency versions are consistent with local state.
 * Catches the exact failure mode from mcp-server@0.4.4 (SMI-3468): consumer
 * declares dep@X but code needs exports only in dep@Y (Y > X, unpublished).
 *
 * SMI-4920 (Bug B): on a release PR, Check 2 forces dependents to declare
 * `^<newcore>` while Check 3 requires that version already published on npm —
 * jointly unsatisfiable (a deterministic ordering deadlock, not a race). Check 3
 * now also accepts a version that is being released in the same PR, detected by
 * diffing the working-tree `version` against the PR base ref.
 *
 * Usage:
 *   node scripts/verify-publish-deps.mjs          # Check all packages
 *   node scripts/verify-publish-deps.mjs --ci     # CI mode (GitHub annotations)
 *
 * @see docs/internal/retros/2026-03-19-mcp-server-0.4.5-hotfix.md
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync, execFileSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const PACKAGES = [
  { name: '@skillsmith/core', dir: 'packages/core' },
  // SMI-5066: types-only contract package; mcp-server depends on it.
  { name: '@skillsmith/billing-types', dir: 'packages/billing-types' },
  { name: '@skillsmith/mcp-server', dir: 'packages/mcp-server' },
  { name: '@skillsmith/cli', dir: 'packages/cli' },
]

const npmCache = new Map()

function npmViewCached(name, version) {
  const key = `${name}@${version}`
  if (npmCache.has(key)) return npmCache.get(key)
  try {
    const result = execSync(`npm view ${name}@${version} version 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    npmCache.set(key, result)
    return result
  } catch {
    npmCache.set(key, '')
    return ''
  }
}

/**
 * Determine which packages are being released in THIS PR. A package is
 * considered "releasing" if either:
 *   (a) the working-tree `version` differs from the same field on the PR base
 *       ref — typical release-PR shape; OR
 *   (b) the working-tree `version` is not yet published on npm (SMI-5077). This
 *       catches the case where a prior merged PR bumped the version on main
 *       without publishing (e.g. SMI-5039 left core@0.8.0 on main unpublished),
 *       so HEAD-vs-base shows no diff but the package still needs to be
 *       published — and consumers in the same release PR need to caret-pin to
 *       that unpublished version.
 *
 * Returns a map of `{ '@skillsmith/<name>': '<newVersion>' }`.
 *
 * Base ref = `GITHUB_BASE_REF` when set (PR context), else `main`. The ref is
 * fetched if not present locally — handles shallow clones / detached HEAD.
 *
 * Fail-soft: returns `{ versions: {}, resolved: false }` when the base ref
 * cannot be resolved, so callers can fall back to npm-only checks.
 *
 * @param {{
 *   git?: (args: string[]) => string,
 *   readJson?: (p: string) => any,
 *   npmView?: (name: string, version: string) => string,
 * }} [io]
 * @returns {{ versions: Record<string, string>, resolved: boolean }}
 */
export function getReleasingVersions(io = {}) {
  const git =
    io.git ??
    ((args) =>
      execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }))
  const readJson = io.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf-8')))
  const npmView = io.npmView ?? npmViewCached

  const base = process.env.GITHUB_BASE_REF || 'main'
  const baseRef = `origin/${base}`

  try {
    // Ensure the base ref exists locally (shallow clones won't have it).
    try {
      git(['rev-parse', '--verify', '--quiet', baseRef])
    } catch {
      git(['fetch', 'origin', base])
    }

    const versions = {}
    for (const pkg of PACKAGES) {
      const localPath = join(ROOT, pkg.dir, 'package.json')
      if (!existsSync(localPath)) continue

      let localVersion
      try {
        localVersion = readJson(localPath).version
      } catch {
        continue
      }
      if (!localVersion) continue

      let baseVersion
      try {
        const baseJson = git(['show', `${baseRef}:${pkg.dir}/package.json`])
        baseVersion = JSON.parse(baseJson).version
      } catch {
        // Package didn't exist on base, or ref unreadable — treat as a release.
        baseVersion = undefined
      }

      if (localVersion !== baseVersion) {
        versions[pkg.name] = localVersion
        continue
      }

      // SMI-5077: same version on base — but if it's still unpublished on npm,
      // this is also a release-in-progress (prior merge bumped source without
      // publishing). The npm 404 is the ground truth.
      const published = npmView(pkg.name, localVersion)
      if (!published) {
        versions[pkg.name] = localVersion
      }
    }
    return { versions, resolved: true }
  } catch {
    return { versions: {}, resolved: false }
  }
}

/**
 * Run the dependency audit against a set of package directories.
 *
 * @param {{
 *   readJson?: (p: string) => any,
 *   npmView?: (name: string, version: string) => string,
 *   releasing?: { versions: Record<string, string>, resolved: boolean },
 *   ci?: boolean,
 *   logger?: { log: (m: string) => void, error: (m: string) => void },
 * }} [opts]
 * @returns {{ errors: number }}
 */
export function runAudit(opts = {}) {
  const readJson = opts.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf-8')))
  const npmView = opts.npmView ?? npmViewCached
  const releasing = opts.releasing ?? getReleasingVersions()
  const ci = opts.ci ?? false
  const logger = opts.logger ?? console
  const inPR = releasing.versions

  let errors = 0
  const log = (msg) => logger.log(`  ${msg}`)
  const warn = (file, msg) => {
    errors++
    if (ci) logger.log(`::error file=${file}::${msg}`)
    else logger.error(`  ERROR: ${msg}`)
  }

  logger.log('\n  Workspace Dependency Version Audit (SMI-3471)\n')
  if (!releasing.resolved) {
    log('WARNING: could not resolve PR base ref — Check 3 falls back to npm-only verification.')
  }

  for (const pkg of PACKAGES) {
    const pkgPath = join(ROOT, pkg.dir, 'package.json')
    if (!existsSync(pkgPath)) continue

    const pkgJson = readJson(pkgPath)
    const deps = { ...pkgJson.dependencies }
    let siblingCount = 0

    for (const [depName, depRange] of Object.entries(deps)) {
      const sibling = PACKAGES.find((p) => p.name === depName)
      if (!sibling) continue
      siblingCount++

      const siblingPkg = readJson(join(ROOT, sibling.dir, 'package.json'))

      // Check 1: Exact pin warning (no ^ or ~ or workspace:)
      if (
        !depRange.startsWith('^') &&
        !depRange.startsWith('~') &&
        !depRange.startsWith('workspace:')
      ) {
        warn(
          pkgPath,
          `${pkg.name} has exact-pinned dep ${depName}: "${depRange}". Use caret (^) for workspace deps.`
        )
      }

      // Check 2: Version base matches local (error for ALL range types)
      // A consumer declaring ^0.4.14 but using exports from local 0.4.16 will
      // fail if npm resolves the minimum compatible version (0.4.14).
      const cleanRange = depRange.replace(/^[\^~]/, '')
      if (cleanRange !== siblingPkg.version && !depRange.startsWith('workspace:')) {
        warn(
          pkgPath,
          `${pkg.name} declares ${depName}: "${depRange}" but local version is ${siblingPkg.version}. Update to "^${siblingPkg.version}" before publishing.`
        )
      }

      // Check 3: Verify declared version exists on npm OR is being released in
      // this PR (SMI-4920). On a release PR, Check 2 forces ^<newVersion>;
      // requiring <newVersion> to already be on npm would be unsatisfiable.
      if (depRange.startsWith('^') || depRange.startsWith('~')) {
        const baseVersion = depRange.replace(/^[\^~]/, '')
        const published = npmView(depName, baseVersion)
        if (!published) {
          if (inPR[depName] === baseVersion) {
            log(`${depName}@${baseVersion} — not yet on npm, accepted (released in this PR)`)
          } else {
            warn(
              pkgPath,
              `${pkg.name} declares ${depName}@${depRange} but ${depName}@${baseVersion} is not published on npm.`
            )
          }
        }
      }
    }

    log(`${pkg.name}: checked ${siblingCount} workspace dep(s)`)
  }

  logger.log('')
  if (errors > 0) {
    logger.error(`  ${errors} error(s) found. Fix dependency versions before publishing.\n`)
  } else {
    log('All workspace dependency versions are consistent.\n')
  }

  return { errors }
}

function main() {
  const ci = process.argv.includes('--ci')
  const { errors } = runAudit({ ci })
  process.exit(errors > 0 ? 1 : 0)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) main()
