#!/usr/bin/env npx tsx
/**
 * Affected Package Detection Script (SMI-2190)
 *
 * Analyzes changed files and determines which packages are affected,
 * including downstream dependents in the monorepo.
 *
 * Usage:
 *   npx tsx scripts/ci/detect-affected.ts [--files "file1,file2"]
 *   npx tsx scripts/ci/detect-affected.ts [--changed-files-from-stdin]
 *
 * Output:
 *   JSON array of affected package names: ["@skillsmith/core", "@skillsmith/mcp-server"]
 */

import { readFileSync, readdirSync, existsSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGES_DIR = join(__dirname, '../../packages')

/**
 * Package information from package.json
 */
export interface PackageInfo {
  name: string
  path: string
  dirName: string
  dependencies: string[]
  devDependencies: string[]
}

/**
 * Result of affected package detection
 */
export interface AffectedResult {
  directlyChanged: string[]
  affectedByDependency: string[]
  all: string[]
  /** Directory names for matrix strategy (e.g., "core", "mcp-server") */
  dirNames: string[]
  reason: string
}

/**
 * Load all workspace packages from packages/ directory
 */
export function loadWorkspacePackages(): PackageInfo[] {
  const packages: PackageInfo[] = []

  if (!existsSync(PACKAGES_DIR)) {
    return packages
  }

  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const dir of dirs) {
    const pkgJsonPath = join(PACKAGES_DIR, dir, 'package.json')
    if (!existsSync(pkgJsonPath)) continue

    try {
      const content = readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(content)

      packages.push({
        name: pkg.name,
        path: join(PACKAGES_DIR, dir),
        dirName: dir,
        dependencies: Object.keys(pkg.dependencies || {}),
        devDependencies: Object.keys(pkg.devDependencies || {}),
      })
    } catch {
      console.error(`Warning: Could not parse ${pkgJsonPath}`)
    }
  }

  return packages
}

/**
 * Build dependency graph: maps each package to its dependents
 * (packages that depend on it)
 */
export function buildDependencyGraph(packages: PackageInfo[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>()

  // Initialize all packages with empty arrays
  for (const pkg of packages) {
    dependents.set(pkg.name, [])
  }

  // Build reverse dependency map
  for (const pkg of packages) {
    const allDeps = [...pkg.dependencies, ...pkg.devDependencies]
    for (const dep of allDeps) {
      // Only track workspace dependencies
      if (dependents.has(dep)) {
        dependents.get(dep)!.push(pkg.name)
      }
    }
  }

  return dependents
}

/**
 * Find which package a file belongs to based on path
 */
export function findPackageForFile(file: string, packages: PackageInfo[]): PackageInfo | undefined {
  // Handle packages/* files
  const packagesMatch = file.match(/^packages\/([^/]+)\//)
  if (packagesMatch) {
    const dirName = packagesMatch[1]
    return packages.find((p) => p.dirName === dirName)
  }

  return undefined
}

/**
 * Check if changes require all packages to be affected
 */
export function requiresAllPackages(changedFiles: string[]): { required: boolean; reason: string } {
  // Root-level config changes that affect all packages
  const rootPatterns = [
    /^package\.json$/,
    /^package-lock\.json$/,
    /^tsconfig\.json$/,
    /^tsconfig\.base\.json$/,
    /^vitest\.config\.ts$/,
    /^\.nvmrc$/,
    /^\.node-version$/,
  ]

  for (const file of changedFiles) {
    for (const pattern of rootPatterns) {
      if (pattern.test(file)) {
        return { required: true, reason: `Root config changed: ${file}` }
      }
    }
  }

  // SMI-2217: Supabase changes affect all packages
  // Rationale: Edge functions can import from any workspace package (@skillsmith/core,
  // @smith-horn/enterprise, etc.) and share TypeScript types/interfaces. Changes to
  // supabase/ should trigger full test suite to catch breaking changes in shared
  // interface contracts between packages and Edge Functions.
  const hasSupabaseChanges = changedFiles.some((f) => f.startsWith('supabase/'))
  if (hasSupabaseChanges) {
    return { required: true, reason: 'Supabase infrastructure changed' }
  }

  return { required: false, reason: '' }
}

/**
 * Find all downstream dependents recursively
 */
export function findAllDependents(
  packageName: string,
  dependencyGraph: Map<string, string[]>,
  visited: Set<string> = new Set()
): string[] {
  if (visited.has(packageName)) return []
  visited.add(packageName)

  const directDependents = dependencyGraph.get(packageName) || []
  const allDependents: string[] = [...directDependents]

  for (const dep of directDependents) {
    const transitive = findAllDependents(dep, dependencyGraph, visited)
    allDependents.push(...transitive)
  }

  return [...new Set(allDependents)]
}

/**
 * Main function: detect affected packages from changed files
 */
export function detectAffectedPackages(changedFiles: string[]): AffectedResult {
  const packages = loadWorkspacePackages()

  // Handle empty input
  if (changedFiles.length === 0) {
    return {
      directlyChanged: [],
      affectedByDependency: [],
      all: [],
      dirNames: [],
      reason: 'No files changed',
    }
  }

  // Check if root-level changes require all packages
  const rootCheck = requiresAllPackages(changedFiles)
  if (rootCheck.required) {
    const allNames = packages.map((p) => p.name)
    const allDirNames = packages.map((p) => p.dirName)
    return {
      directlyChanged: allNames,
      affectedByDependency: [],
      all: allNames,
      dirNames: allDirNames,
      reason: rootCheck.reason,
    }
  }

  // Build dependency graph
  const dependencyGraph = buildDependencyGraph(packages)

  // Find directly changed packages
  const directlyChanged = new Set<string>()
  for (const file of changedFiles) {
    const pkg = findPackageForFile(file, packages)
    if (pkg) {
      directlyChanged.add(pkg.name)
    }
  }

  // Find downstream dependents
  const affectedByDependency = new Set<string>()
  for (const pkgName of directlyChanged) {
    const dependents = findAllDependents(pkgName, dependencyGraph)
    for (const dep of dependents) {
      if (!directlyChanged.has(dep)) {
        affectedByDependency.add(dep)
      }
    }
  }

  // Combine all affected
  const all = [...directlyChanged, ...affectedByDependency]

  // Get directory names for affected packages (for matrix strategy)
  const dirNames = all
    .map((name) => packages.find((p) => p.name === name)?.dirName)
    .filter((d): d is string => d !== undefined)

  // Build reason string
  const reasons: string[] = []
  if (directlyChanged.size > 0) {
    reasons.push(`directly changed: ${directlyChanged.size}`)
  }
  if (affectedByDependency.size > 0) {
    reasons.push(`affected by dependency: ${affectedByDependency.size}`)
  }

  return {
    directlyChanged: [...directlyChanged],
    affectedByDependency: [...affectedByDependency],
    all,
    dirNames,
    reason: reasons.join(', ') || 'No packages affected',
  }
}

/**
 * Output results for GitHub Actions
 */
function outputForGitHub(result: AffectedResult): void {
  const outputFile = process.env.GITHUB_OUTPUT
  const summaryFile = process.env.GITHUB_STEP_SUMMARY

  // Output JSON arrays for matrix strategy
  const jsonArray = JSON.stringify(result.all)
  const dirNamesArray = JSON.stringify(result.dirNames)

  if (outputFile && existsSync(dirname(outputFile))) {
    appendFileSync(outputFile, `affected_packages=${jsonArray}\n`)
    appendFileSync(outputFile, `affected_dirs=${dirNamesArray}\n`)
    appendFileSync(outputFile, `affected_count=${result.all.length}\n`)
  }

  // Print JSON to stdout (primary output - directory names for matrix)
  console.log(dirNamesArray)

  // Generate job summary
  if (summaryFile && existsSync(dirname(summaryFile))) {
    const summary = `
## Affected Packages

| Category | Packages |
|----------|----------|
| **Directly Changed** | ${result.directlyChanged.length > 0 ? result.directlyChanged.join(', ') : 'None'} |
| **Affected by Dependency** | ${result.affectedByDependency.length > 0 ? result.affectedByDependency.join(', ') : 'None'} |
| **Total** | ${result.all.length} |

### Reason
${result.reason}

### Package List
${result.all.length > 0 ? result.all.map((p) => `- \`${p}\``).join('\n') : 'No packages affected'}
`
    appendFileSync(summaryFile, summary)
  }
}

/**
 * Main entry point
 */
function main(): void {
  const args = process.argv.slice(2)

  let changedFiles: string[]

  const filesIndex = args.indexOf('--files')
  if (filesIndex !== -1 && args[filesIndex + 1]) {
    changedFiles = args[filesIndex + 1].split(',').filter(Boolean)
  } else if (args.includes('--changed-files-from-stdin')) {
    // Read from stdin (for piping from git diff)
    const stdin = readFileSync(0, 'utf-8')
    changedFiles = stdin
      .trim()
      .split('\n')
      .filter((f) => f.length > 0)
  } else {
    // Default: read from stdin without flag
    try {
      const stdin = readFileSync(0, 'utf-8')
      changedFiles = stdin
        .trim()
        .split('\n')
        .filter((f) => f.length > 0)
    } catch {
      changedFiles = []
    }
  }

  const result = detectAffectedPackages(changedFiles)

  // Output for CI
  outputForGitHub(result)

  // Log details to stderr (doesn't interfere with JSON stdout)
  console.error(`Detected ${result.all.length} affected packages: ${result.reason}`)
}

// Run if executed directly
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url)
if (isMainModule) {
  main()
}
