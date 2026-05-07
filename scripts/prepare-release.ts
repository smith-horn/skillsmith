#!/usr/bin/env npx tsx
/**
 * Release Preparation Script
 * Updates all version locations, generates changelog entries, and creates a commit.
 *
 * Usage:
 *   npx tsx scripts/prepare-release.ts --all=patch
 *   npx tsx scripts/prepare-release.ts --core=minor --cli=patch --vscode=patch
 *   npx tsx scripts/prepare-release.ts --core=0.4.18
 *   npx tsx scripts/prepare-release.ts --all=patch --dry-run
 *   npx tsx scripts/prepare-release.ts --all=patch --no-changelog
 *   npx tsx scripts/prepare-release.ts --all=patch --no-commit
 *
 * SMI-4783: collision/changelog/git helpers extracted to scripts/lib/release-*.ts
 * to keep this orchestrator under the 500-line file-length budget.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

import {
  PACKAGE_SPECS,
  CORE_DEPENDENTS,
  ROOT_DIR,
  incrementVersion,
  isValidSemver,
  compareSemver,
  readPackageVersion,
  readVersionConstant,
  getCommitsSince,
  formatChangelogSection,
  type PackageSpec,
} from './lib/version-utils.js'
import {
  RESERVED_RANGES,
  checkReservedVersionRanges,
  checkVersionCollision,
  resolveNpmLookups,
  fetchNpmLatest,
  fetchAllPublishedVersions,
  type BumpPlan,
  type CollisionCheckResult,
  type NpmLookup,
} from './lib/release-collision.js'
import { findLastVersionBumpCommit, prependToChangelog } from './lib/release-changelog.js'
import {
  validatePostWrite,
  getCurrentBranch,
  createCommit,
  regenerateLockfile,
} from './lib/release-git.js'

// Re-export the helper surface so existing test imports continue to resolve
// against `../prepare-release` (SMI-4783 keeps the public surface stable).
export {
  RESERVED_RANGES,
  checkReservedVersionRanges,
  checkVersionCollision,
  resolveNpmLookups,
  fetchNpmLatest,
  fetchAllPublishedVersions,
}
export type { BumpPlan, CollisionCheckResult, NpmLookup }

// --- Types ---

interface Options {
  bumps: Map<string, string>
  dryRun: boolean
  noChangelog: boolean
  noCommit: boolean
  noLockfileRegen: boolean
  allowDowngrade: boolean
  check: boolean
}

// --- Arg Parsing ---

function parseArgs(): Options {
  const args = process.argv.slice(2)
  const bumps = new Map<string, string>()
  let dryRun = false
  let noChangelog = false
  let noCommit = false
  let noLockfileRegen = false
  let allowDowngrade = false
  let check = false

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--no-changelog') {
      noChangelog = true
    } else if (arg === '--no-commit') {
      noCommit = true
    } else if (arg === '--no-lockfile-regen') {
      noLockfileRegen = true
    } else if (arg === '--allow-downgrade') {
      allowDowngrade = true
    } else if (arg === '--check') {
      check = true
    } else if (arg.startsWith('--all=')) {
      const type = arg.split('=')[1]
      for (const spec of PACKAGE_SPECS) {
        bumps.set(spec.shortName, type)
      }
    } else if (arg.startsWith('--core=')) {
      bumps.set('core', arg.split('=')[1])
    } else if (arg.startsWith('--mcp-server=')) {
      bumps.set('mcp-server', arg.split('=')[1])
    } else if (arg.startsWith('--cli=')) {
      bumps.set('cli', arg.split('=')[1])
    } else if (arg.startsWith('--vscode=')) {
      bumps.set('vscode', arg.split('=')[1])
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      printUsage()
      process.exit(1)
    }
  }

  if (bumps.size === 0 && !check) {
    console.error('Error: No packages specified. Use --all=patch or --core=patch etc.')
    printUsage()
    process.exit(1)
  }

  // --check with no explicit bumps audits a patch bump for all packages
  if (check && bumps.size === 0) {
    for (const spec of PACKAGE_SPECS) {
      bumps.set(spec.shortName, 'patch')
    }
  }

  return { bumps, dryRun, noChangelog, noCommit, noLockfileRegen, allowDowngrade, check }
}

function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/prepare-release.ts [options]

Package bumps:
  --all=<type>          Bump all packages (patch|minor|major)
  --core=<type|ver>     Bump core (patch|minor|major|X.Y.Z)
  --mcp-server=<type>   Bump mcp-server
  --cli=<type|ver>      Bump cli
  --vscode=<type|ver>   Bump vscode-extension

Options:
  --dry-run             Preview changes without writing
  --no-changelog        Skip changelog generation
  --no-commit           Write files but don't create git commit
  --no-lockfile-regen   Skip 'npm install --package-lock-only' after dep-range bumps (SMI-4775)
  --check               Audit-only: run npm collision check, no writes, exit non-zero on conflict
  --allow-downgrade     Permit bumping to a semver <= highest published (rare; never overrides equals-published)
  --help                Show this help
`)
}

// --- Version Resolution ---

function resolveVersion(current: string, bumpOrVersion: string): string {
  if (['patch', 'minor', 'major'].includes(bumpOrVersion)) {
    return incrementVersion(current, bumpOrVersion as 'patch' | 'minor' | 'major')
  }
  if (isValidSemver(bumpOrVersion)) {
    if (compareSemver(bumpOrVersion, current) <= 0) {
      throw new Error(`Target version ${bumpOrVersion} must be greater than current ${current}`)
    }
    return bumpOrVersion
  }
  throw new Error(
    `Invalid bump type or version: "${bumpOrVersion}". Use patch|minor|major or X.Y.Z`
  )
}

// --- Build Bump Plan ---

function buildBumpPlan(bumps: Map<string, string>): BumpPlan[] {
  const plans: BumpPlan[] = []

  for (const [shortName, bumpType] of bumps) {
    const spec = PACKAGE_SPECS.find((s) => s.shortName === shortName)
    if (!spec) {
      throw new Error(`Unknown package: ${shortName}`)
    }

    const currentVersion = readPackageVersion(spec.packageJsonPath)

    // Validate version constant is in sync
    if (spec.versionConstFile && spec.versionConstPattern) {
      const constVersion = readVersionConstant(spec.versionConstFile, spec.versionConstPattern)
      if (constVersion && constVersion !== currentVersion) {
        console.warn(
          `Warning: ${spec.versionConstFile} has ${constVersion} but package.json has ${currentVersion}`
        )
      }
    }

    const newVersion = resolveVersion(currentVersion, bumpType)
    plans.push({ spec, currentVersion, newVersion })
  }

  return plans
}

// --- File Writers ---

function updatePackageJson(relPath: string, newVersion: string): void {
  const fullPath = join(ROOT_DIR, relPath)
  const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'))
  pkg.version = newVersion
  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n')
}

function updateVersionConstant(spec: PackageSpec, newVersion: string): void {
  if (!spec.versionConstFile || !spec.versionConstPattern || !spec.versionConstReplacement) {
    return
  }
  const fullPath = join(ROOT_DIR, spec.versionConstFile)
  let content = readFileSync(fullPath, 'utf-8')
  content = content.replace(spec.versionConstPattern, spec.versionConstReplacement(newVersion))
  writeFileSync(fullPath, content)
}

function updateServerJson(relPath: string, newVersion: string): void {
  const fullPath = join(ROOT_DIR, relPath)
  const server = JSON.parse(readFileSync(fullPath, 'utf-8'))
  server.version = newVersion
  if (server.packages?.[0]) {
    server.packages[0].version = newVersion
  }
  writeFileSync(fullPath, JSON.stringify(server, null, 2) + '\n')
}

function updateCoreDependency(newCoreVersion: string): void {
  for (const relPath of CORE_DEPENDENTS) {
    const fullPath = join(ROOT_DIR, relPath)
    if (!existsSync(fullPath)) continue
    const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'))
    if (pkg.dependencies?.['@skillsmith/core']) {
      pkg.dependencies['@skillsmith/core'] = `^${newCoreVersion}`
      writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n')
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  const options = parseArgs()
  const { bumps, dryRun, noChangelog, noCommit, noLockfileRegen, allowDowngrade, check } = options

  // Step 0: Branch guard (skip in --check mode — audit is safe on any branch)
  if (!check) {
    const branch = getCurrentBranch()
    if (branch === 'main') {
      console.error('Error: Cannot prepare release on main. Create a branch first.')
      process.exit(1)
    }
    console.log(`Branch: ${branch}`)
  }

  // Step 1-3: Build and display plan
  const plans = buildBumpPlan(bumps)

  const nothingToDo = plans.every((p) => p.currentVersion === p.newVersion)
  if (nothingToDo) {
    console.log('Nothing to do — all versions are already at target.')
    process.exit(0)
  }

  console.log('\n  Package               Current   →  New')
  console.log('  ─────────────────────────────────────────')
  for (const plan of plans) {
    const name = plan.spec.shortName.padEnd(20)
    console.log(`  ${name}  ${plan.currentVersion.padEnd(9)} →  ${plan.newVersion}`)
  }
  console.log()

  // Step 3.4: Reserved version-range guard (SMI-4207 / ADR-115).
  // Runs before the npm-latest check so operators see the policy reason rather than a
  // confusing "proposed < latest" message when targeting an orphaned range.
  const reserved = checkReservedVersionRanges(plans)
  if (!reserved.ok) {
    console.error('\n  ✗ Reserved version range guard failed:')
    for (const err of reserved.errors) {
      console.error(`    - ${err}`)
    }
    process.exit(1)
  }

  // Step 3.5: NPM collision guard — ALWAYS runs before any write (including --dry-run preview).
  console.log('  Checking npm registry for version collisions...')
  const lookups = await resolveNpmLookups(plans)
  const collision = checkVersionCollision(plans, lookups, { allowDowngrade })
  for (const line of collision.report) console.log(line)
  if (!collision.ok) {
    console.error('\n  ✗ Version collision guard failed:')
    for (const err of collision.errors) {
      console.error(`    - ${err}`)
    }
    process.exit(1)
  }
  console.log('  ✓ npm collision guard passed')

  // --check exits here with no writes.
  if (check) {
    console.log('\n[CHECK] Audit-only mode — no files modified.')
    process.exit(0)
  }

  // Step 4: Dry run exit
  if (dryRun) {
    console.log('[DRY RUN] No files modified.')
    process.exit(0)
  }

  // Step 5: Write all version locations
  for (const plan of plans) {
    updatePackageJson(plan.spec.packageJsonPath, plan.newVersion)
    updateVersionConstant(plan.spec, plan.newVersion)
    if (plan.spec.serverJsonPath) {
      updateServerJson(plan.spec.serverJsonPath, plan.newVersion)
    }
    console.log(`  ✓ ${plan.spec.name}@${plan.newVersion}`)
  }

  // Step 6: Update @skillsmith/core dep in dependents
  const corePlan = plans.find((p) => p.spec.shortName === 'core')
  if (corePlan) {
    updateCoreDependency(corePlan.newVersion)
    console.log(`  ✓ Updated @skillsmith/core dep in dependents`)
  }

  // Step 6.5: Regenerate package-lock.json so the lockfile matches the bumped
  // dep ranges (SMI-4775). Without this, the publish workflow ships a
  // lockfile pinned to the previous core version while package.json declares
  // the new one — `npm ci` then either fails or silently resolves stale
  // transitive deps. Opt out with --no-lockfile-regen for emergency releases.
  if (!noLockfileRegen) {
    console.log('  Regenerating package-lock.json (SMI-4775)...')
    regenerateLockfile()
    console.log('  ✓ Lockfile regenerated')
  } else {
    console.log('  ⚠ Skipping lockfile regen (--no-lockfile-regen)')
  }

  // Step 7-8: Generate and prepend changelogs
  if (!noChangelog) {
    const since = findLastVersionBumpCommit()
    for (const plan of plans) {
      const entries = getCommitsSince(since, plan.spec.dir)
      if (entries.length > 0) {
        const section = formatChangelogSection(plan.newVersion, entries)
        prependToChangelog(join(plan.spec.dir, 'CHANGELOG.md'), section)
        console.log(`  ✓ Changelog: ${plan.spec.shortName} (${entries.length} entries)`)
      } else {
        // Create minimal entry
        const section = `## v${plan.newVersion}\n\n- Version bump`
        prependToChangelog(join(plan.spec.dir, 'CHANGELOG.md'), section)
        console.log(`  ✓ Changelog: ${plan.spec.shortName} (version bump only)`)
      }
    }
  }

  // Step 9: Post-write validation
  const errors = validatePostWrite(plans)
  if (errors.length > 0) {
    console.error('\n  ✗ Post-write validation failed:')
    for (const err of errors) {
      console.error(`    - ${err}`)
    }
    process.exit(1)
  }
  console.log('  ✓ Version sync validation passed')

  // Step 10: No-commit exit with warning
  if (noCommit) {
    console.log('\n  ⚠ WARNING: Files modified but NOT committed.')
    console.log('  Modified files:')
    for (const plan of plans) {
      console.log(`    - ${plan.spec.packageJsonPath}`)
      if (plan.spec.versionConstFile) console.log(`    - ${plan.spec.versionConstFile}`)
      if (plan.spec.serverJsonPath) console.log(`    - ${plan.spec.serverJsonPath}`)
      console.log(`    - ${plan.spec.dir}/CHANGELOG.md`)
    }
    console.log('\n  Run `git add` and `git commit` when ready.')
    process.exit(0)
  }

  // Step 11: Commit (include package-lock.json when regen ran)
  const preBranch = getCurrentBranch()
  createCommit(plans, !noLockfileRegen)

  // Step 12: Post-commit branch verification
  const postBranch = getCurrentBranch()
  if (postBranch !== preBranch) {
    console.error(`\n  ✗ Branch switched during commit: ${preBranch} → ${postBranch}`)
    console.error(`  Recovery: git checkout ${preBranch} && git cherry-pick HEAD`)
    process.exit(1)
  }

  const parts = plans.map((p) => `${p.spec.shortName}@${p.newVersion}`)
  console.log(`\n  ✓ Committed: ${parts.join(', ')}`)
  console.log('\n  Next steps:')
  console.log('    git push')
  console.log('    gh workflow run publish.yml -f dry_run=false')
}

// Only invoke main() when run directly, not when imported by tests.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  /prepare-release\.(ts|js|mjs|cjs)$/.test(process.argv[1])

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
