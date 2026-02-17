#!/usr/bin/env node
/**
 * Standards Audit Script for Skillsmith
 *
 * Checks codebase compliance with engineering standards.
 * Run: npm run audit:standards
 */

import { execSync } from 'child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

let passed = 0
let warnings = 0
let failed = 0

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

// Check if Docker container is running
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
      const content = readFileSync(filePath, 'utf8')
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

  for (const dir of packageDirs) {
    const pkgPath = join(PACKAGES_DIR, dir, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const deps = pkg.dependencies || {}

      for (const [name, version] of Object.entries(deps)) {
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
