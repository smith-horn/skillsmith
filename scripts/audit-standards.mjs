#!/usr/bin/env node
/**
 * Standards Audit Script for Skillsmith
 *
 * Checks codebase compliance with engineering standards.
 * Run: npm run audit:standards
 */

import { execSync } from 'child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

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

// 5. Standards.md exists
console.log(`\n${BOLD}5. Documentation${RESET}`)
if (existsSync('docs/architecture/standards.md')) {
  pass('standards.md exists')
} else {
  fail('docs/architecture/standards.md not found', 'Create from governance template')
}

if (existsSync('CLAUDE.md')) {
  pass('CLAUDE.md exists')
} else {
  fail('CLAUDE.md not found', 'Create at project root')
}

// 6. ADR Directory
console.log(`\n${BOLD}6. Architecture Decision Records${RESET}`)
if (existsSync('docs/adr')) {
  const adrs = readdirSync('docs/adr').filter((f) => f.endsWith('.md'))
  pass(`docs/adr/ exists with ${adrs.length} ADRs`)
} else {
  warn('docs/adr/ directory not found', 'Create for architecture decisions')
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

// Canonical list of functions that must be anonymous (no JWT verification)
const ANONYMOUS_FUNCTIONS = [
  'early-access-signup',
  'contact-submit',
  'stats',
  'skills-search',
  'skills-get',
  'skills-recommend',
  'stripe-webhook',
  'checkout',
  'events',
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
  for (const fn of ANONYMOUS_FUNCTIONS) {
    if (!configFunctions.has(fn)) {
      fail(`Missing from config.toml: [functions.${fn}] with verify_jwt = false`)
      anonFailed = true
    }
  }

  // Check all canonical functions are documented
  for (const fn of ANONYMOUS_FUNCTIONS) {
    if (!docFunctions.has(fn)) {
      fail(`Missing from CLAUDE.md: npx supabase functions deploy ${fn} --no-verify-jwt`)
      anonFailed = true
    }
  }

  if (!anonFailed) {
    pass(`All ${ANONYMOUS_FUNCTIONS.length} anonymous functions properly configured`)
  }
} else {
  if (!existsSync(CONFIG_TOML_PATH)) {
    warn('supabase/config.toml not found - skipping anonymous function check')
  }
  if (!existsSync(CLAUDE_MD_PATH)) {
    warn('CLAUDE.md not found - skipping anonymous function check')
  }
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
