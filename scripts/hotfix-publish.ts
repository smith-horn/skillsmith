#!/usr/bin/env npx tsx
/**
 * Hotfix Publisher
 * SMI-2230: Automated hotfix for broken publishes
 *
 * Instead of unpublishing (breaks dependents, only works 72h), this:
 * 1. Deprecates the broken version with a warning message
 * 2. Increments patch version and publishes hotfix
 *
 * Usage:
 *   npx tsx scripts/hotfix-publish.ts --package=@skillsmith/mcp-server --version=0.3.18 --reason="Missing core exports"
 *   npx tsx scripts/hotfix-publish.ts --package=@skillsmith/mcp-server --version=0.3.18 --reason="Bug" --dry-run
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(__dirname, '..')

interface HotfixOptions {
  package: string
  brokenVersion: string
  reason: string
  dryRun?: boolean
}

interface HotfixResult {
  package: string
  brokenVersion: string
  hotfixVersion: string
  deprecateSuccess: boolean
  publishSuccess: boolean
  dryRun: boolean
}

const PACKAGE_PATHS: Record<string, string> = {
  '@skillsmith/core': 'packages/core',
  '@skillsmith/mcp-server': 'packages/mcp-server',
  '@skillsmith/cli': 'packages/cli',
}

function incrementPatch(version: string): string {
  const parts = version.split('.')
  if (parts.length !== 3) {
    throw new Error(`Invalid semver version: ${version}`)
  }
  const [major, minor, patch] = parts.map(Number)
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    throw new Error(`Invalid semver version: ${version}`)
  }
  return `${major}.${minor}.${patch + 1}`
}

function getPublishedVersion(name: string): string | null {
  try {
    const result = execSync(`npm view ${name} version 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return result.trim()
  } catch {
    return null
  }
}

export function createHotfix(options: HotfixOptions): HotfixResult {
  const { package: pkgName, brokenVersion, reason, dryRun = false } = options

  // Find package path
  const pkgPath = PACKAGE_PATHS[pkgName]
  if (!pkgPath) {
    throw new Error(
      `Unknown package: ${pkgName}. Available: ${Object.keys(PACKAGE_PATHS).join(', ')}`
    )
  }

  // Verify the broken version exists on npm
  const currentVersion = getPublishedVersion(pkgName)
  if (!currentVersion) {
    throw new Error(`Package ${pkgName} is not published on npm`)
  }

  // Calculate hotfix version
  const hotfixVersion = incrementPatch(brokenVersion)

  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║                      Hotfix Publisher                         ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  Package:        ${pkgName.padEnd(41)} ║`)
  console.log(`║  Broken Version: ${brokenVersion.padEnd(41)} ║`)
  console.log(`║  Hotfix Version: ${hotfixVersion.padEnd(41)} ║`)
  console.log(`║  Reason:         ${reason.slice(0, 41).padEnd(41)} ║`)
  console.log(`║  Dry Run:        ${(dryRun ? 'Yes' : 'No').padEnd(41)} ║`)
  console.log('╚══════════════════════════════════════════════════════════════╝')

  const result: HotfixResult = {
    package: pkgName,
    brokenVersion,
    hotfixVersion,
    deprecateSuccess: false,
    publishSuccess: false,
    dryRun,
  }

  if (dryRun) {
    console.log('\n[DRY RUN] Would execute:')
    console.log(`  1. npm deprecate ${pkgName}@${brokenVersion} "${reason}"`)
    console.log(`  2. Update ${pkgPath}/package.json version to ${hotfixVersion}`)
    console.log(`  3. npm publish --access public in ${pkgPath}`)
    result.deprecateSuccess = true
    result.publishSuccess = true
    return result
  }

  // Step 1: Deprecate broken version
  console.log(`\n1. Deprecating ${pkgName}@${brokenVersion}...`)
  try {
    execSync(`npm deprecate ${pkgName}@${brokenVersion} "${reason}"`, {
      stdio: 'inherit',
    })
    result.deprecateSuccess = true
    console.log('   ✓ Deprecation successful')
  } catch (error) {
    console.error('   ✗ Deprecation failed:', error)
    // Continue anyway - deprecation failure shouldn't block hotfix
  }

  // Step 2: Update version in package.json
  console.log(`\n2. Updating ${pkgPath}/package.json to v${hotfixVersion}...`)
  const pkgJsonPath = join(ROOT_DIR, pkgPath, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
  pkg.version = hotfixVersion
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log('   ✓ Version updated')

  // Also update server.json for mcp-server
  if (pkgName === '@skillsmith/mcp-server') {
    const serverJsonPath = join(ROOT_DIR, pkgPath, 'server.json')
    try {
      const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf-8'))
      serverJson.version = hotfixVersion
      if (serverJson.packages?.[0]) {
        serverJson.packages[0].version = hotfixVersion
      }
      writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n')
      console.log('   ✓ server.json updated')
    } catch {
      console.log('   ⚠ server.json not found or invalid')
    }
  }

  // Step 3: Publish hotfix
  console.log(`\n3. Publishing ${pkgName}@${hotfixVersion}...`)
  try {
    execSync('npm publish --access public', {
      cwd: join(ROOT_DIR, pkgPath),
      stdio: 'inherit',
    })
    result.publishSuccess = true
    console.log('   ✓ Publish successful')
  } catch (error) {
    console.error('   ✗ Publish failed:', error)
    throw error
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║                      Hotfix Complete                          ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  ✓ ${pkgName}@${hotfixVersion} published`.padEnd(63) + '║')
  console.log(`║  ⚠ ${pkgName}@${brokenVersion} deprecated`.padEnd(63) + '║')
  console.log('╚══════════════════════════════════════════════════════════════╝')

  return result
}

// CLI entry point
if (process.argv[1]?.includes('hotfix-publish')) {
  const args = process.argv.slice(2)

  const pkgArg = args.find((a) => a.startsWith('--package='))
  const versionArg = args.find((a) => a.startsWith('--version='))
  const reasonArg = args.find((a) => a.startsWith('--reason='))
  const dryRun = args.includes('--dry-run')

  const pkg = pkgArg?.split('=')[1]
  const version = versionArg?.split('=')[1]
  const reason = reasonArg?.split('=')[1]

  if (!pkg || !version || !reason) {
    console.error(
      'Usage: hotfix-publish.ts --package=<name> --version=<broken> --reason=<msg> [--dry-run]'
    )
    console.error('')
    console.error('Options:')
    console.error('  --package    Package name (e.g., @skillsmith/mcp-server)')
    console.error('  --version    Broken version to deprecate (e.g., 0.3.18)')
    console.error('  --reason     Deprecation message')
    console.error('  --dry-run    Preview without making changes')
    console.error('')
    console.error('Example:')
    console.error('  npx tsx scripts/hotfix-publish.ts \\')
    console.error('    --package=@skillsmith/mcp-server \\')
    console.error('    --version=0.3.18 \\')
    console.error('    --reason="Missing createDatabaseAsync export"')
    process.exit(1)
  }

  try {
    const result = createHotfix({
      package: pkg,
      brokenVersion: version,
      reason,
      dryRun,
    })
    process.exit(result.publishSuccess ? 0 : 1)
  } catch (error) {
    console.error('Hotfix failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
