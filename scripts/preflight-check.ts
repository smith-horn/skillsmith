#!/usr/bin/env npx tsx
/**
 * SMI-760: Pre-flight Dependency Validation
 *
 * Validates that all imported packages are listed in package.json dependencies.
 * Helps catch missing dependencies before runtime errors occur.
 *
 * Usage:
 *   npx tsx scripts/preflight-check.ts
 *   npm run preflight
 *
 * Exit codes:
 *   0 - All dependencies are satisfied
 *   1 - Missing dependencies found
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT_DIR = join(__dirname, '..')

interface PackageJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface ImportInfo {
  packageName: string
  filePath: string
  line: number
}

interface ValidationResult {
  missingDependencies: Map<string, ImportInfo[]>
  totalFilesScanned: number
  totalImportsFound: number
}

// Node.js built-in modules (not external dependencies)
const BUILTIN_MODULES = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
])

// Runtime-provided modules (not npm dependencies)
// These are provided by the host environment (e.g., VS Code extension API)
const RUNTIME_PROVIDED_MODULES = new Set([
  'vscode', // VS Code extension API - provided by VS Code runtime
])

/**
 * Extract package name from import specifier
 */
function extractPackageName(importPath: string): string | null {
  // Skip relative imports and internal
  if (importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('#')) {
    return null
  }

  // Skip workspace packages
  if (importPath.startsWith('@skillsmith/')) {
    return null
  }

  // Handle scoped packages (@org/package)
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/')
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`
    }
    return null
  }

  // Handle regular packages
  return importPath.split('/')[0] ?? null
}

/**
 * Parse a TypeScript file for import statements (simplified)
 */
function parseImports(filePath: string): ImportInfo[] {
  const content = readFileSync(filePath, 'utf-8')
  const imports: ImportInfo[] = []
  const lines = content.split('\n')

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum] ?? ''

    // Skip comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
      continue
    }

    // Find string literals in import/require statements
    const fromMatch = line.match(/from\s+['"]([^'"]+)['"]/)
    const importMatch = line.match(/import\s*\(\s*['"]([^'"]+)['"]/)
    const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]/)

    const matches = [fromMatch, importMatch, requireMatch].filter(Boolean)

    for (const match of matches) {
      if (match?.[1]) {
        let importPath = match[1]

        // Handle node: prefix
        if (importPath.startsWith('node:')) {
          importPath = importPath.slice(5)
        }

        const packageName = extractPackageName(importPath)
        if (!packageName) {
          continue
        }

        // Skip builtins (check against package name to handle fs/promises, etc.)
        if (BUILTIN_MODULES.has(packageName)) {
          continue
        }

        // Skip runtime-provided modules (e.g., vscode)
        if (RUNTIME_PROVIDED_MODULES.has(packageName)) {
          continue
        }

        imports.push({
          packageName,
          filePath,
          line: lineNum + 1,
        })
      }
    }
  }

  return imports
}

/**
 * Find all TypeScript files in a directory
 */
function findTypeScriptFiles(dir: string): string[] {
  const files: string[] = []

  if (!existsSync(dir)) return files

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir)

    for (const entry of entries) {
      // Skip certain directories
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
        continue
      }

      const fullPath = join(currentDir, entry)
      const stat = statSync(fullPath)

      if (stat.isDirectory()) {
        walk(fullPath)
      } else if (
        (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
        !entry.endsWith('.d.ts') &&
        !entry.endsWith('.test.ts') &&
        !entry.endsWith('.spec.ts')
      ) {
        files.push(fullPath)
      }
    }
  }

  walk(dir)
  return files
}

/**
 * Load all dependencies from package.json files
 */
function loadAllDependencies(rootDir: string): Set<string> {
  const allDeps = new Set<string>()

  function loadPkg(pkgPath: string): void {
    if (!existsSync(pkgPath)) return
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson
    Object.keys(pkg.dependencies ?? {}).forEach((d) => allDeps.add(d))
    Object.keys(pkg.devDependencies ?? {}).forEach((d) => allDeps.add(d))
    Object.keys(pkg.peerDependencies ?? {}).forEach((d) => allDeps.add(d))
    Object.keys(pkg.optionalDependencies ?? {}).forEach((d) => allDeps.add(d))
  }

  // Root package.json
  loadPkg(join(rootDir, 'package.json'))

  // Workspace packages
  const packagesDir = join(rootDir, 'packages')
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir)) {
      loadPkg(join(packagesDir, pkg, 'package.json'))
    }
  }

  return allDeps
}

/**
 * Main validation
 */
function validateDependencies(rootDir: string): ValidationResult {
  console.log('🔍 Scanning for imports...\n')

  const allDeps = loadAllDependencies(rootDir)
  const tsFiles = findTypeScriptFiles(join(rootDir, 'packages'))

  console.log(`  Found ${tsFiles.length} TypeScript source files`)
  console.log(`  Found ${allDeps.size} declared dependencies\n`)

  const missingDependencies = new Map<string, ImportInfo[]>()
  let totalImports = 0

  for (const file of tsFiles) {
    const imports = parseImports(file)
    totalImports += imports.length

    for (const imp of imports) {
      if (!allDeps.has(imp.packageName)) {
        const existing = missingDependencies.get(imp.packageName) ?? []
        existing.push(imp)
        missingDependencies.set(imp.packageName, existing)
      }
    }
  }

  return {
    missingDependencies,
    totalFilesScanned: tsFiles.length,
    totalImportsFound: totalImports,
  }
}

/**
 * Print results
 */
function printResults(result: ValidationResult): boolean {
  console.log('📊 Results:')
  console.log(`   Files scanned: ${result.totalFilesScanned}`)
  console.log(`   Imports found: ${result.totalImportsFound}`)
  console.log('')

  if (result.missingDependencies.size === 0) {
    console.log('✅ All dependencies are satisfied!\n')
    return true
  }

  console.log(`❌ Found ${result.missingDependencies.size} missing dependencies:\n`)

  for (const [pkg, locations] of result.missingDependencies) {
    console.log(`  📦 ${pkg}`)
    const toShow = locations.slice(0, 3)
    for (const loc of toShow) {
      const relPath = relative(ROOT_DIR, loc.filePath)
      console.log(`     └─ ${relPath}:${loc.line}`)
    }
    if (locations.length > 3) {
      console.log(`     └─ ... and ${locations.length - 3} more`)
    }
    console.log('')
  }

  const packages = Array.from(result.missingDependencies.keys())
  console.log('💡 To fix, run:')
  console.log(`   npm install ${packages.join(' ')}\n`)

  return false
}

// Main
console.log('\n🚀 Pre-flight Dependency Check (SMI-760)\n')
console.log('='.repeat(50) + '\n')

const result = validateDependencies(ROOT_DIR)
const success = printResults(result)

process.exit(success ? 0 : 1)
