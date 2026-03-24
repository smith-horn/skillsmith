#!/usr/bin/env npx tsx
/**
 * Version Sync Validator
 * SMI-2230: Ensures package.json matches server.json for MCP server
 *
 * This prevents publishing issues where the MCP Registry gets out of sync
 * with npm due to version mismatches.
 *
 * Usage:
 *   npx tsx scripts/validate-versions.ts
 *   npx tsx scripts/validate-versions.ts --json
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(__dirname, '..')

interface ValidationResult {
  package: string
  packageJsonVersion: string
  serverJsonVersion?: string
  serverPkgVersion?: string
  match: boolean
  error?: string
}

interface ValidationReport {
  results: ValidationResult[]
  passed: boolean
  errors: string[]
}

export function validateVersions(): ValidationReport {
  const results: ValidationResult[] = []
  const errors: string[] = []

  // Check mcp-server package.json vs server.json
  const mcpServerPath = join(ROOT_DIR, 'packages/mcp-server')
  const pkgJsonPath = join(mcpServerPath, 'package.json')
  const serverJsonPath = join(mcpServerPath, 'server.json')

  if (!existsSync(pkgJsonPath)) {
    errors.push('packages/mcp-server/package.json not found')
    return { results, passed: false, errors }
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    const pkgVersion = pkg.version

    if (!existsSync(serverJsonPath)) {
      results.push({
        package: '@skillsmith/mcp-server',
        packageJsonVersion: pkgVersion,
        match: false,
        error: 'server.json not found',
      })
      errors.push(`@skillsmith/mcp-server: server.json not found (required for MCP Registry)`)
    } else {
      const server = JSON.parse(readFileSync(serverJsonPath, 'utf-8'))
      const serverVersion = server.version
      const serverPkgVersion = server.packages?.[0]?.version

      const versionMatch = pkgVersion === serverVersion
      const pkgVersionMatch = pkgVersion === serverPkgVersion

      results.push({
        package: '@skillsmith/mcp-server',
        packageJsonVersion: pkgVersion,
        serverJsonVersion: serverVersion,
        serverPkgVersion: serverPkgVersion,
        match: versionMatch && pkgVersionMatch,
        error: !versionMatch
          ? `package.json (${pkgVersion}) != server.json version (${serverVersion})`
          : !pkgVersionMatch
            ? `server.json version (${serverVersion}) != packages[0].version (${serverPkgVersion})`
            : undefined,
      })

      if (!versionMatch) {
        errors.push(
          `@skillsmith/mcp-server: package.json (${pkgVersion}) != server.json version (${serverVersion})`
        )
      }
      if (!pkgVersionMatch) {
        errors.push(
          `@skillsmith/mcp-server: server.json version (${serverVersion}) != packages[0].version (${serverPkgVersion})`
        )
      }
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e)
    results.push({
      package: '@skillsmith/mcp-server',
      packageJsonVersion: 'unknown',
      match: false,
      error: `Failed to read files: ${errorMsg}`,
    })
    errors.push(`@skillsmith/mcp-server: ${errorMsg}`)
  }

  return {
    results,
    passed: errors.length === 0,
    errors,
  }
}

function printReport(report: ValidationReport, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║                   Version Sync Validation                     ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')

  report.results.forEach((r) => {
    const icon = r.match ? '✓' : '✗'
    const shortName = r.package.replace('@skillsmith/', '')
    console.log(`║  ${icon} ${shortName.padEnd(18)} v${r.packageJsonVersion.padEnd(28)} ║`)

    if (r.serverJsonVersion) {
      const serverMatch = r.packageJsonVersion === r.serverJsonVersion ? '✓' : '✗'
      console.log(`║    ${serverMatch} server.json version:    ${r.serverJsonVersion.padEnd(23)} ║`)
    }
    if (r.serverPkgVersion) {
      const pkgMatch = r.packageJsonVersion === r.serverPkgVersion ? '✓' : '✗'
      console.log(`║    ${pkgMatch} server.json pkg version: ${r.serverPkgVersion.padEnd(23)} ║`)
    }
    if (r.error) {
      console.log(`║    └─ ${r.error.slice(0, 50).padEnd(52)} ║`)
    }
  })

  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  Status: ${(report.passed ? 'PASSED' : 'FAILED').padEnd(49)} ║`)
  console.log('╚══════════════════════════════════════════════════════════════╝')

  if (!report.passed) {
    console.error('\nErrors:')
    report.errors.forEach((e) => console.error(`  ✗ ${e}`))
  }
}

/**
 * Validates all 6 version locations are in sync.
 * Does NOT modify the existing validateVersions() contract.
 */
export function validateAllVersionLocations(): ValidationReport {
  const results: ValidationResult[] = []
  const errors: string[] = []

  // Run existing server.json checks
  const serverReport = validateVersions()
  results.push(...serverReport.results)
  errors.push(...serverReport.errors)

  // Check core VERSION constant
  const coreIndexPath = join(ROOT_DIR, 'packages/core/src/index.ts')
  const corePkgPath = join(ROOT_DIR, 'packages/core/package.json')
  if (existsSync(coreIndexPath) && existsSync(corePkgPath)) {
    const corePkgVersion = JSON.parse(readFileSync(corePkgPath, 'utf-8')).version
    const coreContent = readFileSync(coreIndexPath, 'utf-8')
    const match = coreContent.match(/export const VERSION = '([^']+)'/)
    const coreConstVersion = match ? match[1] : null

    if (coreConstVersion && coreConstVersion !== corePkgVersion) {
      errors.push(
        `@skillsmith/core: index.ts VERSION (${coreConstVersion}) != package.json (${corePkgVersion})`
      )
    }
    results.push({
      package: '@skillsmith/core',
      packageJsonVersion: corePkgVersion,
      match: coreConstVersion === corePkgVersion,
      error:
        coreConstVersion !== corePkgVersion
          ? `index.ts VERSION (${coreConstVersion}) != package.json (${corePkgVersion})`
          : undefined,
    })
  }

  // Check mcp-server PACKAGE_VERSION constant
  const mcpIndexPath = join(ROOT_DIR, 'packages/mcp-server/src/index.ts')
  const mcpPkgPath = join(ROOT_DIR, 'packages/mcp-server/package.json')
  if (existsSync(mcpIndexPath) && existsSync(mcpPkgPath)) {
    const mcpPkgVersion = JSON.parse(readFileSync(mcpPkgPath, 'utf-8')).version
    const mcpContent = readFileSync(mcpIndexPath, 'utf-8')
    const match = mcpContent.match(/const PACKAGE_VERSION = '([^']+)'/)
    const mcpConstVersion = match ? match[1] : null

    if (mcpConstVersion && mcpConstVersion !== mcpPkgVersion) {
      errors.push(
        `@skillsmith/mcp-server: index.ts PACKAGE_VERSION (${mcpConstVersion}) != package.json (${mcpPkgVersion})`
      )
    }
  }

  return { results, passed: errors.length === 0, errors }
}

// CLI entry point
if (process.argv[1]?.includes('validate-versions')) {
  const jsonOutput = process.argv.includes('--json')

  const report = validateVersions()
  printReport(report, jsonOutput)

  process.exit(report.passed ? 0 : 1)
}
