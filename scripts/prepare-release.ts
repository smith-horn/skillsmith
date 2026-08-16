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

import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  PACKAGE_SPECS,
  ROOT_DIR,
  incrementVersion,
  isValidSemver,
  compareSemver,
  readPackageVersion,
  readVersionConstant,
  getCommitsSince,
  formatChangelogSection,
  updateWorkspaceDependencies,
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
  buildFilesToAdd,
  regenerateLockfile,
} from './lib/release-git.js'
import { syncReadmeWhatsNew } from './lib/release-readme.js'
import { ensureTyposquatSnapshot } from './lib/release-typosquat-snapshot.js'
import { parseArgs } from './lib/release-args.js'

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

// --- Types & Arg Parsing (extracted to ./lib/release-args.ts, SMI-6033) ---

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
  // SMI-5057: re-format with prettier to collapse short arrays (e.g.
  // 3-element `categories`) onto one line per repo prettier config.
  // Without this, `npm run format:check` fails on every cadence PR.
  // `npx prettier` resolves via node_modules/.bin/prettier — present
  // because release-cadence.yml runs `npm ci --ignore-scripts` before
  // calling prepare-release.ts (--ignore-scripts skips lifecycle scripts
  // but NOT the install itself, so devDependencies including prettier
  // land in node_modules).
  execFileSync('npx', ['prettier', '--write', fullPath], { stdio: 'inherit' })
}

// SMI-5057: `updateCoreDependency` removed — superseded by
// `updateWorkspaceDependencies` (in version-utils.ts), which walks every
// PACKAGE_SPECS target and updates any dep range matching a bumped package.
// This fixes the missing @skillsmith/mcp-server dep bump in @skillsmith/cli.

// --- Main ---

async function main(): Promise<void> {
  const options = parseArgs()
  const {
    bumps,
    dryRun,
    noChangelog,
    noCommit,
    noLockfileRegen,
    allowDowngrade,
    check,
    noTyposquatSnapshot,
  } = options

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

  // Step 5.5: Sync each bumped package's README "What's New" heading (SMI-5663
  // Wave 1) — Check 60 (SMI-5613) compares this heading against package.json
  // and fails the release-cadence PR on drift. Throws (aborting this run) if
  // a package's README has a "What's New" section that can't be resolved to
  // exactly one heading; silently skips packages with no such section at all.
  const { updated: updatedReadmeFiles } = syncReadmeWhatsNew(plans)
  if (updatedReadmeFiles.length > 0) {
    console.log(
      `  ✓ Synced README "What's New" heading in ${updatedReadmeFiles.length} package(s):`
    )
    for (const path of updatedReadmeFiles) console.log(`    - ${path}`)
  }

  // Step 6: Update workspace dep ranges in all sibling packages.
  //
  // SMI-5057: Replaces the older core-only updateCoreDependency. Walks every
  // PACKAGE_SPECS target (minus skipDepRangeUpdate ones) and updates any dep
  // range whose key matches a freshly-bumped package. Catches the
  // @skillsmith/mcp-server stale-range bug in @skillsmith/cli that bit
  // PR #1268.
  const { updated: updatedDepFiles } = updateWorkspaceDependencies(plans)
  if (updatedDepFiles.length > 0) {
    console.log(`  ✓ Updated workspace dep ranges in ${updatedDepFiles.length} package(s):`)
    for (const path of updatedDepFiles) console.log(`    - ${path}`)
  }

  // Step 6.4: refresh (or gate on) the bundled typosquat reference snapshot —
  // SMI-6033 Wave 1 Gap 7. See scripts/lib/release-typosquat-snapshot.ts: this
  // regenerates in-process when Supabase credentials are present, and otherwise
  // HARD-FAILS the release if the checked-in asset is empty/missing/stale
  // (shipping an empty snapshot silently disables skill_validate's and
  // skill_rescan's typosquat checks, which is how it originally shipped).
  const snapshot = await ensureTyposquatSnapshot({ skip: noTyposquatSnapshot })
  for (const line of snapshot.log) console.log(line)

  // SMI-5663: combine every non-plan-derived file this run touched — README
  // "What's New" syncs (Step 5.5), workspace dep-range writes (Step 6), and the
  // typosquat snapshot (Step 6.4) — into one extraFiles list, threaded through
  // both the --no-commit preview (Step 10) and the real commit (Step 11) so
  // neither can drift from what was actually written, matching SMI-5672's
  // buildFilesToAdd contract.
  const extraFiles = [...updatedReadmeFiles, ...updatedDepFiles, ...snapshot.filesToStage]

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
        // SMI-5064: emit a descriptive cadence-only default instead of the
        // bare "- Version bump" placeholder. The `**Cadence**:` bold prefix
        // matches the `- **Fix**: …` / `- **Feature**: …` convention emitted
        // by formatChangelogSection (version-utils.ts:280-288) for visual
        // consistency. Referencing the prior version lets a reader run
        // `git log v<prior>..v<new> -- <pkg-dir>` to verify zero commits.
        const section = `## v${plan.newVersion}\n\n- **Cadence**: Mechanical cadence alignment (no changes since v${plan.currentVersion}).`
        prependToChangelog(join(plan.spec.dir, 'CHANGELOG.md'), section)
        console.log(
          `  ✓ Changelog: ${plan.spec.shortName} (cadence-only bump from v${plan.currentVersion})`
        )
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
    // SMI-5672: use the shared buildFilesToAdd so the previewed list matches what
    // a real commit (Step 11) would stage — including workspace dep-range files
    // (extraFiles) and package-lock.json, and omitting CHANGELOG.md when
    // --no-changelog was passed.
    const modified = buildFilesToAdd(plans, {
      includeLockfile: !noLockfileRegen,
      extraFiles,
      noChangelog,
    })
    for (const f of modified) console.log(`    - ${f}`)
    console.log('\n  Run `git add` and `git commit` when ready.')
    process.exit(0)
  }

  // Step 11: Commit (include package-lock.json when regen ran, plus the
  // workspace dep-range files updateWorkspaceDependencies wrote, plus any
  // synced README "What's New" headings — SMI-5672, SMI-5663).
  const preBranch = getCurrentBranch()
  createCommit(plans, !noLockfileRegen, extraFiles)

  // Step 12: Post-commit branch verification
  const postBranch = getCurrentBranch()
  if (postBranch !== preBranch) {
    console.error(`\n  ✗ Branch switched during commit: ${preBranch} → ${postBranch}`)
    console.error(`  Recovery: git checkout ${preBranch} && git cherry-pick HEAD`)
    process.exit(1)
  }

  const parts = plans.map((p) => `${p.spec.shortName}@${p.newVersion}`)
  console.log(`\n  ✓ Committed: ${parts.join(', ')}`)
  // SMI-5672: print the exact staged file list — same buildFilesToAdd call the
  // commit used — so every real release visibly confirms what was committed,
  // closing the trust gap that let the original dep-range-drop bug ship silently.
  const staged = buildFilesToAdd(plans, {
    includeLockfile: !noLockfileRegen,
    extraFiles,
  })
  console.log('  Staged files:')
  for (const f of staged) console.log(`    - ${f}`)
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
