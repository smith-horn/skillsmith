/**
 * Manifest readers for Check 4 of `check-supply-chain-pins.mjs` (SMI-6944,
 * SMI-6978), split out of check-supply-chain-pins.helpers.mjs to keep every file
 * under the 500-line ceiling.
 *
 *   - loadDirectDependencyNames(rootDir): direct deps of root + every workspace.
 *     Fails closed: throws ManifestReadError for an unreadable root manifest or
 *     an unreadable workspace manifest that exists.
 *   - loadLockfileVersions(rootDir): name -> version of the root lockfile's
 *     top-level installs (empty when unreadable, which only adds findings).
 *
 * @see scripts/ci/check-supply-chain-pins.mjs (auditWorkflowInstalls turns a
 *   ManifestReadError into a `workflow-install-manifest` finding)
 */
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

/** A manifest Check 4 needs could not be read or parsed (fail closed, never `{}`). */
export class ManifestReadError extends Error {
  constructor(path, cause) {
    super(`cannot read ${path}: ${cause && cause.message ? cause.message : cause}`)
    this.name = 'ManifestReadError'
    this.path = path
  }
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    throw new ManifestReadError(path, e)
  }
}

/**
 * Names of every direct dependency (`dependencies` ∪ `devDependencies`) of the
 * root `package.json` and of every workspace manifest it lists. Throws
 * ManifestReadError when the root manifest, or a workspace manifest that exists,
 * cannot be read or parsed: an empty set would silently disable the rule.
 */
export function loadDirectDependencyNames(rootDir) {
  const names = new Set()
  const add = (pkg) => {
    for (const k of ['dependencies', 'devDependencies']) {
      for (const n of Object.keys(pkg[k] || {})) names.add(n)
    }
  }
  const root = readManifest(join(rootDir, 'package.json'))
  add(root)
  const ws = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages || []
  for (const pattern of ws) {
    const dirs = []
    if (pattern.endsWith('/*')) {
      const base = join(rootDir, pattern.slice(0, -2))
      if (existsSync(base)) {
        for (const e of readdirSync(base, { withFileTypes: true })) {
          if (e.isDirectory()) dirs.push(join(base, e.name))
        }
      }
    } else {
      dirs.push(join(rootDir, pattern))
    }
    for (const d of dirs) {
      // A directory matching the glob without a package.json is not a workspace.
      if (existsSync(join(d, 'package.json'))) add(readManifest(join(d, 'package.json')))
    }
  }
  return names
}

/**
 * name -> version for every top-level `node_modules/<name>` entry of the root
 * `package-lock.json`. An unreadable lockfile yields an empty Map, which fails
 * toward MORE findings, not fewer: every version then "differs" from it.
 */
export function loadLockfileVersions(rootDir) {
  const versions = new Map()
  let lock = {}
  try {
    lock = readManifest(join(rootDir, 'package-lock.json'))
  } catch {
    // see the docblock: an empty Map makes the dependency rule stricter
  }
  const packages = lock.packages || {}
  for (const [key, entry] of Object.entries(packages)) {
    const m = key.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)$/)
    if (m && entry && typeof entry.version === 'string') versions.set(m[1], entry.version)
  }
  return versions
}
