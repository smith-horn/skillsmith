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
import { execSync } from 'child_process'

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

// Optional/virtual modules that are not real npm dependencies (SMI-2564)
// These are either dynamically imported with try/catch fallbacks or resolved
// by the framework build pipeline, not by npm.
const IGNORED_MODULES = new Set([
  // Optional native deps — loaded dynamically, fall back gracefully
  'web-tree-sitter',
  'tree-sitter',
  'tree-sitter-typescript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-rust',
  'tree-sitter-java',
  'hnswlib-node',
  '@e2b/code-interpreter',
  // better-sqlite3 removed in PR #214 (security vulnerability — SMI-2750).
  // betterSqlite3Driver.ts retains type imports and guarded require() calls;
  // isBetterSqlite3Available() wraps all access in try/catch with WASM fallback.
  'better-sqlite3',
  // Astro virtual modules — resolved by the Astro compiler, not npm
  'astro:content',
  'astro:middleware',
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

        // Skip optional/virtual modules (SMI-2564)
        if (IGNORED_MODULES.has(packageName) || IGNORED_MODULES.has(importPath)) {
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

  // audit:concurrency-ok — function-local Map; writer (line 292) and reader (return on line 298) share the same single-threaded scope. No cross-tick or cross-process access.
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

/**
 * SMI-5006: Guard against legacy `@skillsmith/core/billing` imports.
 *
 * The billing module relocated to `@smith-horn/enterprise/billing` in core
 * 0.7.0 and the `./billing` subpath export was removed (no shim). This
 * check fails preflight if any source file still imports the legacy path,
 * which would silently fail to resolve at install time for downstream
 * consumers.
 *
 * Exit code 2 (distinct from the missing-deps exit code 1) so CI logs make
 * the failure cause obvious.
 */
function checkLegacyBillingImports(rootDir: string): boolean {
  console.log('\n🔍 Checking for legacy @skillsmith/core/billing imports...\n')
  let output = ''
  try {
    output = execSync(
      'grep -rn "@skillsmith/core/billing" packages/ --include="*.ts" --include="*.tsx"',
      {
        cwd: rootDir,
        encoding: 'utf-8',
      }
    )
  } catch (err) {
    // grep exits 1 when no matches are found — that's the success case.
    const e = err as { status?: number; stdout?: string }
    if (e.status === 1) {
      console.log('✅ No legacy billing imports found.\n')
      return true
    }
    output = e.stdout ?? ''
  }
  // Filter out comments/docstrings that legitimately mention the legacy path
  // for documentation purposes. Real imports are matched by `from '@skillsmith/core/billing'`
  // or `import('@skillsmith/core/billing')` / `require('@skillsmith/core/billing')`.
  const lines = output.split('\n').filter((line) => {
    if (!line.trim()) return false
    // grep output format: <path>:<lineno>:<content>. Strip the prefix and
    // inspect the actual source content so we can ignore comments / docstrings
    // that legitimately mention the legacy path for migration guidance.
    const colonParts = line.split(':')
    if (colonParts.length < 3) return false
    const content = colonParts.slice(2).join(':').trimStart()
    // Skip single-line and JSDoc comments
    if (content.startsWith('//') || content.startsWith('*') || content.startsWith('/*')) {
      return false
    }
    // Match actual import/require statements (string literal containing the path)
    return /(?:from|import|require)\s*\(?\s*['"]@skillsmith\/core\/billing['"]/.test(content)
  })
  if (lines.length === 0) {
    console.log('✅ No legacy billing imports found.\n')
    return true
  }
  console.log(`❌ Found ${lines.length} legacy @skillsmith/core/billing import(s):\n`)
  for (const line of lines) {
    console.log(`   ${line}`)
  }
  console.log(
    '\n💡 Update imports to `@smith-horn/enterprise/billing` (SMI-5006 — billing relocated in core 0.7.0).\n'
  )
  return false
}

// Main
console.log('\n🚀 Pre-flight Dependency Check (SMI-760)\n')
console.log('='.repeat(50) + '\n')

const result = validateDependencies(ROOT_DIR)
const success = printResults(result)
const billingOk = checkLegacyBillingImports(ROOT_DIR)

if (!success) {
  process.exit(1)
}
if (!billingOk) {
  process.exit(2)
}
process.exit(0)
