#!/usr/bin/env npx tsx
/**
 * Release Preparation Script
 * Updates all version locations, generates changelog entries, and creates a commit.
 *
 * Usage:
 *   npx tsx scripts/prepare-release.ts --all=patch
 *   npx tsx scripts/prepare-release.ts --core=minor --cli=patch
 *   npx tsx scripts/prepare-release.ts --core=0.4.18
 *   npx tsx scripts/prepare-release.ts --all=patch --dry-run
 *   npx tsx scripts/prepare-release.ts --all=patch --no-changelog
 *   npx tsx scripts/prepare-release.ts --all=patch --no-commit
 */

import { execFileSync } from 'child_process'
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

// --- Types ---

interface BumpPlan {
  spec: PackageSpec
  currentVersion: string
  newVersion: string
}

interface Options {
  bumps: Map<string, string>
  dryRun: boolean
  noChangelog: boolean
  noCommit: boolean
}

// --- Arg Parsing ---

function parseArgs(): Options {
  const args = process.argv.slice(2)
  const bumps = new Map<string, string>()
  let dryRun = false
  let noChangelog = false
  let noCommit = false

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--no-changelog') {
      noChangelog = true
    } else if (arg === '--no-commit') {
      noCommit = true
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
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      printUsage()
      process.exit(1)
    }
  }

  if (bumps.size === 0) {
    console.error('Error: No packages specified. Use --all=patch or --core=patch etc.')
    printUsage()
    process.exit(1)
  }

  return { bumps, dryRun, noChangelog, noCommit }
}

function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/prepare-release.ts [options]

Package bumps:
  --all=<type>          Bump all packages (patch|minor|major)
  --core=<type|ver>     Bump core (patch|minor|major|X.Y.Z)
  --mcp-server=<type>   Bump mcp-server
  --cli=<type|ver>      Bump cli

Options:
  --dry-run             Preview changes without writing
  --no-changelog        Skip changelog generation
  --no-commit           Write files but don't create git commit
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

// --- Changelog ---

function findLastVersionBumpCommit(): string {
  try {
    const output = execFileSync('git', ['log', '--oneline', '--format=%H %s', '-50'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    for (const line of output.split('\n')) {
      const [hash, ...rest] = line.split(' ')
      const msg = rest.join(' ')
      if (
        msg.startsWith('chore(release):') ||
        msg.startsWith('chore: bump version') ||
        /^chore:.*bump.*\d+\.\d+\.\d+/.test(msg)
      ) {
        return hash
      }
    }
    return 'HEAD~20'
  } catch {
    return 'HEAD~20'
  }
}

function prependToChangelog(relPath: string, section: string): void {
  const fullPath = join(ROOT_DIR, relPath)
  let content: string
  if (existsSync(fullPath)) {
    content = readFileSync(fullPath, 'utf-8')
  } else {
    content = `# Changelog\n\nAll notable changes to this package are documented here.\n`
  }

  // Insert after the header (first line starting with #)
  const headerEnd = content.indexOf('\n## ')
  if (headerEnd !== -1) {
    content = content.slice(0, headerEnd) + '\n' + section + '\n' + content.slice(headerEnd)
  } else {
    content = content.trimEnd() + '\n\n' + section + '\n'
  }

  writeFileSync(fullPath, content)
}

// --- Validation ---

function validatePostWrite(plans: BumpPlan[]): string[] {
  const errors: string[] = []
  for (const plan of plans) {
    const { spec, newVersion } = plan
    const actual = readPackageVersion(spec.packageJsonPath)
    if (actual !== newVersion) {
      errors.push(`${spec.name}: package.json has ${actual}, expected ${newVersion}`)
    }
    if (spec.versionConstFile && spec.versionConstPattern) {
      const constVer = readVersionConstant(spec.versionConstFile, spec.versionConstPattern)
      if (constVer !== newVersion) {
        errors.push(`${spec.name}: version constant has ${constVer}, expected ${newVersion}`)
      }
    }
    if (spec.serverJsonPath) {
      const fullPath = join(ROOT_DIR, spec.serverJsonPath)
      const server = JSON.parse(readFileSync(fullPath, 'utf-8'))
      if (server.version !== newVersion) {
        errors.push(
          `${spec.name}: server.json version has ${server.version}, expected ${newVersion}`
        )
      }
      if (server.packages?.[0]?.version !== newVersion) {
        errors.push(
          `${spec.name}: server.json packages[0].version has ${server.packages?.[0]?.version}, expected ${newVersion}`
        )
      }
    }
  }
  return errors
}

// --- Git ---

function getCurrentBranch(): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: ROOT_DIR,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function createCommit(plans: BumpPlan[]): void {
  const filesToAdd: string[] = []

  for (const plan of plans) {
    filesToAdd.push(plan.spec.packageJsonPath)
    if (plan.spec.versionConstFile) filesToAdd.push(plan.spec.versionConstFile)
    if (plan.spec.serverJsonPath) filesToAdd.push(plan.spec.serverJsonPath)
    filesToAdd.push(join(plan.spec.dir, 'CHANGELOG.md'))
  }

  // Add core dependent package.jsons if core was bumped
  if (plans.some((p) => p.spec.shortName === 'core')) {
    for (const dep of CORE_DEPENDENTS) {
      if (existsSync(join(ROOT_DIR, dep))) {
        filesToAdd.push(dep)
      }
    }
  }

  const existing = filesToAdd.filter((f) => existsSync(join(ROOT_DIR, f)))
  execFileSync('git', ['add', ...existing], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  })

  const parts = plans.map((p) => `${p.spec.shortName} ${p.newVersion}`)
  const message = `chore(release): bump ${parts.join(', ')}`

  execFileSync('git', ['commit', '-m', message], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  })
}

// --- Main ---

function main(): void {
  const options = parseArgs()
  const { bumps, dryRun, noChangelog, noCommit } = options

  // Step 0: Branch guard
  const branch = getCurrentBranch()
  if (branch === 'main') {
    console.error('Error: Cannot prepare release on main. Create a branch first.')
    process.exit(1)
  }
  console.log(`Branch: ${branch}`)

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

  // Step 11: Commit
  const preBranch = getCurrentBranch()
  createCommit(plans)

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

main()
