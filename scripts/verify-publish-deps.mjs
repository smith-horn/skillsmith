#!/usr/bin/env node
/**
 * Verify workspace dependency versions are consistent with local state.
 * Catches the exact failure mode from mcp-server@0.4.4 (SMI-3468): consumer
 * declares dep@X but code needs exports only in dep@Y (Y > X, unpublished).
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
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CI = process.argv.includes('--ci')

const PACKAGES = [
  { name: '@skillsmith/core', dir: 'packages/core' },
  { name: '@skillsmith/mcp-server', dir: 'packages/mcp-server' },
  { name: '@skillsmith/cli', dir: 'packages/cli' },
]

let errors = 0
const npmCache = new Map()

function log(msg) {
  console.log(`  ${msg}`)
}
function warn(file, msg) {
  errors++
  if (CI) console.log(`::error file=${file}::${msg}`)
  else console.error(`  ERROR: ${msg}`)
}

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

console.log('\n  Workspace Dependency Version Audit (SMI-3471)\n')

for (const pkg of PACKAGES) {
  const pkgPath = join(ROOT, pkg.dir, 'package.json')
  if (!existsSync(pkgPath)) continue

  const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const deps = { ...pkgJson.dependencies }
  let siblingCount = 0

  for (const [depName, depRange] of Object.entries(deps)) {
    const sibling = PACKAGES.find((p) => p.name === depName)
    if (!sibling) continue
    siblingCount++

    const siblingPkg = JSON.parse(readFileSync(join(ROOT, sibling.dir, 'package.json'), 'utf-8'))

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

    // Check 3: Verify declared version exists on npm
    if (depRange.startsWith('^') || depRange.startsWith('~')) {
      const baseVersion = depRange.replace(/^[\^~]/, '')
      const published = npmViewCached(depName, baseVersion)
      if (!published) {
        warn(
          pkgPath,
          `${pkg.name} declares ${depName}@${depRange} but ${depName}@${baseVersion} is not published on npm.`
        )
      }
    }
  }

  log(`${pkg.name}: checked ${siblingCount} workspace dep(s)`)
}

console.log('')
if (errors > 0) {
  console.error(`  ${errors} error(s) found. Fix dependency versions before publishing.\n`)
  process.exit(1)
} else {
  log('All workspace dependency versions are consistent.\n')
}
