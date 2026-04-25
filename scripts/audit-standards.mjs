#!/usr/bin/env node
/**
 * Standards Audit Script for Skillsmith
 *
 * Checks codebase compliance with engineering standards.
 * Run: npm run audit:standards
 *
 * SMI-4450 Step 5: `--only <name>[,<name>]` dispatches to CHECK_REGISTRY
 * and skips the full audit. Used by lint-staged in pre-commit for retro
 * frontmatter lint (per SPARC §S5 M5).
 */

import { parseArgs } from 'node:util'
import { execSync } from 'child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { dirname, extname, join, relative, resolve as resolvePath } from 'path'
import {
  satisfies,
  extractCompletionIssues,
  collectTsEntryExports,
  extractSmokeTestRequiredArrays,
  extractCliCommandNames,
  findCliHintCommandRefs,
  findRelativeFunctionsV1Urls,
  findReturningTableAmbiguity,
} from './audit-standards-helpers.mjs'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

let passed = 0
let warnings = 0
let failed = 0

// SMI-4450 Step 5 — selective-check dispatcher. Extend via new entries; each
// handler returns `true` on pass, `false` on fail (in error mode). The
// dispatcher below runs only the requested checks and exits — the full audit
// body (starting at the next `console.log` banner) is skipped.
const CHECK_REGISTRY = new Map([
  [
    'retro-frontmatter',
    async ({ paths }) => {
      const { checkRetroFrontmatter } = await import('./lib/retro-frontmatter.mjs')
      const mode =
        process.env.RETRO_FRONTMATTER_MODE ??
        (cliArgs.values.error ? 'error' : cliArgs.values.warn ? 'warn' : 'error')
      return checkRetroFrontmatter({ paths, mode })
    },
  ],
])

const cliArgs = parseArgs({
  options: {
    only: { type: 'string' },
    paths: { type: 'string' },
    warn: { type: 'boolean' },
    error: { type: 'boolean' },
  },
  allowPositionals: false,
  strict: false,
})

if (cliArgs.values.only) {
  const requested = cliArgs.values.only
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const valid = [...CHECK_REGISTRY.keys()]
  let hadFailure = false
  for (const name of requested) {
    const fn = CHECK_REGISTRY.get(name)
    if (!fn) {
      console.error(`Unknown check: ${name}. Valid: ${valid.join(', ')}`)
      process.exit(2)
    }
    const ok = await fn({ paths: cliArgs.values.paths ?? null })
    if (!ok) hadFailure = true
  }
  process.exit(hadFailure ? 1 : 0)
}

function pass(msg) {
  console.log(`${GREEN}✓${RESET} ${msg}`)
  passed++
}

function warn(msg, fix) {
  console.log(`${YELLOW}⚠${RESET} ${msg}`)
  if (fix) console.log(`  ${YELLOW}Fix:${RESET} ${fix}`)
  warnings++
}

function fail(msg, fix) {
  console.log(`${RED}✗${RESET} ${msg}`)
  if (fix) console.log(`  ${YELLOW}Fix:${RESET} ${fix}`)
  failed++
}

function getFilesRecursive(dir, extensions) {
  const files = []
  if (!existsSync(dir)) return files

  const items = readdirSync(dir)
  for (const item of items) {
    const fullPath = join(dir, item)
    if (item === 'node_modules' || item === 'dist' || item === '.git') continue

    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...getFilesRecursive(fullPath, extensions))
    } else if (extensions.some((ext) => item.endsWith(ext))) {
      files.push(fullPath)
    }
  }
  return files
}

console.log(`\n${BOLD}📋 Skillsmith Standards Audit${RESET}\n`)
console.log('━'.repeat(50) + '\n')

// 1. TypeScript Strict Mode
console.log(`${BOLD}1. TypeScript Configuration${RESET}`)
try {
  const tsConfigs = [
    'packages/core/tsconfig.json',
    'packages/mcp-server/tsconfig.json',
    'packages/cli/tsconfig.json',
  ]
  for (const configPath of tsConfigs) {
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      if (config.compilerOptions?.strict === true) {
        pass(`${configPath}: strict mode enabled`)
      } else {
        fail(`${configPath}: strict mode not enabled`, 'Set "strict": true in compilerOptions')
      }
    }
  }
} catch (e) {
  fail(`Error checking tsconfig: ${e.message}`)
}

// 2. No 'any' types in source
console.log(`\n${BOLD}2. Type Safety (no 'any' types)${RESET}`)
try {
  const sourceFiles = getFilesRecursive('packages', ['.ts', '.tsx']).filter(
    (f) => !f.includes('.test.') && !f.includes('.d.ts')
  )

  let anyCount = 0
  const filesWithAny = []

  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8')
    // Match ': any' or '<any>' but not in comments
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
      if (line.match(/:\s*any[^a-zA-Z]|<any>|as\s+any/)) {
        anyCount++
        if (!filesWithAny.includes(file)) {
          filesWithAny.push({ file, line: i + 1 })
        }
      }
    }
  }

  if (anyCount === 0) {
    pass('No untyped "any" found in source files')
  } else {
    warn(
      `Found ${anyCount} "any" types in ${filesWithAny.length} files`,
      'Use "unknown" for external data or add proper types'
    )
    filesWithAny.slice(0, 3).forEach(({ file, line }) => {
      console.log(`    ${relative(process.cwd(), file)}:${line}`)
    })
  }
} catch (e) {
  fail(`Error checking for 'any' types: ${e.message}`)
}

// 3. File Length
console.log(`\n${BOLD}3. File Length (max 500 lines)${RESET}`)
try {
  const sourceFiles = getFilesRecursive('packages', ['.ts', '.tsx']).filter(
    (f) => !f.includes('.test.')
  )

  const longFiles = []
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8')
    const lineCount = content.split('\n').length
    if (lineCount > 500) {
      longFiles.push({ file: relative(process.cwd(), file), lines: lineCount })
    }
  }

  if (longFiles.length === 0) {
    pass('All source files under 500 lines')
  } else {
    warn(`${longFiles.length} files exceed 500 lines`, 'Split into smaller modules')
    longFiles.forEach(({ file, lines }) => {
      console.log(`    ${file}: ${lines} lines`)
    })
  }
} catch (e) {
  fail(`Error checking file lengths: ${e.message}`)
}

// 4. Test Files Exist
console.log(`\n${BOLD}4. Test Coverage${RESET}`)
try {
  const testFiles = getFilesRecursive('packages', ['.test.ts', '.test.tsx', '.spec.ts'])
  if (testFiles.length > 0) {
    pass(`Found ${testFiles.length} test files`)
  } else {
    fail('No test files found', 'Add *.test.ts files alongside source')
  }
} catch (e) {
  fail(`Error checking test files: ${e.message}`)
}

// 5. Standards.md exists (in private submodule)
console.log(`\n${BOLD}5. Documentation${RESET}`)
const standardsPath = existsSync('docs/internal/architecture/standards.md')
  ? 'docs/internal/architecture/standards.md'
  : null
if (standardsPath) {
  pass(`standards.md exists (${standardsPath})`)
} else {
  // Standards are in private submodule — not available without org access
  warn('standards.md not found (init submodule: git submodule update --init)')
}

if (existsSync('CLAUDE.md')) {
  pass('CLAUDE.md exists')
} else {
  fail('CLAUDE.md not found', 'Create at project root')
}

// 6. ADR Directory (in private submodule)
console.log(`\n${BOLD}6. Architecture Decision Records${RESET}`)
const adrPath = existsSync('docs/internal/adr') ? 'docs/internal/adr' : null
if (adrPath) {
  const adrs = readdirSync(adrPath).filter((f) => f.endsWith('.md'))
  pass(`${adrPath}/ exists with ${adrs.length} ADRs`)
} else {
  // ADRs are in private submodule — not available without org access
  warn('docs/internal/adr/ not found (init submodule: git submodule update --init)')
}

// 7. Pre-commit Hooks
console.log(`\n${BOLD}7. Pre-commit Hooks${RESET}`)
if (existsSync('.husky/pre-commit')) {
  pass('Husky pre-commit hook configured')
} else {
  warn('Pre-commit hook not found', 'Run: npx husky add .husky/pre-commit')
}

// 8. Docker Configuration
console.log(`\n${BOLD}8. Docker Configuration${RESET}`)

// Check docker-compose.yml exists
if (existsSync('docker-compose.yml')) {
  pass('docker-compose.yml exists')

  try {
    const dockerCompose = readFileSync('docker-compose.yml', 'utf8')

    // Check for dev profile
    if (dockerCompose.includes('profiles:') && dockerCompose.includes('- dev')) {
      pass('Docker dev profile configured')
    } else {
      fail('Docker dev profile not found', 'Add "profiles: [dev]" to docker-compose.yml')
    }

    // Check container name is correct (not phase1)
    if (dockerCompose.includes('skillsmith-dev-1') && !dockerCompose.includes('phase1-dev')) {
      pass('Container name is correct (skillsmith-dev-1)')
    } else if (dockerCompose.includes('phase1-dev')) {
      fail('Container name still references phase1', 'Update container_name to skillsmith-dev-1')
    } else {
      warn('Container name not explicitly set', 'Set container_name: skillsmith-dev-1')
    }

    // Check volume mounts
    if (dockerCompose.includes('.:/app')) {
      pass('Volume mount configured (.:/app)')
    } else {
      fail('Volume mount not configured', 'Add ".:/app" to volumes')
    }
  } catch (e) {
    fail(`Error reading docker-compose.yml: ${e.message}`)
  }
} else {
  fail('docker-compose.yml not found', 'Create docker-compose.yml for Docker-first development')
}

// Check Dockerfile exists
if (existsSync('Dockerfile')) {
  pass('Dockerfile exists')
} else {
  fail('Dockerfile not found', 'Create Dockerfile for development container')
}

// Check if Docker container is running (skip when running inside Docker — no socket access)
const insideDocker = existsSync('/.dockerenv')
if (insideDocker) {
  pass('Docker container check skipped (running inside container)')
} else {
  try {
    const result = execSync('docker ps --format "{{.Names}}" 2>/dev/null', { encoding: 'utf8' })
    if (result.includes('skillsmith-dev-1')) {
      pass('Docker container is running (skillsmith-dev-1)')
    } else {
      warn('Docker container not running', 'Run: docker compose --profile dev up -d')
    }
  } catch (e) {
    warn('Could not check Docker status', 'Ensure Docker is installed and running')
  }
}

// 9. Script Docker Compliance
console.log(`\n${BOLD}9. Script Docker Compliance${RESET}`)

// Check if scripts use local npm commands (anti-pattern)
// Excludes:
//   - launch-*.sh (workflow launchers run locally by design)
//   - run_cmd npm (Docker wrapper function per SMI-1366)
//   - Documentation/descriptive text (e.g., "Add npm run benchmark script")
const scriptsDir = 'scripts'
if (existsSync(scriptsDir)) {
  const scriptFiles = readdirSync(scriptsDir).filter(
    (f) => (f.endsWith('.sh') || f.endsWith('.md')) && !f.startsWith('launch-')
  )
  let localNpmCount = 0
  const violatingFiles = []

  for (const file of scriptFiles) {
    const filePath = join(scriptsDir, file)
    const stat = statSync(filePath)
    if (!stat.isFile()) continue

    const content = readFileSync(filePath, 'utf8')
    // Check for npm commands that should be in Docker
    // Match: npm run/test/install but NOT docker exec ... npm
    const lines = content.split('\n')
    for (const line of lines) {
      if (line.trim().startsWith('#')) continue
      // Skip run_cmd wrapper (Docker fallback per SMI-1366)
      if (line.includes('run_cmd')) continue
      // Skip descriptive documentation text (not executable commands)
      // These patterns describe actions, not execute them
      if (line.match(/Add\s+npm\s+(run\s+)?[a-z]+\s+script/i)) continue
      if (line.match(/Add\s+npm\s+script/i)) continue
      if (line.match(/Create\s+.*npm\s+/i)) continue
      if (
        line.match(/(?<!docker exec \S+ )npm (run|test|install)\b/) &&
        !line.includes('docker exec')
      ) {
        localNpmCount++
        if (!violatingFiles.includes(file)) {
          violatingFiles.push(file)
        }
      }
    }
  }

  if (localNpmCount === 0) {
    pass('All scripts use Docker for npm commands')
  } else {
    // Changed to warn - launch scripts are expected to run locally
    warn(
      `${violatingFiles.length} scripts use local npm commands`,
      'Consider: docker exec skillsmith-dev-1 npm ...'
    )
    violatingFiles.slice(0, 3).forEach((f) => {
      console.log(`    scripts/${f}`)
    })
  }
} else {
  warn('No scripts directory found')
}

// 10. SMI-1900: Supabase Anonymous Functions
console.log(`\n${BOLD}10. Supabase Anonymous Functions (SMI-1900)${RESET}`)

// Canonical list of functions that require --no-verify-jwt deployment
// Includes both anonymous functions and authenticated functions with internal JWT validation
const NO_VERIFY_JWT_FUNCTIONS = [
  // Anonymous functions (no auth required)
  'early-access-signup',
  'contact-submit',
  'stats',
  'skills-search',
  'skills-get',
  'skills-recommend',
  'stripe-webhook',
  'checkout',
  'events',
  // Anonymous functions (health & webhook)
  'health',
  'email-inbound',
  // Authenticated functions with internal JWT validation
  // These validate tokens in function code, not at Supabase gateway
  'generate-license',
  'regenerate-license',
  'create-portal-session',
  'list-invoices',
  'skills-outreach-preferences',
  'admin-grant-subscription',
  // Service-role batch-send functions (SMI-4400)
  // Deployed with --no-verify-jwt because service-role callers present the
  // service-role key in the Authorization header; gateway JWT check would
  // reject it. Server-side re-checks the service-role header via
  // createSupabaseAdminClient().
  'advance-notice-email',
  // SMI-4402: Device-code OAuth flow (RFC 8628)
  // auth-device-code + auth-device-token are anonymous; auth-device-approve
  // uses gateway-verified JWT (verify_jwt = true) so it is NOT listed here.
  'auth-device-code',
  'auth-device-token',
]

const CONFIG_TOML_PATH = 'supabase/config.toml'
const CLAUDE_MD_PATH = 'CLAUDE.md'

if (existsSync(CONFIG_TOML_PATH) && existsSync(CLAUDE_MD_PATH)) {
  const configToml = readFileSync(CONFIG_TOML_PATH, 'utf8')
  const claudeMd = readFileSync(CLAUDE_MD_PATH, 'utf8')

  // Parse config.toml for [functions.X] with verify_jwt = false
  const configFunctions = new Set()
  const configRegex = /\[functions\.([^\]]+)\]\s*\n\s*verify_jwt\s*=\s*false/g
  let match
  while ((match = configRegex.exec(configToml)) !== null) {
    configFunctions.add(match[1])
  }

  // Parse CLAUDE.md for documented deploy commands
  const docFunctions = new Set()
  const docRegex = /npx supabase functions deploy ([a-z][a-z0-9-]+) --no-verify-jwt/g
  while ((match = docRegex.exec(claudeMd)) !== null) {
    docFunctions.add(match[1])
  }

  let anonFailed = false

  // Check all canonical functions are in config.toml
  for (const fn of NO_VERIFY_JWT_FUNCTIONS) {
    if (!configFunctions.has(fn)) {
      fail(`Missing from config.toml: [functions.${fn}] with verify_jwt = false`)
      anonFailed = true
    }
  }

  // Check all canonical functions are documented
  for (const fn of NO_VERIFY_JWT_FUNCTIONS) {
    if (!docFunctions.has(fn)) {
      fail(`Missing from CLAUDE.md: npx supabase functions deploy ${fn} --no-verify-jwt`)
      anonFailed = true
    }
  }

  if (!anonFailed) {
    pass(`All ${NO_VERIFY_JWT_FUNCTIONS.length} --no-verify-jwt functions properly configured`)
  }
} else {
  if (!existsSync(CONFIG_TOML_PATH)) {
    warn('supabase/config.toml not found - skipping anonymous function check')
  }
  if (!existsSync(CLAUDE_MD_PATH)) {
    warn('CLAUDE.md not found - skipping anonymous function check')
  }
}

// 11. Database Migration Standards (SMI-1944)
console.log(`\n${BOLD}11. Database Migration Standards${RESET}`)

const MIGRATIONS_DIR = 'supabase/migrations'
// Only check migrations >= 030 (new standard applies from this number)
const MIN_MIGRATION_NUMBER = 30

if (existsSync(MIGRATIONS_DIR)) {
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const num = parseInt(f.substring(0, 3), 10)
      return !isNaN(num) && num >= MIN_MIGRATION_NUMBER
    })
    .sort()

  if (migrationFiles.length === 0) {
    pass('No migrations >= 030 to check')
  } else {
    let headerIssues = 0
    let doBlockIssues = 0
    const filesWithIssues = []

    for (const file of migrationFiles) {
      const filePath = join(MIGRATIONS_DIR, file)
      const contentBuf = readFileSync(filePath)
      // Skip git-crypt encrypted files (binary blobs starting with \x00GITCRYPT)
      if (contentBuf[0] === 0x00 && contentBuf.toString('utf8', 1, 9) === 'GITCRYPT') {
        continue
      }
      const content = contentBuf.toString('utf8')
      const lines = content.split('\n')
      const headerLines = lines.slice(0, 10).join('\n')

      // Check 1: SMI reference in header
      const hasSmiRef = /--\s*SMI-\d+/i.test(headerLines)

      // Check 2: Date in header (YYYY-MM-DD format)
      const hasDate =
        /--.*\d{4}-\d{2}-\d{2}/.test(headerLines) ||
        /--.*Created:\s*\d{4}-\d{2}-\d{2}/.test(headerLines)

      if (!hasSmiRef || !hasDate) {
        headerIssues++
        if (!filesWithIssues.some((f) => f.file === file)) {
          filesWithIssues.push({
            file,
            issues: [
              !hasSmiRef ? 'missing SMI reference' : null,
              !hasDate ? 'missing date' : null,
            ].filter(Boolean),
          })
        }
      }

      // Check 3: ALTER FUNCTION without DO block wrapper (warn only)
      // Look for ALTER FUNCTION that's not inside a DO block
      const hasAlterFunction = /^\s*ALTER\s+FUNCTION\s+/im.test(content)
      const hasDoBlock = /DO\s+\$\$/i.test(content)

      if (hasAlterFunction && !hasDoBlock) {
        doBlockIssues++
        const existing = filesWithIssues.find((f) => f.file === file)
        if (existing) {
          existing.issues.push('ALTER FUNCTION without DO block')
        } else {
          filesWithIssues.push({ file, issues: ['ALTER FUNCTION without DO block'] })
        }
      }
    }

    // Report header issues
    if (headerIssues === 0) {
      pass(`All ${migrationFiles.length} migrations have proper headers (SMI ref + date)`)
    } else {
      warn(
        `${headerIssues} migrations missing header info`,
        'Add "-- SMI-XXXX: Description" and "-- Created: YYYY-MM-DD"'
      )
      filesWithIssues
        .filter((f) => f.issues.some((i) => i.includes('SMI') || i.includes('date')))
        .slice(0, 3)
        .forEach(({ file, issues }) => {
          console.log(
            `    ${file}: ${issues.filter((i) => i.includes('SMI') || i.includes('date')).join(', ')}`
          )
        })
    }

    // Report DO block issues (warning only - gradual adoption)
    if (doBlockIssues === 0) {
      pass('All ALTER FUNCTION statements use DO block wrappers')
    } else {
      warn(
        `${doBlockIssues} migrations have ALTER FUNCTION without DO block`,
        'Wrap in DO $$ BEGIN ... END $$; for idempotency'
      )
      filesWithIssues
        .filter((f) => f.issues.some((i) => i.includes('DO block')))
        .slice(0, 3)
        .forEach(({ file }) => {
          console.log(`    ${file}`)
        })
    }

    // Check 4: Functions without search_path (static analysis)
    // Look for CREATE OR REPLACE FUNCTION without SET search_path
    let searchPathIssues = 0
    const filesWithSearchPathIssues = []

    for (const file of migrationFiles) {
      const filePath = join(MIGRATIONS_DIR, file)
      const content = readFileSync(filePath, 'utf8')

      // Find CREATE OR REPLACE FUNCTION blocks
      const funcMatches = content.match(
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+[\w.]+\s*\([^)]*\)[^;]+?LANGUAGE\s+plpgsql[^;]*;/gis
      )

      if (funcMatches) {
        for (const funcBlock of funcMatches) {
          // Check if it has SET search_path
          if (!/SET\s+search_path\s*=/i.test(funcBlock)) {
            searchPathIssues++
            if (!filesWithSearchPathIssues.includes(file)) {
              filesWithSearchPathIssues.push(file)
            }
          }
        }
      }
    }

    if (searchPathIssues === 0) {
      pass('All new functions have explicit search_path')
    } else {
      warn(
        `${searchPathIssues} functions in migrations lack search_path`,
        'Add "SET search_path = public, extensions" after LANGUAGE clause'
      )
      filesWithSearchPathIssues.slice(0, 3).forEach((file) => {
        console.log(`    ${file}`)
      })
    }
  }
} else {
  warn('supabase/migrations directory not found - skipping migration checks')
}

// 12. Exact Dependency Versions (SMI-2162)
console.log(`\n${BOLD}12. Exact Dependency Versions (SMI-2162)${RESET}`)

const PACKAGES_DIR = 'packages'
if (existsSync(PACKAGES_DIR)) {
  const packageDirs = readdirSync(PACKAGES_DIR).filter((d) => {
    const pkgPath = join(PACKAGES_DIR, d, 'package.json')
    return existsSync(pkgPath)
  })

  const violations = []

  // Deps that require caret (^) ranges to survive Dependabot lock regeneration.
  // Exact pins get dropped by npm dedup against transitive ranges.
  // Review: remove entries when the package moves to an exact pin.
  const CARET_RANGE_ALLOWLIST = new Set([
    'jose', // enterprise: root has v6.x, needs nested v5.x (a8d7188d)
    '@modelcontextprotocol/sdk', // mcp-server: ruflo ^1.20.1 dedupes exact 1.27.1 (d93bacc8)
  ])

  for (const dir of packageDirs) {
    const pkgPath = join(PACKAGES_DIR, dir, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const deps = pkg.dependencies || {}

      for (const [name, version] of Object.entries(deps)) {
        // Skip workspace siblings — caret ranges required for npm workspace resolution
        // (exact pins break symlink resolution). See MEMORY.md "Database Patterns".
        if (name.startsWith('@skillsmith/')) continue
        if (CARET_RANGE_ALLOWLIST.has(name)) continue
        if (typeof version === 'string' && (version.startsWith('^') || version.startsWith('~'))) {
          violations.push({ package: dir, dep: name, version })
        }
      }
    } catch (e) {
      warn(`Could not parse ${pkgPath}: ${e.message}`)
    }
  }

  if (violations.length === 0) {
    pass('All production dependencies use exact versions')
  } else {
    fail(
      `${violations.length} dependencies use semver ranges (^ or ~)`,
      'Pin to exact versions for reproducibility'
    )
    violations.slice(0, 5).forEach(({ package: pkg, dep, version }) => {
      console.log(`    packages/${pkg}: ${dep}@${version}`)
    })
    if (violations.length > 5) {
      console.log(`    ... and ${violations.length - 5} more`)
    }
  }
} else {
  warn('packages directory not found - skipping dependency check')
}

// 13. SECURITY.md Feature Coverage (SMI-2498)
console.log(`\n${BOLD}13. SECURITY.md Feature Coverage (SMI-2498)${RESET}`)

const SECURITY_MD_PATH = 'SECURITY.md'
if (existsSync(SECURITY_MD_PATH)) {
  const securityMd = readFileSync(SECURITY_MD_PATH, 'utf8')

  // Key security features that must be documented
  const REQUIRED_FEATURES = [
    { keyword: 'security@skillsmith.app', label: 'Security contact email' },
    { keyword: 'Skill Security Scanner', label: 'Skill security scanner section' },
    { keyword: 'Trust Tier', label: 'Trust tiers section' },
    { keyword: 'Quarantine', label: 'Quarantine system section' },
    { keyword: 'Supported Versions', label: 'Supported versions table' },
    { keyword: '@skillsmith/core', label: 'Core package in scope' },
    { keyword: '@skillsmith/mcp-server', label: 'MCP server package in scope' },
    { keyword: '@skillsmith/cli', label: 'CLI package in scope' },
    { keyword: '@smith-horn/enterprise', label: 'Enterprise package in scope' },
    { keyword: 'Varlock', label: 'Varlock secret management' },
    { keyword: 'execFileSync', label: 'Command injection prevention' },
    { keyword: 'ReDoS', label: 'ReDoS prevention' },
    { keyword: 'git-crypt', label: 'Encrypted documentation' },
  ]

  let secMissing = 0
  for (const { keyword, label } of REQUIRED_FEATURES) {
    if (!securityMd.includes(keyword)) {
      fail(`SECURITY.md missing: ${label} (keyword: "${keyword}")`)
      secMissing++
    }
  }

  if (secMissing === 0) {
    pass(`SECURITY.md covers all ${REQUIRED_FEATURES.length} required security features`)
  }
} else {
  fail('SECURITY.md not found', 'Create at project root')
}

// Blog Content Checks
console.log(`\n${BOLD}Blog Content${RESET}\n`)

const blogDir = 'packages/website/src/content/blog'
if (existsSync(blogDir)) {
  const blogFiles = getFilesRecursive(blogDir, ['.md', '.mdx'])
  const duplicateH1s = []

  for (const file of blogFiles) {
    const content = readFileSync(file, 'utf8')
    // Check if file has frontmatter title AND a markdown H1
    const hasFrontmatterTitle = /^---[\s\S]*?^title:\s*.+/m.test(content)
    // Match H1 outside of code blocks (simple heuristic: line starts with # and is not inside ```)
    const lines = content.split('\n')
    let inCodeBlock = false
    for (const line of lines) {
      if (line.startsWith('```')) inCodeBlock = !inCodeBlock
      if (!inCodeBlock && /^# /.test(line) && hasFrontmatterTitle) {
        duplicateH1s.push({ file: relative('.', file), line })
        break
      }
    }
  }

  if (duplicateH1s.length === 0) {
    pass('No blog posts have duplicate H1 headings (frontmatter title is sufficient)')
  } else {
    warn(
      `${duplicateH1s.length} blog post(s) have duplicate H1 headings`,
      'Remove markdown # heading when frontmatter has title (BlogLayout renders <h1> from title)'
    )
    duplicateH1s.forEach(({ file }) => console.log(`    ${file}`))
  }
} else {
  warn('Blog directory not found - skipping blog content checks')
}

// ClientRouter Compatibility Check
console.log(`\n${BOLD}ClientRouter Compatibility${RESET}\n`)

const websiteSrcDir = 'packages/website/src'
if (existsSync(websiteSrcDir)) {
  const astroFiles = getFilesRecursive(websiteSrcDir, ['.astro'])
  const domContentLoadedFiles = []

  for (const file of astroFiles) {
    const content = readFileSync(file, 'utf8')
    // Find DOMContentLoaded in script tags (not in comments)
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (
        line.includes('DOMContentLoaded') &&
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*')
      ) {
        domContentLoadedFiles.push({ file: relative('.', file), line: i + 1 })
      }
    }
  }

  if (domContentLoadedFiles.length === 0) {
    pass('No Astro files use DOMContentLoaded (use astro:page-load for ClientRouter)')
  } else {
    fail(
      `${domContentLoadedFiles.length} Astro file(s) use DOMContentLoaded instead of astro:page-load`,
      'Replace DOMContentLoaded with astro:page-load for ClientRouter view transition support'
    )
    domContentLoadedFiles.forEach(({ file, line }) => console.log(`    ${file}:${line}`))
  }
} else {
  warn('Website src directory not found - skipping ClientRouter check')
}

// CSP-safe event handlers on /account/** (SMI-4311)
console.log(`\n${BOLD}CSP: No inline event handlers on /account/** pages (SMI-4311)${RESET}\n`)

const accountPagesDir = 'packages/website/src/pages/account'
if (existsSync(accountPagesDir)) {
  const accountAstroFiles = getFilesRecursive(accountPagesDir, ['.astro'])
  const inlineHandlerFiles = []

  for (const file of accountAstroFiles) {
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Match any "on<event>=" attribute (onclick, onload, onchange, etc.)
      // Word-boundary anchored. Skip comment lines.
      if (
        /\bon[a-z]+\s*=\s*["']/.test(line) &&
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*') &&
        !line.trim().startsWith('<!--')
      ) {
        inlineHandlerFiles.push({ file: relative('.', file), line: i + 1 })
      }
    }
  }

  if (inlineHandlerFiles.length === 0) {
    pass('No inline event handlers on /account/** pages (CSP-safe)')
  } else {
    fail(
      `${inlineHandlerFiles.length} inline event handler(s) found on /account/** pages`,
      'Replace inline on<event>= attributes with data-action attrs + addEventListener in <script> block (see SMI-4311)'
    )
    inlineHandlerFiles.forEach(({ file, line }) => console.log(`    ${file}:${line}`))
  }
} else {
  warn('/account/** pages directory not found - skipping inline-handler check')
}

// 14. Accessibility Patterns (SMI-2541)
console.log(`\n${BOLD}14. Accessibility Patterns (SMI-2541)${RESET}`)

const docsDir = 'packages/website/src/pages/docs'
if (existsSync(docsDir)) {
  const docsAstroFiles = getFilesRecursive(docsDir, ['.astro'])
  const calloutH4Files = []

  for (const file of docsAstroFiles) {
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n')
    let inCallout = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes('class="callout')) inCallout = true
      if (inCallout && line.includes('</div>')) inCallout = false
      if (inCallout && /<h4>/.test(line)) {
        calloutH4Files.push({ file: relative('.', file), line: i + 1 })
      }
    }
  }

  if (calloutH4Files.length === 0) {
    pass('No callout divs use <h4> (use <p class="callout-heading"> instead)')
  } else {
    fail(
      `${calloutH4Files.length} callout(s) use <h4> instead of <p class="callout-heading">`,
      'Change <h4> to <p class="callout-heading"> inside .callout divs (heading-order violation)'
    )
    calloutH4Files.slice(0, 5).forEach(({ file, line }) => console.log(`    ${file}:${line}`))
  }
} else {
  warn('Docs pages directory not found - skipping callout heading check')
}

// Check BlogLayout has aria-hidden on task-list checkboxes
const blogLayoutPath = 'packages/website/src/layouts/BlogLayout.astro'
if (existsSync(blogLayoutPath)) {
  const blogLayoutContent = readFileSync(blogLayoutPath, 'utf8')
  if (blogLayoutContent.includes('aria-hidden') && blogLayoutContent.includes('task-list-item')) {
    pass('BlogLayout hides task-list checkboxes from accessibility tree')
  } else {
    fail(
      'BlogLayout missing aria-hidden on task-list checkboxes',
      'Add aria-hidden="true" and tabindex="-1" to .task-list-item checkboxes via JS'
    )
  }
} else {
  warn('BlogLayout.astro not found - skipping task-list checkbox check')
}

// Check standalone pages have <main> landmark
const standalonePages = ['packages/website/src/pages/index.astro']
for (const pagePath of standalonePages) {
  if (existsSync(pagePath)) {
    const pageContent = readFileSync(pagePath, 'utf8')
    if (pageContent.includes('<main')) {
      pass(`${relative('.', pagePath)} has <main> landmark`)
    } else {
      fail(
        `${relative('.', pagePath)} missing <main> landmark`,
        'Add <main id="main-content"> to standalone pages not using BaseLayout'
      )
    }
  }
}

// 15. Licensing Language — ELv2 is not "open source" (SMI-2556)
console.log(`\n${BOLD}15. Licensing Language (SMI-2556)${RESET}`)

const LICENSING_SCAN_DIRS = [
  'docs/internal/execution',
  'packages/website/src/content/blog',
  'packages/website/src/pages',
]
const LICENSING_EXTENSIONS = ['.md', '.mdx', '.astro']
// Patterns that are allowlisted (referring to other projects, or clarification context)
const LICENSING_ALLOWLIST = [
  /not\s+OSI[- ]approved\s+open\s+source/i,
  /not\s+open\s+source/i,
  /rather\s+than\s+.open\s+source/i,
  /Is\s+Skillsmith\s+open\s+source/i,
  /freeCodeCamp/i,
  /The\s+Changelog/i,
  /open\s+source\s+projects?\s+focus/i,
  /open\s+source\s+alternative/i,
  /OpenSourceAlternative/i,
  /OpenAlternative/i,
  /must\s+be\s+OSS/i,
  /source.available.*open\s+source/i,
]

{
  const licensingViolations = []

  for (const dir of LICENSING_SCAN_DIRS) {
    if (!existsSync(dir)) continue
    const files = getFilesRecursive(dir, LICENSING_EXTENSIONS)

    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      let inCodeBlock = false

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim().startsWith('```')) inCodeBlock = !inCodeBlock
        if (inCodeBlock) continue

        if (/open\s+source/i.test(line)) {
          // Check if this line matches any allowlist pattern
          const isAllowed = LICENSING_ALLOWLIST.some((pattern) => pattern.test(line))
          if (!isAllowed) {
            licensingViolations.push({
              file: relative('.', file),
              line: i + 1,
              text: line.trim().substring(0, 80),
            })
          }
        }
      }
    }
  }

  if (licensingViolations.length === 0) {
    pass('No "open source" claims about Skillsmith (Elastic License 2.0 is source-available)')
  } else {
    fail(
      `${licensingViolations.length} instance(s) of "open source" in marketing-facing docs`,
      'Use "source-available" or "Elastic License 2.0" instead of "open source"'
    )
    licensingViolations.slice(0, 5).forEach(({ file, line, text }) => {
      console.log(`    ${file}:${line} — ${text}`)
    })
    if (licensingViolations.length > 5) {
      console.log(`    ... and ${licensingViolations.length - 5} more`)
    }
  }
}

// 16. URL Normalization — bare skillsmith.app without www (SMI-2553)
console.log(`\n${BOLD}16. URL Normalization (SMI-2553)${RESET}`)

// Only scan marketing-facing dirs (not internal ADRs, architecture, analysis docs)
const URL_SCAN_DIRS = ['docs/internal/execution', 'packages/website/src']
const URL_SCAN_EXTENSIONS = ['.md', '.mdx', '.astro', '.ts', '.tsx']
// Patterns that are allowlisted (GitHub URLs, email addresses, subdomains, etc.)
const URL_ALLOWLIST = [
  /github\.com.*skillsmith/i,
  /npm.*skillsmith/i,
  /@skillsmith\//,
  /security@skillsmith\.app/,
  /support@skillsmith\.app/,
  /staging\.skillsmith\.app/,
  /api\.skillsmith\.app/,
  /skillsmith\.app redirects to www/i, // Redirect-description context (non-www is intentional)
]

{
  const urlViolations = []

  for (const dir of URL_SCAN_DIRS) {
    if (!existsSync(dir)) continue
    const files = getFilesRecursive(dir, URL_SCAN_EXTENSIONS)

    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      let inCodeBlock = false

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim().startsWith('```')) inCodeBlock = !inCodeBlock
        if (inCodeBlock) continue

        // Match skillsmith.app NOT preceded by www.
        // Use a simple approach: find all skillsmith.app instances, check context
        const matches = [...line.matchAll(/(?<!www\.)skillsmith\.app/g)]
        for (const match of matches) {
          const lineContext = line.substring(Math.max(0, match.index - 20), match.index + 30)
          // Check allowlist
          const isAllowed = URL_ALLOWLIST.some((pattern) => pattern.test(line))
          if (!isAllowed) {
            urlViolations.push({
              file: relative('.', file),
              line: i + 1,
              text: lineContext.trim(),
            })
          }
        }
      }
    }
  }

  if (urlViolations.length === 0) {
    pass('All skillsmith.app URLs use www. prefix')
  } else {
    // Warn (not fail) to allow gradual cleanup of pre-existing violations in internal docs
    // Graduate to fail() once docs/execution/ URLs are normalized
    warn(
      `${urlViolations.length} bare skillsmith.app URL(s) missing www. prefix`,
      'Use www.skillsmith.app instead of skillsmith.app'
    )
    urlViolations.slice(0, 5).forEach(({ file, line, text }) => {
      console.log(`    ${file}:${line} — ...${text}...`)
    })
    if (urlViolations.length > 5) {
      console.log(`    ... and ${urlViolations.length - 5} more`)
    }
  }
}

// 17. Email Consistency — internal recipients must use smithhorn.ca (SMI-2562)
console.log(`\n${BOLD}17. Email Consistency (SMI-2562)${RESET}`)

{
  const emailViolations = []

  // Check 1: Workflow files must not hardcode @skillsmith.app for internal recipients
  // (Resend self-send loop: noreply@skillsmith.app → support@skillsmith.app triggers inbound webhook)
  const workflowDir = '.github/workflows'
  if (existsSync(workflowDir)) {
    const workflowFiles = readdirSync(workflowDir).filter((f) => f.endsWith('.yml'))

    for (const file of workflowFiles) {
      const content = readFileSync(join(workflowDir, file), 'utf8')
      const lines = content.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip comments
        if (line.trim().startsWith('#')) continue
        // Flag hardcoded skillsmith.app recipient emails in workflow dispatch/env
        if (/['"]?support@skillsmith\.app['"]?/.test(line)) {
          emailViolations.push({
            file: join(workflowDir, file),
            line: i + 1,
            issue: 'Hardcoded support@skillsmith.app in workflow (causes Resend self-send loop)',
            suggestion: 'Use support@smithhorn.ca for internal recipients',
          })
        }
      }
    }
  }

  // Check 2: Edge function internal recipients must use smithhorn.ca
  // Note: reply_to addresses using @skillsmith.app are intentionally exempt —
  // those are public-facing reply addresses, not internal recipients that trigger
  // Resend's self-send loop. Only `to:` and `RECIPIENTS` patterns are checked.
  const edgeFnRecipientFiles = [
    'supabase/functions/ops-report/index.ts',
    'supabase/functions/alert-notify/index.ts',
    'supabase/functions/contact-submit/index.ts',
    'supabase/functions/email-inbound/index.ts',
  ]

  for (const file of edgeFnRecipientFiles) {
    if (!existsSync(file)) continue
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip comments and JSDoc lines (JSDoc may reference both addresses for documentation)
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
      // Match to: ['support@skillsmith.app'] or recipients array with skillsmith.app
      if (
        /to:\s*\[.*support@skillsmith\.app/.test(line) ||
        /RECIPIENTS.*support@skillsmith\.app/.test(line)
      ) {
        emailViolations.push({
          file,
          line: i + 1,
          issue: 'Internal recipient uses support@skillsmith.app instead of support@smithhorn.ca',
          suggestion: 'Change to support@smithhorn.ca to avoid Resend self-send loop',
        })
      }
    }
  }

  // Check 3: CLAUDE.md alert documentation must match actual workflow recipient
  if (existsSync('CLAUDE.md') && existsSync(join(workflowDir, 'ops-report.yml'))) {
    const claudeMd = readFileSync('CLAUDE.md', 'utf8')
    // Check if CLAUDE.md still references skillsmith.app for alerts
    if (/Alerts to [`']support@skillsmith\.app[`']/.test(claudeMd)) {
      emailViolations.push({
        file: 'CLAUDE.md',
        line: 0,
        issue: 'Documentation says support@skillsmith.app but ops-report uses support@smithhorn.ca',
        suggestion: 'Update CLAUDE.md alert recipient to support@smithhorn.ca',
      })
    }
  }

  if (emailViolations.length === 0) {
    pass('Email consistency verified (internal recipients use smithhorn.ca)')
  } else {
    fail(
      `${emailViolations.length} email consistency issue(s) found`,
      'Internal recipients must use support@smithhorn.ca to avoid Resend self-send loop'
    )
    emailViolations.forEach(({ file, line, issue, suggestion }) => {
      const lineStr = line ? `:${line}` : ''
      console.log(`    ${file}${lineStr} — ${issue}`)
      if (suggestion) console.log(`      ${YELLOW}→${RESET} ${suggestion}`)
    })
  }
}

// 18. No Double-Encrypted Files (SMI-2607)
console.log(`\n${BOLD}18. No Double-Encrypted Files (SMI-2607)${RESET}`)
try {
  const status = execSync('git-crypt status 2>/dev/null', { encoding: 'utf8' })
  if (status.includes('locked')) {
    pass('Skipped (git-crypt locked)')
  } else {
    const encryptedFiles = status
      .split('\n')
      .filter((line) => line.includes('encrypted:') && !line.includes('NOT ENCRYPTED'))
      .map((line) => line.trim().split(/\s+/).pop())
      .filter(Boolean)

    const binaryExtensions = [
      '.svg',
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.ico',
      '.woff',
      '.woff2',
      '.db',
      '.wasm',
    ]
    const doubleEncrypted = []

    for (const file of encryptedFiles) {
      const ext = extname(file).toLowerCase()
      if (binaryExtensions.includes(ext)) continue
      try {
        const fileType = execSync(`file -b "${file}"`, { encoding: 'utf8' }).trim()
        if (fileType === 'data') {
          doubleEncrypted.push(file)
        }
      } catch {
        /* File might not exist on disk */
      }
    }

    if (doubleEncrypted.length > 0) {
      fail(`${doubleEncrypted.length} double-encrypted files found:\n${doubleEncrypted.join('\n')}`)
    } else {
      pass('No double-encrypted files')
    }
  }
} catch {
  pass('Skipped (git-crypt not installed)')
}

// 19. docs/ Directory Structure Guard (SMI-2607)
console.log(`\n${BOLD}19. docs/ Directory Structure Guard (SMI-2607)${RESET}`)
const allowedDocsDirs = ['internal']
const actualDocsDirs = readdirSync('docs', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
const unexpectedDirs = actualDocsDirs.filter((d) => !allowedDocsDirs.includes(d))
if (unexpectedDirs.length > 0) {
  fail(`Unexpected docs/ subdirectories (should be in submodule): ${unexpectedDirs.join(', ')}`)
} else {
  pass('docs/ contains only allowed subdirectories')
}

// 20. Stale Doc Path References in Skills (SMI-2637)
console.log(`\n${BOLD}20. Stale Doc Path References in Skills (SMI-2637)${RESET}`)

{
  const skillsDir = '.claude/skills'
  if (existsSync(skillsDir)) {
    const skillMdFiles = getFilesRecursive(skillsDir, ['.md'])
    const staleRefs = []

    // Match docs/ paths in markdown links and plain text references
    // Captures: docs/architecture/..., docs/adr/..., docs/process/..., docs/execution/...
    // These old paths should now be docs/internal/...
    const docPathRegex =
      /(?:docs\/(?:architecture|adr|process|execution|retros|code_review)\/[^\s)'"]+)/g

    for (const file of skillMdFiles) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip YAML frontmatter
        if (line.trim().startsWith('#') && line.includes('comment')) continue
        const matches = line.match(docPathRegex)
        if (matches) {
          for (const match of matches) {
            staleRefs.push({
              file: relative(process.cwd(), file),
              line: i + 1,
              path: match,
            })
          }
        }
      }
    }

    // Also check for docs/ references that point to non-existent files
    const docsRefRegex = /(?:\(|]\()([^)]*docs\/[^)]+)\)/g
    const brokenRefs = []

    for (const file of skillMdFiles) {
      const content = readFileSync(file, 'utf8')
      let match
      while ((match = docsRefRegex.exec(content)) !== null) {
        const refPath = match[1]
          .replace(/^\.\.\//, '')
          .replace(/^\.\.\//, '')
          .replace(/^\.\.\//, '')
        // Resolve relative to project root
        if (refPath.startsWith('docs/') && !existsSync(refPath)) {
          brokenRefs.push({
            file: relative(process.cwd(), file),
            path: refPath,
          })
        }
      }
    }

    if (staleRefs.length === 0 && brokenRefs.length === 0) {
      pass('No stale or broken doc path references in project skills')
    } else {
      if (staleRefs.length > 0) {
        fail(
          `${staleRefs.length} stale doc path(s) in skills (should be docs/internal/...)`,
          'Update paths from docs/<old>/ to docs/internal/<new>/'
        )
        staleRefs.slice(0, 5).forEach(({ file, line, path }) => {
          console.log(`    ${file}:${line} — ${path}`)
        })
      }
      if (brokenRefs.length > 0) {
        warn(
          `${brokenRefs.length} broken doc link(s) in skills (file does not exist)`,
          'Update or remove broken links'
        )
        brokenRefs.slice(0, 5).forEach(({ file, path }) => {
          console.log(`    ${file} → ${path}`)
        })
      }
    }
  } else {
    warn('.claude/skills/ directory not found - skipping stale doc path check')
  }
}

// npm override exact-pin check (SMI-3099 lesson, SMI-3987 refinement)
// Flags scoped overrides that target exact-pinned dependencies AND failed to
// take effect via npm's dedup machinery. CLAUDE.md's `npm overrides` note:
// "`npm update <pkg>` may resolve it via dedup if another chain pulls in the
// patched version. Verify with `npm ls <dep>` after update."
//
// The original Check 11 (pre-SMI-3987) flagged any override targeting an
// exact-pinned dep, even when dedup actually applied the override. This
// caused a 6-warning false positive on SMI-3984's merge. The fix:
// cross-reference `npm ls <dep>` and only warn when the resolved version(s)
// disagree with the override constraint.
{
  const pkgPath = 'package.json'
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const overrides = pkg.overrides || {}
    const exactPinIssues = []

    // Walk `npm ls <dep> --all --json` and return every resolved version of
    // <dep> in the dependency tree. Scope-loose: trust npm's dedup machinery
    // (per Open Q2 resolution).
    //
    // Critical: `npm ls` exits non-zero whenever the tree has ANY problems
    // (invalid pins, peer conflicts, override inversions). The current `main`
    // post-SMI-3984 tree is in exactly that state, so every call throws.
    // **The JSON tree is still written to err.stdout** — we read it and
    // parse it. Returning [] on every catch would fall through to the
    // pessimistic warning path and break acceptance criterion #1
    // (SMI-3987 plan-review E1 blocker).
    const parseNpmLsTree = (raw) => {
      if (!raw) return null
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }
    const getResolvedVersions = (dep) => {
      let raw = ''
      try {
        raw = execSync(`npm ls ${dep} --all --json`, {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch (err) {
        // npm ls exits non-zero on ANY tree problem — stdout still contains
        // valid JSON. Read it. If err.stdout is missing or not parseable,
        // fall through to raw='' below → returns [] → pessimistic warning.
        raw = (err && err.stdout && err.stdout.toString('utf-8')) || ''
      }
      const tree = parseNpmLsTree(raw)
      if (!tree) return [] // unparseable → pessimistic warning (safe default)
      // Walk the tree and collect versions of nodes whose KEY (under
      // .dependencies) matches the queried dep name. The walk must check
      // the key, not just the version field — `npm ls <dep>` returns the
      // FULL chain leading to <dep>, so intermediate nodes are versions of
      // OTHER packages and would otherwise pollute the result set.
      const versions = new Set()
      const walk = (node) => {
        if (!node || typeof node !== 'object' || !node.dependencies) return
        for (const [childName, child] of Object.entries(node.dependencies)) {
          if (childName === dep && child && typeof child.version === 'string') {
            versions.add(child.version)
          }
          walk(child)
        }
      }
      walk(tree)
      return [...versions].filter((v) => /^\d+\.\d+\.\d+/.test(v))
    }

    for (const [parent, value] of Object.entries(overrides)) {
      if (typeof value !== 'object') continue // global overrides, skip
      for (const [dep, overrideSpec] of Object.entries(value)) {
        if (dep === '.') continue // parent-version override, not a dep override
        // Check the actual installed parent's declared dependency specifier
        const parentPkgPath = join('node_modules', parent, 'package.json')
        if (!existsSync(parentPkgPath)) continue
        const parentPkg = JSON.parse(readFileSync(parentPkgPath, 'utf8'))
        const depSpec = parentPkg.dependencies?.[dep] || parentPkg.devDependencies?.[dep]
        if (!depSpec) continue
        if (depSpec.startsWith('^') || depSpec.startsWith('~') || depSpec.startsWith('>')) {
          continue // parent uses a range, override always works
        }

        // Parent exact-pins the dep. Check whether dedup rescued the override.
        if (typeof overrideSpec !== 'string') continue // nested object override
        const resolved = getResolvedVersions(dep)
        if (resolved.length === 0) {
          // Couldn't inspect the tree → pessimistic warning (preserves
          // pre-SMI-3987 safe default).
          exactPinIssues.push({ parent, dep, spec: depSpec, resolved: null })
          continue
        }
        // Scope-loose per plan-review Open Q2: if ANY resolved version of
        // the dep satisfies the override, npm's dedup machinery has applied
        // the override at least somewhere in the tree. Tree-wide unrelated
        // copies (e.g. @vercel/static-config wants ajv@8.6.3 but eslint-7.x
        // also brings in ajv@6.14.0) do not invalidate the override —
        // residual CVEs would be caught by `Security Audit` / `npm audit`,
        // which is the authoritative check for vulnerability presence.
        const someEffective = resolved.some((v) => satisfies(v, overrideSpec))
        if (!someEffective) {
          exactPinIssues.push({ parent, dep, spec: depSpec, resolved })
        }
        // else: override is effective via dedup — silent pass (SMI-3987 fix)
      }
    }

    if (exactPinIssues.length > 0) {
      warn(
        `${exactPinIssues.length} npm override(s) target exact-pinned dependencies (override may not take effect)`,
        'Verify with `npm ls <dep>` and `npm audit`. Remove truly ineffective overrides and dismiss with documented rationale.'
      )
      exactPinIssues.forEach(({ parent, dep, spec, resolved }) => {
        const detail = resolved ? `resolved: ${resolved.join(', ')}` : 'could not inspect tree'
        console.log(`    ${parent} → ${dep}: "${spec}" (${detail})`)
      })
    } else {
      pass('npm overrides: no exact-pin conflicts detected')
    }
  }
}

// 21. Workflow continue-on-error Anti-Pattern (SMI-3217)
console.log(`\n${BOLD}21. Workflow continue-on-error Validation (SMI-3217)${RESET}`)
{
  const workflowDir = '.github/workflows'
  if (existsSync(workflowDir)) {
    const workflowFiles = readdirSync(workflowDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => join(workflowDir, f))

    const violations = []

    for (const file of workflowFiles) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      const relPath = relative(process.cwd(), file)

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.match(/^\s+continue-on-error:\s*true/)) continue

        // Check for inline exemption comment
        if (line.includes('# audit:allow-continue-on-error')) continue

        // Check preceding lines for exemption comment (up to 3 lines back)
        const hasPrecedingExemption = lines
          .slice(Math.max(0, i - 3), i)
          .some((l) => l.includes('# audit:allow-continue-on-error'))
        if (hasPrecedingExemption) continue

        // Check if the step's run block contains || true (intent is clear)
        const stepLines = []
        for (let j = i - 1; j >= 0; j--) {
          stepLines.unshift(lines[j])
          if (lines[j].match(/^\s+- name:/) || lines[j].match(/^\s+- uses:/)) break
        }
        const stepBlock = stepLines.join('\n')
        if (stepBlock.includes('|| true')) continue

        // Find the step's id (scan backward from continue-on-error line)
        let stepId = null
        for (let j = i - 1; j >= 0; j--) {
          const idMatch = lines[j].match(/^\s+id:\s*(\S+)/)
          if (idMatch) {
            stepId = idMatch[1]
            break
          }
          // Stop if we hit another step boundary
          if (lines[j].match(/^\s+- name:/) || lines[j].match(/^\s+- uses:/)) break
        }
        // Also check lines after continue-on-error for id (id can come after)
        if (!stepId) {
          for (let j = i + 1; j < lines.length; j++) {
            const idMatch = lines[j].match(/^\s+id:\s*(\S+)/)
            if (idMatch) {
              stepId = idMatch[1]
              break
            }
            // Stop if we hit next step or non-indented content
            if (lines[j].match(/^\s+- name:/) || lines[j].match(/^\s+- uses:/)) break
            if (lines[j].match(/^\s+continue-on-error:/)) break
          }
        }

        if (!stepId) {
          // No id at all — violation
          const nameMatch = stepBlock.match(/- name:\s*(.+)/)
          const stepName = nameMatch ? nameMatch[1].trim() : `line ${i + 1}`
          violations.push({ file: relPath, line: i + 1, step: stepName, reason: 'no id field' })
          continue
        }

        // Check if stepId is referenced in a downstream if: condition
        const downstream =
          content.includes(`steps.${stepId}.outcome`) ||
          content.includes(`steps.${stepId}.outputs`) ||
          content.includes(`steps.${stepId}.conclusion`)
        if (!downstream) {
          violations.push({
            file: relPath,
            line: i + 1,
            step: stepId,
            reason: 'id not referenced in downstream if: condition',
          })
        }
      }
    }

    if (violations.length > 0) {
      fail(
        `${violations.length} continue-on-error step(s) without downstream outcome check`,
        'Add id: + downstream if: condition, or add # audit:allow-continue-on-error'
      )
      violations.slice(0, 10).forEach(({ file, line, step, reason }) => {
        console.log(`    ${file}:${line} — ${step} (${reason})`)
      })
    } else {
      pass('All continue-on-error steps have proper downstream outcome checks')
    }
  } else {
    pass('Skipped (no .github/workflows/ directory)')
  }
}

// 22. Workflow Inline require() Path Validation (SMI-3336)
console.log(`\n${BOLD}22. Workflow Inline require() Paths (SMI-3336)${RESET}`)
{
  const workflowDir = '.github/workflows'
  if (existsSync(workflowDir)) {
    const workflowFiles = readdirSync(workflowDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => join(workflowDir, f))

    // Skip if no build output exists (e.g., Standards Compliance job runs without building)
    const hasDistOutput = existsSync('packages/core/dist')
    if (!hasDistOutput) {
      pass('Skipped (no dist/ output — run after build to validate)')
    } else {
      const missing = []
      const requirePattern = /require\(['"](\.\/.+?)['"]\)/g

      for (const file of workflowFiles) {
        const content = readFileSync(file, 'utf8')
        const relPath = relative(process.cwd(), file)
        let match

        while ((match = requirePattern.exec(content)) !== null) {
          const reqPath = match[1]
          // Skip template literals and dynamic paths
          if (reqPath.includes('${') || reqPath.includes('`')) continue
          // Only validate dist/ paths (build artifacts at risk of breaking)
          if (!reqPath.includes('/dist/')) continue

          // Resolve .js path
          const resolved = reqPath.endsWith('.js') ? reqPath : `${reqPath}.js`
          if (!existsSync(resolved)) {
            const line = content.substring(0, match.index).split('\n').length
            missing.push({ file: relPath, line, path: reqPath })
          }
        }
      }

      if (missing.length > 0) {
        fail(
          `${missing.length} broken require() path(s) in workflow files`,
          'Update paths to match current build output (e.g., dist/src/ for Turborepo)'
        )
        missing.forEach(({ file, line, path }) => {
          console.log(`    ${file}:${line} — ${path}`)
        })
      } else {
        pass('All workflow inline require() paths resolve correctly')
      }
    } // end hasDistOutput
  } else {
    pass('Skipped (no .github/workflows/ directory)')
  }
}

// 23. Implementation Completeness Spot Check (SMI-3543, SMI-3987, SMI-3986)
//
// SMI-3987 fix: only count SMI-NNNN refs as completion claims when they
// appear in the commit subject line OR after a closing keyword in the body
// (closes:/fixes:/resolves:). Cite-in-body references (e.g.,
// "per SMI-3099 limitation doc") no longer count as "done without source".
// Logic delegated to extractCompletionIssues() in audit-standards-helpers.mjs.
//
// SMI-3986 fix: resolve `.git` via `git rev-parse --git-common-dir` so the
// shallow-clone guard works inside git worktrees (where `.git` is a file
// containing `gitdir: <main>/.git/worktrees/<name>`, not a directory).
// Also: downgrade git-failure from `warn(... fatal: ...)` to a clean
// `pass('Skipped — ...')`. Matches Check 22's skip-as-pass pattern. Noise
// suppression by design — see commit message for rationale.
console.log(`\n${BOLD}23. Implementation Completeness Spot Check (SMI-3543)${RESET}`)
{
  const DONE_PATTERNS = [
    /\bfix(es|ed)?\b/i,
    /\bclos(e|es|ed)\b/i,
    /\bcomplet(e|es|ed)\b/i,
    /\bdone\b/i,
    /\bfinish(es|ed)?\b/i,
    /\bresolv(e|es|ed)\b/i,
  ]
  const SRC_PATTERNS = [
    /^packages\/.*\.(ts|tsx|js|jsx|astro)$/,
    /^supabase\/functions\/.*\.(ts|js)$/,
    /^scripts\/.*\.(ts|js|mjs)$/,
  ]
  const SRC_EXCLUDED = [/\.test\.(ts|tsx|js)$/, /\.spec\.(ts|tsx|js)$/, /\.md$/]

  // Non-source conventional commit prefixes (docs, chore, ci, test, refactor, style),
  // OR any conventional commit type with `(deps)` scope (e.g. `fix(deps):`,
  // `chore(deps):`). Deps-only commits legitimately modify package.json /
  // package-lock.json without touching source files, so requiring source
  // changes for them is a structural false-positive class. (SMI-3987 fix
  // surfaced this when commit 8ec28dfa with subject-line SMI ref + deps-only
  // files was still flagged after the cite-in-body filter was added.)
  const NON_SOURCE_PREFIXES = /^((docs|chore|ci|test|refactor|style)(\(.+\))?|[a-z]+\(deps\))!?:/i

  // SMI-3986: worktree-aware git directory resolution. In a worktree, `.git`
  // is a file (`gitdir: <main>/.git/worktrees/<name>`), not a directory —
  // the previous `existsSync('.git/shallow')` silently misfired.
  let gitCommonDir = null
  try {
    gitCommonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // Not a git checkout, GIT_DIR misaligned, or hook context.
    pass('Skipped — could not resolve git directory (not a checkout or hook context)')
  }

  if (gitCommonDir !== null) {
    if (existsSync(join(gitCommonDir, 'shallow'))) {
      // Shallow clone — limited git history (CI Docker builds, etc.)
      pass('Skipped — shallow clone detected (limited git history)')
    } else {
      try {
        const log = execSync('git log -10 --format=%H%n%B --no-merges', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })

        // Parse commit blocks: each block starts with a 40-char SHA
        const blocks = log.split(/(?=^[0-9a-f]{40}$)/m).filter((b) => b.trim())
        let suspicious = 0
        const suspiciousDetails = []

        for (const block of blocks) {
          const lines = block.trim().split('\n')
          const sha = lines[0]
          const subject = lines[1] || ''
          const body = lines.slice(2).join('\n')
          const fullMsg = `${subject}\n${body}`

          // SMI-3987: only count subject SMIs and closes-marker body SMIs
          const completionIssues = extractCompletionIssues(subject, body)
          if (completionIssues.size === 0) continue

          const hasDone = DONE_PATTERNS.some((p) => p.test(fullMsg))
          if (!hasDone) continue

          const isNonSourcePrefix = NON_SOURCE_PREFIXES.test(subject)
          if (isNonSourcePrefix) continue

          // Get changed files for this commit
          try {
            const files = execSync(`git diff-tree --no-commit-id --name-only -r ${sha}`, {
              encoding: 'utf-8',
              timeout: 2000,
              stdio: ['ignore', 'pipe', 'ignore'],
            })
              .trim()
              .split('\n')
              .filter((f) => f)

            const hasSource = files.some((f) => {
              const isSource = SRC_PATTERNS.some((p) => p.test(f))
              const isExcluded = SRC_EXCLUDED.some((p) => p.test(f))
              return isSource && !isExcluded
            })

            if (!hasSource) {
              suspicious++
              suspiciousDetails.push({
                sha: sha.substring(0, 8),
                issues: [...completionIssues],
              })
            }
          } catch {
            // Skip commits that can't be inspected (orphaned, missing tree, etc.)
          }
        }

        if (suspicious === 0) {
          pass('Last 10 commits: all SMI-referencing "done" commits include source changes')
        } else {
          warn(
            `${suspicious} commit(s) mark issues done without source changes`,
            'Run npm run audit:drift for a comprehensive check'
          )
          for (const d of suspiciousDetails.slice(0, 3)) {
            console.log(`    ${d.sha}: ${d.issues.join(', ')}`)
          }
        }
      } catch {
        // SMI-3986: downgrade from warn-with-fatal-string to clean skip-as-pass.
        // Matches Check 22's pattern for missing infrastructure. Noise
        // suppression by design — a genuinely corrupt git state will fail
        // many other checks (pre-push hooks, git log in calling tools, etc.).
        pass('Skipped — could not inspect git history (hook context or detached state)')
      }
    }
  }
}

// ── Check: Duplicate Shared Constants (SMI-3590) ───────────────────────
// Detects exported SCREAMING_SNAKE_CASE record constants defined in multiple
// _shared/ files. Each constant should have exactly one canonical definition;
// other files should import it.
{
  const sharedDir = 'supabase/functions/_shared'
  // Match: export const SOME_THING: Record<...> = { or export const SOME_THING = {
  const exportedConstPattern =
    /export\s+const\s+([A-Z][A-Z0-9_]{3,})\s*(?::\s*Record[^=]*)?\s*=\s*\{/g

  // Collect: which constants are defined in which files
  const constantSources = new Map() // constantName → [filePath, ...]

  if (existsSync(sharedDir)) {
    const sharedFiles = readdirSync(sharedDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
    )

    for (const file of sharedFiles) {
      const filePath = `${sharedDir}/${file}`
      const content = readFileSync(filePath, 'utf-8')
      let match
      exportedConstPattern.lastIndex = 0
      while ((match = exportedConstPattern.exec(content)) !== null) {
        const name = match[1]
        if (!constantSources.has(name)) constantSources.set(name, [])
        constantSources.get(name).push(filePath)
      }
    }
  }

  // Flag any constant defined in more than one file
  const duplicates = [...constantSources.entries()].filter(([, files]) => files.length > 1)

  if (duplicates.length === 0) {
    pass('Shared constants: no duplicate definitions across _shared/ modules')
  } else {
    warn(
      `${duplicates.length} constant(s) defined in multiple _shared/ files — each should have one source of truth`,
      'Consolidate to one file and import from there'
    )
    for (const [name, files] of duplicates.slice(0, 3)) {
      console.log(`    ${name}: ${files.join(', ')}`)
    }
  }
}

// 24. CHANGELOG Currency (SMI-3885)
console.log(`\n${BOLD}24. CHANGELOG Currency (SMI-3885)${RESET}`)
{
  const pkgDirs = existsSync('packages')
    ? readdirSync('packages').filter((d) => existsSync(join('packages', d, 'package.json')))
    : []

  // Check root + each package
  const targets = [
    { pkgPath: 'package.json', changelogPath: 'CHANGELOG.md', label: 'root' },
    ...pkgDirs.map((d) => ({
      pkgPath: join('packages', d, 'package.json'),
      changelogPath: join('packages', d, 'CHANGELOG.md'),
      label: `packages/${d}`,
    })),
  ]

  let changelogIssues = 0
  for (const { pkgPath, changelogPath, label } of targets) {
    if (!existsSync(changelogPath)) continue // Skip packages without CHANGELOG

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const pkgVersion = pkg.version
      if (!pkgVersion) continue

      const changelog = readFileSync(changelogPath, 'utf8')

      // Check for [Unreleased] section with content (exemption)
      const unreleasedMatch = changelog.match(/## \[?Unreleased\]?\s*\n([\s\S]*?)(?=\n## |\n*$)/)
      if (unreleasedMatch && unreleasedMatch[1].trim().length > 0) continue

      // Extract first version heading: ## [X.Y.Z] or ## vX.Y.Z or ## X.Y.Z
      const versionMatch = changelog.match(/## \[?v?(\d+\.\d+\.\d+)\]?/)
      if (!versionMatch) continue

      const changelogVersion = versionMatch[1]
      if (changelogVersion !== pkgVersion) {
        changelogIssues++
        warn(
          `${label}: CHANGELOG version ${changelogVersion} is behind package.json ${pkgVersion}`,
          `Update ${changelogPath} with an entry for v${pkgVersion}`
        )
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (changelogIssues === 0) {
    pass('All CHANGELOGs are current with their package.json versions')
  }
}

// 25. MCP Tool Count (SMI-3886)
console.log(`\n${BOLD}25. MCP Tool Count (SMI-3886)${RESET}`)
{
  const mcpIndexPath = 'packages/mcp-server/src/index.ts'
  const mcpReadmePath = 'packages/mcp-server/README.md'

  if (!existsSync(mcpIndexPath) || !existsSync(mcpReadmePath)) {
    warn('MCP tool count check skipped — required files not found')
  } else {
    try {
      const indexContent = readFileSync(mcpIndexPath, 'utf8')
      // Extract toolDefinitions array and count entries (lines with Schema or Tool suffix)
      const defMatch = indexContent.match(/const toolDefinitions\s*=\s*\[([\s\S]*?)\]/)
      const toolCount = defMatch
        ? defMatch[1].split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length
        : 0

      const readme = readFileSync(mcpReadmePath, 'utf8')
      // Extract "Available Tools" section up to next heading, then count tool rows
      const toolsSection = readme.match(
        /## Available Tools\s*\n[\s\S]*?\n\|[- |]+\n([\s\S]*?)(?=\n## |\n*$)/
      )
      const readmeCount = toolsSection
        ? toolsSection[1].split('\n').filter((l) => /^\|\s*`[a-z_]+`\s*\|/.test(l)).length
        : 0

      if (toolCount === readmeCount) {
        pass(`MCP tool count matches: ${toolCount} tools in code and README`)
      } else {
        warn(
          `MCP tool count mismatch: ${toolCount} in toolDefinitions vs ${readmeCount} in README`,
          `Update ${mcpReadmePath} tools table to match registered tools`
        )
      }
    } catch (e) {
      warn('Could not check MCP tool count: ' + e.message)
    }
  }
}

// 26. SMI-4188: publish.yml PUBLISHABLE_PACKAGES_JSON parity with pre-publish-check
// The env-level JSON list must match the packages enumerated inline in the
// pre-publish-check job's bash script. Drift = silent breakage (a newly added
// 5th publishable would be built in Validate but never gated by pre-publish-check).
console.log(`\n${BOLD}26. publish.yml PUBLISHABLE_PACKAGES_JSON parity (SMI-4188)${RESET}`)
try {
  const yml = readFileSync('.github/workflows/publish.yml', 'utf8')
  const jsonMatch = yml.match(/PUBLISHABLE_PACKAGES_JSON:\s*'(\[[^']+\])'/)
  if (!jsonMatch) {
    fail(
      'PUBLISHABLE_PACKAGES_JSON env var not found in .github/workflows/publish.yml',
      'Add workflow-level env var per docs/internal/implementation/publish-yml-scope.md'
    )
  } else {
    const declared = new Set(JSON.parse(jsonMatch[1]))

    // Extract pre-publish-check job block: from its name line to the next top-level job
    // (two-space-indented key ending in a colon).
    const preStart = yml.indexOf('pre-publish-check:')
    if (preStart === -1) {
      fail('pre-publish-check job not found in publish.yml')
    } else {
      const tail = yml.slice(preStart)
      const nextJob = tail.slice(1).search(/\n {2}[a-z][a-z0-9-]+:\n/)
      const block = nextJob === -1 ? tail : tail.slice(0, nextJob + 1)

      // The inline block enumerates each publishable by name in `npm view <pkg>` calls.
      const pkgMatches = block.match(/@(?:skillsmith|smith-horn)\/[a-z0-9-]+/g) || []
      const inlineUsed = new Set(pkgMatches)

      const missingFromInline = [...declared].filter((p) => !inlineUsed.has(p))
      const extraInInline = [...inlineUsed].filter((p) => !declared.has(p))

      if (missingFromInline.length || extraInInline.length) {
        fail(
          `PUBLISHABLE_PACKAGES_JSON vs pre-publish-check drift: ` +
            `missing_from_inline=[${missingFromInline.join(',')}] ` +
            `extra_in_inline=[${extraInInline.join(',')}]`,
          'Update one list to match the other. Both must enumerate the same set of publishable packages.'
        )
      } else {
        pass(
          `PUBLISHABLE_PACKAGES_JSON matches pre-publish-check enumeration (${declared.size} packages)`
        )
      }
    }
  }
} catch (e) {
  fail(`PUBLISHABLE_PACKAGES_JSON parity check error: ${e.message}`)
}

// 27. VS Code skillNameValidation codegen drift (SMI-4194)
console.log(`\n${BOLD}27. VS Code skillNameValidation Codegen Drift (SMI-4194)${RESET}`)
{
  const codegenScript = 'scripts/sync-skill-name-validation.mjs'
  if (!existsSync(codegenScript)) {
    warn('Codegen script not found — skipping drift check')
  } else {
    try {
      execSync(`node ${codegenScript} --check`, { stdio: 'pipe' })
      pass('skillNameValidation.ts is in sync with CLI source')
    } catch (e) {
      fail(
        'skillNameValidation.ts is out of sync with packages/cli/src/utils/skill-name.ts',
        'Run: node scripts/sync-skill-name-validation.mjs'
      )
    }
  }
}

// 28. VS Code command↔test pairing (SMI-4194)
// Every `skillsmith.*` command declared in packages/vscode-extension/package.json
// must have a matching test file under packages/vscode-extension/src/__tests__/.
// This prevents shipping a palette entry with no test coverage.
console.log(`\n${BOLD}28. VS Code Command ↔ Test Pairing (SMI-4194)${RESET}`)
{
  const extPkgPath = 'packages/vscode-extension/package.json'
  const testDir = 'packages/vscode-extension/src/__tests__'
  if (!existsSync(extPkgPath)) {
    warn('vscode-extension package.json not found — skipping pairing check')
  } else if (!existsSync(testDir)) {
    warn('vscode-extension __tests__ dir not found — skipping pairing check')
  } else {
    try {
      const pkg = JSON.parse(readFileSync(extPkgPath, 'utf8'))
      const commands = (pkg.contributes?.commands ?? [])
        .map((c) => c.command)
        .filter((c) => typeof c === 'string' && c.startsWith('skillsmith.'))
      // Known commands that intentionally have no dedicated test file.
      // Keep this list tight — each entry is a coverage exception.
      const exempt = new Set([
        'skillsmith.refreshSkills', // trivial delegation to provider.refresh()
        'skillsmith.viewSkillDetails', // panel creation tested in SkillDetailPanel.test.ts
        'skillsmith.mcpReconnect', // integration-tested via McpStatusBar
        'skillsmith.searchSkills', // exercised through SkillService tests
        'skillsmith.installSkill', // exercised through SkillService tests
      ])
      const testFiles = readdirSync(testDir).filter((f) => f.endsWith('.test.ts'))
      const missing = []
      for (const cmd of commands) {
        if (exempt.has(cmd)) continue
        const suffix = cmd.replace(/^skillsmith\./, '').toLowerCase()
        // Accept several filename conventions: verb (uninstallSkill → uninstallCommand.test.ts),
        // verb+Skill (createSkill → createSkillCommand.test.ts), or prefix match.
        const verbOnly = suffix.replace(/skill$/, '')
        const match = testFiles.some((f) => {
          const base = f.replace(/\.test\.ts$/, '').toLowerCase()
          // prefix match only at a word boundary (next char must be - or . or end of string)
          // e.g. "createskill" must not match "createskillservicemock"
          const nextChar = base.slice(suffix.length)[0]
          return (
            base === suffix ||
            base === `${suffix}command` ||
            base === `${verbOnly}command` ||
            (base.startsWith(suffix) &&
              (nextChar === undefined || nextChar === '-' || nextChar === '.'))
          )
        })
        if (!match) missing.push(cmd)
      }
      if (missing.length === 0) {
        pass(`All ${commands.length} vscode commands have matching test files`)
      } else {
        fail(
          `Missing test files for vscode commands: ${missing.join(', ')}`,
          'Add a <command>.test.ts under packages/vscode-extension/src/__tests__/, or add the command to the exempt list in scripts/audit-standards.mjs if coverage lives elsewhere.'
        )
      }
    } catch (e) {
      warn('Could not check vscode command↔test pairing: ' + e.message)
    }
  }
}

// 29. Smoke-test export drift (SMI-4193)
// Every name listed in a `required` array inside scripts/smoke-test-published.ts
// must be exported from @skillsmith/core's public entry point. Catches the
// SMI-4189 regression pattern: an export is removed from core but lingers in
// the smoke-test required list → workspace tests pass (resolved via source),
// published-package smoke fails (import missing).
console.log(`\n${BOLD}29. Smoke-test Export Drift (SMI-4193)${RESET}`)
{
  const smokePath = 'scripts/smoke-test-published.ts'
  const coreEntry = 'packages/core/src/index.ts'
  if (!existsSync(smokePath)) {
    warn(`${smokePath} not found — skipping smoke-test drift check`)
  } else if (!existsSync(coreEntry)) {
    warn(`${coreEntry} not found — skipping smoke-test drift check`)
  } else {
    try {
      const readFileIfExists = (absPath) =>
        existsSync(absPath) ? readFileSync(absPath, 'utf8') : null
      // Resolve the .js-in-source convention used across packages/core:
      //   export * from './exports/services.js' → services.ts in the same dir
      //   export * from './foo/index.js' → foo/index.ts
      const resolveModule = (fromFile, spec) => {
        if (!spec.startsWith('.')) return null
        const base = resolvePath(dirname(fromFile), spec.replace(/\.(m?js)$/, ''))
        for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
          if (existsSync(candidate)) return candidate
        }
        return null
      }
      const coreExports = collectTsEntryExports(
        resolvePath(coreEntry),
        readFileIfExists,
        resolveModule
      )
      const smokeContent = readFileSync(smokePath, 'utf8')
      const entries = extractSmokeTestRequiredArrays(smokeContent)
      if (entries.length === 0) {
        warn(
          `No \`required\` arrays found in ${smokePath} — check may be stale; verify the smoke-test structure`
        )
      } else {
        const missing = entries.filter((e) => !coreExports.has(e.name))
        if (missing.length === 0) {
          pass(
            `All ${entries.length} smoke-test required names resolve in @skillsmith/core (${coreExports.size} exports)`
          )
        } else {
          const formatted = missing
            .map((e) => `  - '${e.name}' (required array #${e.arrayIndex + 1})`)
            .join('\n')
          fail(
            `Smoke-test references ${missing.length} name(s) not exported from @skillsmith/core:\n${formatted}`,
            `Either restore the export in ${coreEntry} or remove the name from the matching \`required\` array in ${smokePath}. This check prevents the SMI-4189 republish regression.`
          )
        }
      }
    } catch (e) {
      warn(`Could not check smoke-test export drift: ${e.message}`)
    }
  }
}

// 30. VS Code integration tests must be excluded from host typecheck + root vitest.
// These files import `vscode` / use mocha `suite`/`test` globals and only run under
// @vscode/test-electron. If they leak into the host tsc/vitest runs they break pre-commit
// and pre-push hooks on main. Root cause of the SMI-4194 post-merge friction.
console.log(`\n${BOLD}30. VS Code Integration Tests Excluded from Host Runners${RESET}`)
{
  const intDir = 'packages/vscode-extension/src/__tests__/integration'
  if (!existsSync(intDir)) {
    pass('No vscode integration tests directory — nothing to check')
  } else {
    const tsconfigPath = 'packages/vscode-extension/tsconfig.json'
    const vitestConfigPath = 'vitest.config.root-tests.ts'
    const needle = 'src/__tests__/integration/**'
    const errors = []
    try {
      const tsconfig = readFileSync(tsconfigPath, 'utf8')
      if (!tsconfig.includes(needle)) {
        errors.push(`${tsconfigPath} exclude list missing '${needle}'`)
      }
    } catch {
      errors.push(`Could not read ${tsconfigPath}`)
    }
    try {
      const vitestConfig = readFileSync(vitestConfigPath, 'utf8')
      if (!vitestConfig.includes(needle)) {
        errors.push(`${vitestConfigPath} exclude list missing '${needle}'`)
      }
    } catch {
      errors.push(`Could not read ${vitestConfigPath}`)
    }
    if (errors.length === 0) {
      pass('vscode integration tests excluded from tsconfig + root vitest')
    } else {
      fail(
        errors.join('; '),
        "Add 'packages/vscode-extension/src/__tests__/integration/**' to both exclude lists — these tests require the vscode module (electron host) and mocha globals."
      )
    }
  }
}

// 31. SMI-4456 (R-1): user-visible CLI hints must reference real subcommands.
// Catches the SMI-4454 B3 pattern: `Try it: skillsmith skills list` shipped to
// users despite `skills` not being a registered subcommand. See retro
// docs/internal/retros/2026-04-24-smi-4454-post-merge-bug-trifecta.md.
console.log(`\n${BOLD}31. CLI Hint Command Existence (R-1, SMI-4456)${RESET}`)
{
  const cliIndexPath = 'packages/cli/src/index.ts'
  const cliCommandsDir = 'packages/cli/src/commands'
  if (!existsSync(cliIndexPath) || !existsSync(cliCommandsDir)) {
    pass('CLI source not present — skipping (not a CLI repo checkout)')
  } else {
    try {
      const indexSrc = readFileSync(cliIndexPath, 'utf8')
      const cliFiles = getFilesRecursive('packages/cli/src', ['.ts']).filter(
        (f) => !f.includes('.test.') && !f.includes('.d.ts')
      )
      const commandSources = {}
      const cliSrcByPath = {}
      for (const f of cliFiles) {
        const src = readFileSync(f, 'utf8')
        cliSrcByPath[f] = src
        if (f.startsWith('packages/cli/src/commands/')) commandSources[f] = src
      }
      const registered = extractCliCommandNames(indexSrc, commandSources)
      const refs = findCliHintCommandRefs(cliSrcByPath)
      const violations = refs.filter((r) => !registered.has(r.refToken))
      if (registered.size === 0) {
        warn('Could not extract any registered CLI command names — heuristic miss?')
      } else if (refs.length === 0) {
        pass(
          `No "Try it:/Run:/Visit:/Use: skillsmith <subcmd>" hints found in CLI source (${registered.size} commands registered)`
        )
      } else if (violations.length === 0) {
        pass(
          `${refs.length} CLI hint(s) all reference registered subcommands (${registered.size} commands in registry)`
        )
      } else {
        const formatted = violations
          .map(
            (v) =>
              `  ${v.file}:${v.line} → "${v.fullMatch}" (subcommand "${v.refToken}" not registered)`
          )
          .join('\n')
        fail(
          `CLI hint(s) reference nonexistent subcommands:\n${formatted}`,
          `Either register the subcommand in packages/cli/src/index.ts (Commander.js .command() / .addCommand()) or change the hint to a real one. Registered set: ${[...registered].sort().join(', ')}`
        )
      }
    } catch (e) {
      warn(`Could not check CLI hint command existence: ${e.message}`)
    }
  }
}

// 32. SMI-4457 (R-2): website client code must not use relative `/functions/v1/`.
// Catches the SMI-4454 B1 pattern: PR #751 shipped `'/functions/v1/auth-device-preview'`
// which Astro SSR resolved against www.skillsmith.app (404), masquerading as
// "code expired". Canonical pattern (see PR #757):
//   const API_BASE = import.meta.env.PUBLIC_API_BASE_URL || 'https://api.skillsmith.app'
console.log(`\n${BOLD}32. Website Edge-Function URL Convention (R-2, SMI-4457)${RESET}`)
{
  const websiteSrcDir = 'packages/website/src'
  if (!existsSync(websiteSrcDir)) {
    pass('Website source not present — skipping')
  } else {
    try {
      const websiteFiles = getFilesRecursive(websiteSrcDir, ['.astro', '.ts', '.tsx']).filter(
        (f) => !f.includes('.test.') && !f.includes('.spec.') && !f.includes('.d.ts')
      )
      const websiteSrcByPath = {}
      for (const f of websiteFiles) websiteSrcByPath[f] = readFileSync(f, 'utf8')
      const violations = findRelativeFunctionsV1Urls(websiteSrcByPath)
      if (violations.length === 0) {
        pass(`No relative "/functions/v1/..." URLs in ${websiteFiles.length} website source files`)
      } else {
        const formatted = violations.map((v) => `  ${v.file}:${v.line} — ${v.snippet}`).join('\n')
        fail(
          `Relative "/functions/v1/..." URL(s) detected (Astro SSR resolves these against the website origin, not the API):\n${formatted}`,
          `Replace with \`\${import.meta.env.PUBLIC_API_BASE_URL || 'https://api.skillsmith.app'}/functions/v1/...\` or \`\${supabaseUrl}/functions/v1/...\`.`
        )
      }
    } catch (e) {
      warn(`Could not check website edge-function URL convention: ${e.message}`)
    }
  }
}

// 33. SMI-4458 (R-3): PL/pgSQL `RETURNS TABLE(...)` + unqualified `RETURNING`.
// Catches the SMI-4454 B2 pattern: `claim_device_token` declared
// `RETURNS TABLE (status TEXT, user_id UUID)` and used `RETURNING user_id`
// in an UPDATE — Postgres treats TABLE columns as implicit OUT params,
// making `user_id` ambiguous between the OUT var and the table column. Bug
// only fires at runtime on the approved-but-unconsumed branch. See migration
// 083 for the canonical fix (alias the table, qualify the column).
console.log(`\n${BOLD}33. PL/pgSQL RETURNS TABLE + RETURNING Ambiguity (R-3, SMI-4458)${RESET}`)
{
  const migrationsDir = 'supabase/migrations'
  if (!existsSync(migrationsDir)) {
    pass('No migrations directory — skipping')
  } else {
    try {
      const migrationFiles = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => join(migrationsDir, f))
      const migrationsByPath = {}
      for (const f of migrationFiles) migrationsByPath[f] = readFileSync(f, 'utf8')
      const violations = findReturningTableAmbiguity(migrationsByPath)
      if (violations.length === 0) {
        pass(
          `No PL/pgSQL RETURNS TABLE + unqualified RETURNING ambiguity across ${migrationFiles.length} migration(s)`
        )
      } else {
        const formatted = violations
          .map(
            (v) =>
              `  ${v.file}:${v.line} — ${v.fnName}() RETURNING ${v.col} (also a TABLE OUT column)\n    ${v.snippet}`
          )
          .join('\n')
        fail(
          `PL/pgSQL RETURNS TABLE + unqualified RETURNING detected (ambiguous between OUT var and column):\n${formatted}`,
          `Alias the table and schema-qualify the RETURNING column. Example: \`UPDATE foo f SET ... RETURNING f.<col> INTO ...\`. The audit walks migrations in version order and only flags the LATEST definition of each function — a later migration with the fix supersedes an earlier broken one.`
        )
      }
    } catch (e) {
      warn(`Could not check PL/pgSQL RETURNING ambiguity: ${e.message}`)
    }
  }
}

// 34. SMI-4451 Step 7: encoded-cwd helper drift between writer.ts and
// session-priming-query.ts. The 4-LOC `'-' + cwd.slice(1).replace(/\//g, '-')`
// helper is duplicated by design (plan-review #11) instead of extracted to a
// shared utils/ module — too small to justify a new directory. This check
// fails if either file lacks the canonical regex form, signaling drift.
console.log(`\n${BOLD}34. encoded-cwd helper drift (SMI-4451 Step 7)${RESET}`)
{
  const PAIR = [
    'packages/doc-retrieval-mcp/src/retrieval-log/writer.ts',
    'scripts/session-priming-query.ts',
  ]
  // Canonical pattern: replace forward-slashes with hyphens. Match either
  // regex form (/\//g) or string form ('/'). Both files must match.
  const ENCODED_CWD_REGEX = /\.replace\(\s*\/\\?\/\/?g\s*,\s*['"]-['"]\s*\)/
  const missing = PAIR.filter((p) => {
    if (!existsSync(p)) return true
    return !ENCODED_CWD_REGEX.test(readFileSync(p, 'utf8'))
  })
  if (missing.length === 0) {
    pass(`Both encoded-cwd duplicates present and aligned (${PAIR.length} files)`)
  } else {
    fail(
      `encoded-cwd helper drift in: ${missing.join(', ')}`,
      `Both writer.ts and session-priming-query.ts must contain \`replace(/\\//g, '-')\` (or string-form '/'). Helper is duplicated by design per smi-4450-step7-session-start-hook.md §S4 (plan-review #11) — extract to a shared module if this drift fires repeatedly.`
    )
  }
}

// npm override drift check: @modelcontextprotocol/sdk override "." must match mcp-server range
console.log(`\n${BOLD}Override Drift: @modelcontextprotocol/sdk${RESET}`)
try {
  const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const mcpPkg = JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf8'))
  const overrideDot = rootPkg.overrides?.['@modelcontextprotocol/sdk']?.['.']
  const mcpRange = mcpPkg.dependencies?.['@modelcontextprotocol/sdk']
  if (!overrideDot) {
    fail(
      'Missing override "." for @modelcontextprotocol/sdk in root package.json',
      'Add "." key to force version globally — see docs/internal/implementation/dependabot-mcp-sdk-lock-fix.md'
    )
  } else if (overrideDot !== mcpRange) {
    fail(
      `Override drift: root override "." is ${overrideDot} but mcp-server declares ${mcpRange}`,
      'Update root package.json overrides "." to match packages/mcp-server/package.json'
    )
  } else {
    pass(`@modelcontextprotocol/sdk override "." (${overrideDot}) matches mcp-server range`)
  }
} catch (e) {
  warn('Could not check @modelcontextprotocol/sdk override drift: ' + e.message)
}

// Summary
console.log('\n' + '━'.repeat(50))
console.log(`\n${BOLD}📊 Summary${RESET}\n`)
console.log(`${GREEN}Passed:${RESET}   ${passed}`)
console.log(`${YELLOW}Warnings:${RESET} ${warnings}`)
console.log(`${RED}Failed:${RESET}   ${failed}`)

const total = passed + warnings + failed
const score = Math.round((passed / total) * 100)
console.log(
  `\nCompliance Score: ${score >= 80 ? GREEN : score >= 60 ? YELLOW : RED}${score}%${RESET}`
)

if (failed > 0) {
  console.log(`\n${RED}${BOLD}Standards audit failed.${RESET} Fix the failures above.\n`)
  process.exit(1)
} else if (warnings > 0) {
  console.log(`\n${YELLOW}Standards audit passed with warnings.${RESET}\n`)
  process.exit(0)
} else {
  console.log(`\n${GREEN}${BOLD}Standards audit passed!${RESET}\n`)
  process.exit(0)
}
