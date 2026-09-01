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
import { createHash } from 'node:crypto'
import { execSync, execFileSync } from 'child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { dirname, join, relative, resolve as resolvePath } from 'path'
import {
  satisfies,
  extractCompletionIssues,
  hasCompletionSource,
  collectTsEntryExports,
  extractSmokeTestRequiredArrays,
  extractCliCommandNames,
  findCliHintCommandRefs,
  findRelativeFunctionsV1Urls,
  findReturningTableAmbiguity,
  findUncoveredSurfacePaths,
  parseCiYmlJobs,
  checkCarveOutInvariants,
  findUnsafeSkillsRecreateMigrations,
  findOutOfOrderMigrations,
  parseBashArray,
  parseConsumersTag,
  findConventionDrift,
  auditPublishYmlDependentGate,
  auditPublishYmlRequiredGates,
  parseNpmLsJson,
  findFunctionsWithoutSearchPath,
  auditSecdefAnonGrants,
  findServerJsonFieldLengthViolations,
  countUnreleasedEntries,
  findUnreleasedHeadingLines,
  isReleasePrepDiff,
  parseGitCryptEncryptedFiles,
  classifyGitCryptScanResult,
} from './audit-standards-helpers.mjs'
import { getFilesRecursive } from './audit-file-walker-helpers.mjs'
import { isGitCryptEncrypted } from './ci/check-supply-chain-pins.mjs'
import { VERCEL_JSON_SHARED_FIELDS, validateVercelJsonSync } from './audit-vercel-sync-helpers.mjs'
import { findRealpathAsymmetry } from './audit-realpath-asymmetry-helpers.mjs'
import { findUnpinnedActionUses } from './audit-workflow-sha-pin-helpers.mjs'
import { countToolDefinitions } from './audit-mcp-tool-count-helpers.mjs'
import { extractWhatsNewVersion } from './audit-readme-whats-new-helpers.mjs'
import { evaluateInternalVersionCoherence } from './audit-internal-version-coherence-helpers.mjs'
import { resolveExportSetForSubpath } from './audit-export-surface-resolver-helpers.mjs'
import {
  groupConsumerWorkspaceImports,
  evaluateExportSurfaceCoherence,
  evaluateExportSurfaceShadowGate,
} from './audit-export-surface-consumer-helpers.mjs'
import { findGitCryptUnsetRemediations } from './audit-git-crypt-remediation-helpers.mjs'
import { findMissingHuskyStubs } from './audit-husky-stub-coverage-helpers.mjs'
import {
  findFloatingSupabaseCliInstalls,
  findUnpinnedBareNpxCliInPackageJson,
  findUnpinnedRufloMcpEntry,
  findClaudeFlowReintroductions,
} from './audit-cli-pin-drift-helpers.mjs'
import { TEST_PATTERNS } from './ci/source-patterns.mjs'
import { PACKAGE_SPECS } from './lib/version-utils.ts'
// SMI-5992: MAX_LINES + isExemptFromLengthCheck are shared with pre-commit's
// scripts/check-file-length.mjs via scripts/file-length-policy.mjs. Only the
// threshold + test-file exemption predicate are shared — Check 3's own
// directory scope (packages/+apps/ only), extensions (.ts+.tsx), and
// severity (warn()-only, never fails the run) remain intentionally
// different from the pre-commit check. See SMI-5994 for the still-tracked
// scope/severity divergence.
import {
  MAX_LINES as FILE_LENGTH_MAX_LINES,
  isExemptFromLengthCheck,
} from './file-length-policy.mjs'

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
  // SMI-6192: registered so scripts/tests/audit-standards-vercel-output-skip.test.ts
  // can exercise Check 41's REAL production code (including its try/catch) as a
  // narrow `--only realpath-asymmetry` subprocess, without running the full
  // ~70-check audit against a synthetic fixture directory.
  ['realpath-asymmetry', async () => runRealpathAsymmetryCheck()],
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

// SMI-6192: getFilesRecursive is now imported from ./audit-file-walker-helpers.mjs
// (see import block above) — it was previously defined inline here and
// unexported, which forced a would-be test to reimplement it rather than
// exercise the real production code.

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

// SMI-5603: Check 2 (no 'any') and Check 3 (file length) scan both the
// package workspace and standalone apps (e.g. apps/api-proxy) — previously
// only 'packages' was scanned, so apps/ received zero standards coverage.
const TYPE_SAFETY_AND_LENGTH_ROOTS = ['packages', 'apps']

// 2. No 'any' types in source
console.log(`\n${BOLD}2. Type Safety (no 'any' types)${RESET}`)
try {
  const sourceFiles = TYPE_SAFETY_AND_LENGTH_ROOTS.flatMap((root) =>
    getFilesRecursive(root, ['.ts', '.tsx'])
  ).filter((f) => !f.includes('.test.') && !f.includes('.d.ts'))

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
// SMI-5992: the exemption predicate (isExemptFromLengthCheck — matches both
// .test. and .spec.) is shared with pre-commit's scripts/check-file-length.mjs
// via scripts/file-length-policy.mjs. Scope (packages/+apps/ only) and
// severity (warn(), never fails the run) are intentionally NOT shared — see
// the import comment above and SMI-5994.
console.log(`\n${BOLD}3. File Length (max ${FILE_LENGTH_MAX_LINES} lines)${RESET}`)
try {
  const sourceFiles = TYPE_SAFETY_AND_LENGTH_ROOTS.flatMap((root) =>
    getFilesRecursive(root, ['.ts', '.tsx', '.astro'])
  ).filter((f) => !isExemptFromLengthCheck(f))

  const longFiles = []
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8')
    const lineCount = content.split('\n').length
    if (lineCount > FILE_LENGTH_MAX_LINES) {
      longFiles.push({ file: relative(process.cwd(), file), lines: lineCount })
    }
  }

  if (longFiles.length === 0) {
    pass(`All source files under ${FILE_LENGTH_MAX_LINES} lines`)
  } else {
    warn(
      `${longFiles.length} files exceed ${FILE_LENGTH_MAX_LINES} lines`,
      'Split into smaller modules'
    )
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

    // SMI-4653: assert no service has an explicit `image:` field. Load-bearing
    // for `remove-worktree.sh`'s `docker compose down --rmi local` cleanup —
    // adding an `image:` field would silently turn `--rmi local` into a no-op
    // and orphan worktree images would accumulate again.
    // Match `^[ \t]*image:` at the start of a line (allowing 2-6 leading spaces),
    // anywhere in the file. Comments (`# image:`) and substring matches in
    // values are excluded by anchoring on whitespace-only indent.
    const imageFieldRegex = /^[ \t]{2,6}image:\s/m
    if (imageFieldRegex.test(dockerCompose)) {
      fail(
        'docker-compose.yml has an explicit `image:` field on a service (SMI-4653)',
        'Remove the `image:` field; rely on `build:` so `docker compose down --rmi local` in remove-worktree.sh can clean up the per-worktree image. If an `image:` field is genuinely required, update remove-worktree.sh to remove the image by tag explicitly and document the new contract.'
      )
    } else {
      pass('docker-compose.yml has no explicit `image:` fields (SMI-4653 cleanup contract)')
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

    // SMI-4814: scripts that legitimately invoke host npm (host native
    // bindings, docs/instructional strings, multi-line `docker exec sh -c`
    // blocks the per-line scanner can't see, or CI-runner-only scripts
    // whose containing workflow runs everything host-side). Marker mirrors
    // the SMI-4647 `# audit:carveout-pure-js` pattern at line 2543. Marker
    // must appear in the first 20 lines so adding it can't silently move
    // up the file as the script grows.
    const headerLines = content.split('\n').slice(0, 20).join('\n')
    if (/#\s*audit:host-npm-required\b/.test(headerLines)) continue

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
  // SMI-5541: audit-unsubscribe — RFC 8058 one-click unsubscribe. Anonymous
  // (no session); the request is authenticated by an HMAC signature over the
  // user id, verified server-side against the AUDIT_UNSUBSCRIBE_HMAC_KEY secret.
  'audit-unsubscribe',
  // Authenticated functions with internal JWT validation
  // These validate tokens in function code, not at Supabase gateway
  'generate-license',
  'regenerate-license',
  'create-portal-session',
  'license-status',
  // SMI-5531: authenticates the caller's presented API key or device-session
  // JWT in-handler (mirrors license-status's authenticateRequest-only
  // precedent, extended with authenticateWithJWT) — verify_jwt=true would
  // 401 every real MCP client before the handler could even run.
  'telemetry-consent',
  'list-invoices',
  'skills-outreach-preferences',
  'admin-grant-subscription',
  // SMI-5776: admin-incident-manage — public status-page incident manager.
  // Same auth model as admin-grant-subscription (in-handler service-role
  // secret compare or profiles.role admin check); gateway does not verify JWT.
  'admin-incident-manage',
  // SMI-5905: private-registry-get — private-registry skill content fetch. The
  // gateway is deliberately NOT the gate: the handler authoritatively validates
  // the caller's own user JWT via adminClient.auth.getUser(), independent of the
  // shared auth-middleware's JWT_AUTH_PERCENTAGE rollout flag (which defaults to
  // 0), then re-reads the row under that same token so RLS scopes it. Same
  // in-handler-auth shape as admin-grant-subscription / admin-incident-manage.
  'private-registry-get',
  // registry-sync: self-managed in-handler auth via runAuthMiddleware, same
  // as skills-search — the gateway performs no JWT check; the in-handler
  // Team/Enterprise tier gate is the real access control.
  'registry-sync',
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
  // SMI-4463: quota-monitor — service-role cron, mirrors advance-notice-email
  // pattern (service-role header bypasses gateway JWT, server-side re-checks).
  'quota-monitor',
  // SMI-5752: status-check — pg_cron-invoked synthetic status-page check,
  // service-role internal. Mirrors webhook-heartbeat-monitor / quota-monitor.
  'status-check',
  // SMI-5754: status-public — public, anonymous status-page read endpoint
  // (Wave 4). Uses createSupabaseAdminClient() to read past the deliberate
  // v_status_current/status_daily_rollups RLS gap, not for elevated
  // privilege; consumes zero request input.
  'status-public',
  // SMI-5866: scan-coverage-monitor — pg_cron-invoked indexer self-check,
  // service-role internal. Mirrors webhook-heartbeat-monitor / quota-monitor.
  'scan-coverage-monitor',
  // SMI-6052: release-cadence-heartbeat-monitor — pg_cron-invoked positive
  // liveness backstop for release-cadence.yml, service-role internal.
  // Mirrors scan-coverage-monitor / webhook-heartbeat-monitor.
  'release-cadence-heartbeat-monitor',
  // SMI-6204: sso-domain-reverify — pg_cron-invoked daily SSO domain-claim
  // DNS TXT reverify sweep, service-role internal (Postgres/pg_cron cannot
  // resolve DNS itself). Mirrors scan-coverage-monitor / status-check.
  'sso-domain-reverify',
  // SMI-6209: indexer-lock-starvation-monitor — pg_cron-invoked Arm A/B
  // lock-starvation detection for the skill indexer, service-role internal.
  // Mirrors scan-coverage-monitor / webhook-heartbeat-monitor.
  'indexer-lock-starvation-monitor',
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
      // Skip git-crypt encrypted files (binary blobs starting with \x00GITCRYPT)
      if (isGitCryptEncrypted(filePath)) {
        continue
      }
      const content = readFileSync(filePath, 'utf8')
      const lines = content.split('\n')
      const headerLines = lines.slice(0, 10).join('\n')

      // Check 1: SMI reference in header
      // SMI-4815: accept `SMI-NONE` for pre-convention migrations whose
      // introducing commit had no SMI ref (must be paired with a
      // `-- Justification:` line in the migration; see
      // scripts/backfill-migration-headers.mjs).
      const hasSmiRef = /--\s*SMI-(\d+|NONE)/i.test(headerLines)

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
          // SMI-4816: accept both `SET search_path = ...` and
          // `SET search_path TO ...` forms — both are valid Postgres syntax
          // and the codebase mixes them. Earlier check only matched `=`,
          // which falsely flagged seven device-code/profile-completion
          // functions in 080-083 that use `TO 'public', 'extensions'`.
          if (!/SET\s+search_path\s+(=|TO)\s*\S/i.test(funcBlock)) {
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
  /status\.skillsmith\.app/,
  /registry\.skillsmith\.app/,
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
    // SMI-4963: coverage-report recipient lives in coverage-templates.ts.
    'supabase/functions/coverage-report/coverage-templates.ts',
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
  // SMI-5740: `git-crypt status`'s own output never contains the substring
  // "locked" (confirmed against git-crypt's own source — status() reports
  // purely from .gitattributes + blob-content inspection, neither of which
  // needs the key). A genuinely-locked-but-installed checkout still runs this
  // scan successfully and, since the smudge filter never ran, every real
  // encrypted-scope file's on-disk bytes are ciphertext — indistinguishable
  // from double-encryption on a per-file basis. classifyGitCryptScanResult
  // detects "locked" instead by whether ALL encrypted-scope files are
  // ciphertext (locked) vs. only SOME of them (a genuine per-file anomaly).
  const status = execSync('git-crypt status 2>/dev/null', { encoding: 'utf8' })
  const encryptedFiles = parseGitCryptEncryptedFiles(status)
  const doubleEncrypted = encryptedFiles.filter((file) => isGitCryptEncrypted(file))
  const result = classifyGitCryptScanResult(encryptedFiles.length, doubleEncrypted.length)

  if (result === 'locked') {
    warn(
      `All ${encryptedFiles.length} git-crypt-scoped file(s) still show ciphertext on disk — ` +
        'this repository appears locked (key not unlocked), not double-encrypted',
      'Unlock git-crypt on this runner to exercise this check for real'
    )
  } else if (result === 'double-encrypted') {
    fail(`${doubleEncrypted.length} double-encrypted files found:\n${doubleEncrypted.join('\n')}`)
  } else {
    pass('No double-encrypted files')
  }
} catch {
  warn(
    'Skipped (git-crypt not installed) — Check 18 did not run',
    'Install git-crypt on this runner to exercise this check'
  )
}

// 19. docs/ Directory Structure Guard (SMI-2607)
console.log(`\n${BOLD}19. docs/ Directory Structure Guard (SMI-2607)${RESET}`)
// `privacy` is the public legal-docs folder (SMI-5012 W4.S3 / SMI-5025) —
// served as user-facing privacy notice at skillsmith.app/docs/privacy/.
// Distinct from the `internal` submodule (private architecture / process).
const allowedDocsDirs = ['internal', 'privacy']
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
    // parse it. SMI-5079: some npm builds split warnings/JSON across stdout
    // + stderr or prepend non-JSON prelude. `parseNpmLsJson` tries direct
    // parse, brace-prefix parse, and stderr fallback before returning null.
    const getResolvedVersions = (dep) => {
      let stdoutRaw = ''
      let stderrRaw = ''
      try {
        stdoutRaw = execSync(`npm ls ${dep} --all --json`, {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        stdoutRaw = (err && err.stdout && err.stdout.toString('utf-8')) || ''
        stderrRaw = (err && err.stderr && err.stderr.toString('utf-8')) || ''
      }
      const tree = parseNpmLsJson(stdoutRaw, stderrRaw)
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
// `pass('Skipped — ...')`. Matches main check 22's (Workflow Inline require()
// Paths) skip-as-pass pattern. Noise suppression by design — see commit
// message for rationale.
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
  // SMI-5681: SRC_PATTERNS / INFRA_PATTERNS / SRC_EXCLUDED and the combined
  // hasCompletionSource() decision now live in audit-standards-helpers.mjs
  // (imported above) so infra/config-path recognition is unit-testable
  // without a real git repo. See that file for the ADR-109 path list and the
  // rationale for keeping it separate from scripts/ci/source-patterns.mjs.

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

            const hasSource = hasCompletionSource(files)

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
        // Matches main check 22's (Workflow Inline require() Paths) pattern
        // for missing infrastructure. Noise suppression by design — a
        // genuinely corrupt git state will fail many other checks (pre-push
        // hooks, git log in calling tools, etc.).
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
      // SMI-5216: spread-aware count. Plain entries count as 1; a `...builder()`
      // spread is resolved to the MAX *ToolSchema set the builder can contribute
      // (conditional pushes included). Invariant: the README documents every tool
      // that CAN register. Runtime may register fewer (e.g. apply_recommended_edit
      // is gated on APPLY_TEMPLATE_REGISTRY) — that's covered by the
      // ListTools-registry test, not this counter.
      const mcpSrcDir = dirname(mcpIndexPath)
      const { count: toolCount, unresolvedSpreads } = countToolDefinitions({
        indexContent,
        // Map an import specifier (e.g. './audit-tool-dispatch.js') to its .ts source.
        resolveModuleSource: (spec) => {
          if (!spec.startsWith('.')) return null
          const tsPath = resolvePath(mcpSrcDir, spec.replace(/\.js$/, '.ts'))
          return existsSync(tsPath) ? readFileSync(tsPath, 'utf8') : null
        },
      })
      if (unresolvedSpreads.length > 0) {
        warn(
          `Check 25: could not resolve spread builder(s) in toolDefinitions: ${unresolvedSpreads.join(', ')}`,
          'Each unresolved spread was counted as a single tool — the README parity count may be low'
        )
      }

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
        'skillsmith.filterSkills', // SMI-5304: collector in searchFilters.test.ts, action in searchSkills.test.ts
        'skillsmith.selectForCompare', // SMI-5340: tree-context compare; action tested in compareSkills.test.ts + compare-source.test.ts
        'skillsmith.compareWithSelected', // SMI-5340: tree-context compare; action tested in compareSkills.test.ts
        'skillsmith.clearSkillFilters', // SMI-5304: action exercised in searchSkills.test.ts
        'skillsmith.runValidate', // SMI-5346: validate helper tested in createSkill.checklist.test.ts
        'skillsmith.dismissNextSteps', // SMI-5346: dismiss tested in skillTreeDataProvider.nextSteps.test.ts
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

// 34. SMI-5419: encoded-project-dir resolver drift. The canonical resolver lives
// in project-dir.ts (TS) with two behavior-equivalent mirrors — scripts/lib/
// project-dir.mjs (plain-node sites that avoid the tsx startup cost) and scripts/
// lib/project-dir.sh (shell paths that must survive a dead-node/dead-binding
// state) — all three kept in lock-step by a cross-runtime parity test. Every site
// that needs a `~/.claude/projects/<dir>` path delegates to a shared resolver
// instead of re-deriving the encoding:
//   - shared main-repo dir (resolveSharedProjectDir): writer.ts + retrieval-log-cli.mjs
//     (telemetry DB), session-priming-query.ts (MEMORY.md), memory-topic-files.ts +
//     retro-frontmatter.mjs (/memory corpus), check-retrieval-events.sh (diagnostic)
//   - per-cwd dir (resolveClaudeProjectDir): session-priming-query.ts (session *.jsonl)
console.log(`\n${BOLD}34. encoded-project-dir resolver drift (SMI-5419)${RESET}`)
{
  const CANONICAL = 'packages/doc-retrieval-mcp/src/retrieval-log/project-dir.ts'
  const MJS_MIRROR = 'scripts/lib/project-dir.mjs'
  // Canonical slash→dash encoder; match regex form (/\//g) or string form ('/').
  const ENCODER_REGEX = /\.replace\(\s*\/\\?\/\/?g\s*,\s*['"]-['"]\s*\)/
  // Sites that MUST resolve via the shared resolver rather than re-deriving the
  // encoded dir inline; each entry is the resolver symbol the file must reference.
  const DELEGATES = [
    ['packages/doc-retrieval-mcp/src/retrieval-log/writer.ts', /resolveSharedProjectDir/],
    ['scripts/retrieval-log-cli.mjs', /resolveSharedProjectDir/],
    ['scripts/session-priming-query.ts', /resolveSharedProjectDir/],
    ['scripts/session-priming-query.ts', /resolveClaudeProjectDir/],
    ['packages/doc-retrieval-mcp/src/adapters/memory-topic-files.ts', /resolveSharedProjectDir/],
    ['scripts/lib/retro-frontmatter.mjs', /resolveSharedProjectDir/],
  ]
  // Plain-node consumers must IMPORT the .mjs mirror, not re-implement it.
  const MJS_IMPORTERS = ['scripts/retrieval-log-cli.mjs', 'scripts/lib/retro-frontmatter.mjs']
  const problems = []
  for (const f of [CANONICAL, MJS_MIRROR]) {
    if (!existsSync(f) || !ENCODER_REGEX.test(readFileSync(f, 'utf8'))) {
      problems.push(`${f} missing the canonical slash->dash encoder`)
    }
  }
  for (const [f, re] of DELEGATES) {
    if (existsSync(f) && !re.test(readFileSync(f, 'utf8'))) {
      problems.push(`${f} must resolve the encoded project dir via ${re.source}`)
    }
  }
  for (const f of MJS_IMPORTERS) {
    if (existsSync(f) && !/from '\.\/(lib\/)?project-dir\.mjs'/.test(readFileSync(f, 'utf8'))) {
      problems.push(`${f} must import the shared resolver from project-dir.mjs`)
    }
  }
  // Shell mirror (must survive a dead-node/dead-binding state) + its consumer.
  const SHELL_MIRROR = 'scripts/lib/project-dir.sh'
  if (!existsSync(SHELL_MIRROR)) {
    problems.push(`${SHELL_MIRROR} missing (shell mirror of the resolver)`)
  } else {
    const sh = readFileSync(SHELL_MIRROR, 'utf8')
    for (const fn of [
      'encode_project_segment',
      'reconcile_encoded_dir',
      'resolve_shared_project_dir',
    ]) {
      if (!sh.includes(fn)) problems.push(`${SHELL_MIRROR} missing function ${fn}`)
    }
    // The shell encoder is bash parameter expansion (${1//\//-}), not a JS
    // .replace(), so ENCODER_REGEX can't reach it. Assert the slash->dash form
    // structurally here too — otherwise a silent shell-encoder change would only
    // be caught by the parity test, leaving Check 34's "all 3 mirrors agree" claim
    // unenforced for the shell side (SMI-5419 retro M1).
    if (!/\$\{1\/\/\\\/\/-\}/.test(sh)) {
      problems.push(`${SHELL_MIRROR} missing the canonical slash->dash encoder (\${1//\\//-})`)
    }
  }
  const SHELL_CONSUMER = 'scripts/check-retrieval-events.sh'
  if (existsSync(SHELL_CONSUMER)) {
    const c = readFileSync(SHELL_CONSUMER, 'utf8')
    if (!/lib\/project-dir\.sh/.test(c) || !/resolve_shared_project_dir/.test(c)) {
      problems.push(
        `${SHELL_CONSUMER} must source lib/project-dir.sh and call resolve_shared_project_dir`
      )
    }
  }
  if (problems.length === 0) {
    pass(
      'encoded-project-dir resolver canonical (project-dir.ts + .mjs + .sh mirrors); all sites delegate (memory/telemetry main-repo, sessions per-cwd)'
    )
  } else {
    fail(
      `encoded-project-dir resolver drift: ${problems.join('; ')}`,
      `SMI-5419: keep the encoder canonical in project-dir.ts + scripts/lib/project-dir.mjs (parity-tested) and have all sites resolve through the shared resolver.`
    )
  }
}

// 35. SMI-4451 Step 8: held-out pair auto-detection (resolves SPARC §S7 L4).
// Walks `docs/internal/retros/*.md` for entries dated within the 14-day
// post-Wave-1-ship window with frontmatter `reversal_of` non-empty AND
// `ground_truth_query` set. Idempotently appends each to
// `scripts/tests/fixtures/retro-held-out-pairs.jsonl` (tracked, not encrypted).
// The 6-pair tuning loop must NOT be re-run against held-out entries until
// Wave 1 soak completes; the regression runner reads training and held-out
// fixtures separately. Section 35 also warns when a query appears in BOTH
// fixtures (overfit risk).
//
// WAVE_1_SHIP_DATE: 2026-04-25 (PR #774 merge — SessionStart hook landed).
// Section is a no-op before that date so this audit never blocks pre-ship.
console.log(`\n${BOLD}35. Held-out pair detection (SMI-4451 Step 8)${RESET}`)
{
  const WAVE_1_SHIP_DATE = '2026-04-25'
  const WAVE_1_SHIP_MS = Date.parse(`${WAVE_1_SHIP_DATE}T00:00:00Z`)
  const WINDOW_END_MS = WAVE_1_SHIP_MS + 14 * 24 * 60 * 60 * 1000
  const NOW_MS = Date.now()

  const TRAINING_PATH = 'scripts/tests/fixtures/retro-training-pairs.jsonl'
  const HELD_OUT_PATH = 'scripts/tests/fixtures/retro-held-out-pairs.jsonl'
  const RETROS_DIR = 'docs/internal/retros'

  if (NOW_MS < WAVE_1_SHIP_MS) {
    pass(`Pre-ship (${WAVE_1_SHIP_DATE}) — held-out detection disabled`)
  } else if (!existsSync(RETROS_DIR)) {
    warn(`${RETROS_DIR} missing (likely submodule not initialized) — skipping`)
  } else if (!existsSync(TRAINING_PATH) || !existsSync(HELD_OUT_PATH)) {
    fail(
      'Step 8 fixture missing',
      `Both ${TRAINING_PATH} and ${HELD_OUT_PATH} must exist (Step 8 deliverable).`
    )
  } else {
    try {
      // js-yaml available via createRequire pattern used by retro-frontmatter.mjs
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const yaml = require('js-yaml')

      const parseFm = (content) => {
        const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (!m) return null
        try {
          return yaml.load(m[1])
        } catch {
          return null
        }
      }

      const loadJsonl = (path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'))
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          .filter(Boolean)

      const trainingPairs = loadJsonl(TRAINING_PATH)
      const trainingQueries = new Set(trainingPairs.map((p) => p.query))
      const existingHeldOut = loadJsonl(HELD_OUT_PATH)
      const existingQueries = new Set(existingHeldOut.map((p) => p.query))

      const retroFiles = readdirSync(RETROS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(RETROS_DIR, f))

      const candidates = []
      const overlaps = []
      for (const file of retroFiles) {
        const fm = parseFm(readFileSync(file, 'utf8'))
        if (!fm) continue
        const reversalOf = Array.isArray(fm.reversal_of) ? fm.reversal_of : []
        if (reversalOf.length === 0) continue
        const gtQuery =
          typeof fm.ground_truth_query === 'string' ? fm.ground_truth_query.trim() : ''
        if (gtQuery.length === 0) continue
        // js-yaml parses bare `date: 2026-04-25` as a Date instance; quoted
        // form `date: '2026-04-25'` stays a string. Handle both.
        let dateMs = NaN
        if (typeof fm.date === 'string') {
          dateMs = Date.parse(`${fm.date}T00:00:00Z`)
        } else if (fm.date instanceof Date) {
          dateMs = fm.date.getTime()
        }
        if (Number.isNaN(dateMs)) continue
        if (dateMs < WAVE_1_SHIP_MS || dateMs > WINDOW_END_MS) continue

        if (trainingQueries.has(gtQuery)) {
          overlaps.push(`${file}: query also in training set`)
        }
        if (existingQueries.has(gtQuery)) continue
        candidates.push({
          id: `held-out-${candidates.length + existingHeldOut.length + 1}`,
          source: file,
          query: gtQuery,
          expectedPaths: [file.split('/').pop()],
        })
      }

      // Audit is read-only; it warns on missing entries rather than mutating
      // the tracked fixture (no implicit writes from a check script).
      if (candidates.length > 0) {
        warn(
          `${candidates.length} retro(s) qualify for held-out reservation but not in ${HELD_OUT_PATH}: ` +
            candidates.map((c) => c.source).join(', ') +
            ` — append entries manually (one JSON line per retro, schema: {id, query, expectedPaths}).`
        )
      } else {
        pass(
          `Held-out window ${WAVE_1_SHIP_DATE} → +14d: ${existingHeldOut.length} reserved, no unrecorded candidates`
        )
      }
      for (const o of overlaps) {
        warn(`Training/held-out overlap risk — ${o}`)
      }
    } catch (e) {
      warn(`Could not run held-out detection: ${e.message}`)
    }
  }
}

// 36. SMI-4459 (R-4): every deployed edge function and conversion-critical
// website page should have a smoke surface in scripts/smoke-prod/surfaces.json
// (or be explicitly allowlisted in scripts/smoke-prod/.surfaces-allowlist.txt).
// Warning-only — adding a new edge function is a perfectly valid PR; this
// just nudges the author to add the smoke entry in the same PR. The R-1/R-2/R-3
// backstops above catch string-shape drift; R-4 catches "shipped a surface
// nobody verifies."
console.log(`\n${BOLD}36. Smoke Surface Coverage (R-4, SMI-4459)${RESET}`)
{
  const surfacesJsonPath = 'scripts/smoke-prod/surfaces.json'
  const allowlistPath = 'scripts/smoke-prod/.surfaces-allowlist.txt'
  if (!existsSync(surfacesJsonPath)) {
    pass('surfaces.json not present — skipping (smoke-prod harness not yet wired)')
  } else {
    try {
      const surfaces = JSON.parse(readFileSync(surfacesJsonPath, 'utf8'))
      const surfaceGlobs = (surfaces.surfaces || []).flatMap((s) => s.trigger_globs || [])
      let allowlistGlobs = []
      if (existsSync(allowlistPath)) {
        allowlistGlobs = readFileSync(allowlistPath, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'))
      }
      // Candidate paths: every supabase/functions/<name>/index.ts AND every
      // packages/website/src/pages/**/*.astro file. Walk both trees.
      const candidates = []
      const fnDir = 'supabase/functions'
      if (existsSync(fnDir)) {
        for (const entry of readdirSync(fnDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          if (entry.name.startsWith('_')) continue
          const idx = `${fnDir}/${entry.name}/index.ts`
          if (existsSync(idx)) candidates.push(idx)
        }
      }
      const pagesDir = 'packages/website/src/pages'
      if (existsSync(pagesDir)) {
        for (const f of getFilesRecursive(pagesDir, ['.astro'])) {
          candidates.push(f)
        }
      }
      const uncovered = findUncoveredSurfacePaths(candidates, surfaceGlobs, allowlistGlobs)
      if (candidates.length === 0) {
        pass('No edge functions or website pages found — skipping')
      } else if (uncovered.length === 0) {
        pass(
          `All ${candidates.length} user-facing surface(s) covered by surfaces.json or allowlist`
        )
      } else {
        const formatted = uncovered.map((p) => `  ${p}`).join('\n')
        warn(
          `${uncovered.length} surface(s) not covered by surfaces.json and not allowlisted:\n${formatted}\n  User-facing → add to scripts/smoke-prod/surfaces.json.\n  Cron-only/internal → add to scripts/smoke-prod/.surfaces-allowlist.txt with rationale comment.\n  See .claude/development/deployment-guide.md § "Adding New Edge Functions".`
        )
      }
    } catch (e) {
      warn(`Could not check smoke surface coverage: ${e.message}`)
    }
  }
}

// 37. Workflow setup-node node-version consistency (SMI-4489)
// Every `actions/setup-node` step's `node-version:` MUST either reference
// `${{ env.NODE_VERSION }}` (preferred) OR match the workflow-local `env.NODE_VERSION`
// declaration. Prevents future drift like the kind that motivated SMI-4488 + SMI-4489.
console.log(`\n${BOLD}37. Workflow setup-node node-version drift (SMI-4489)${RESET}`)
{
  const workflowDir = '.github/workflows'
  if (!existsSync(workflowDir)) {
    pass('Skipped (no .github/workflows/ directory)')
  } else {
    const violations = []
    const workflowFiles = readdirSync(workflowDir).filter(
      (f) => f.endsWith('.yml') || f.endsWith('.yaml')
    )
    for (const file of workflowFiles) {
      const fullPath = join(workflowDir, file)
      const content = readFileSync(fullPath, 'utf8')
      const lines = content.split('\n')
      // Find workflow-level env.NODE_VERSION (first match wins; matches `  NODE_VERSION: '22'`)
      let workflowNodeVersion = null
      for (const line of lines) {
        const m = line.match(/^\s+NODE_VERSION:\s*['"]?([^'"\s#]+)['"]?/)
        if (m) {
          workflowNodeVersion = m[1]
          break
        }
      }
      // Find each setup-node step and look ahead up to 6 lines for node-version:
      for (let i = 0; i < lines.length; i++) {
        if (!/actions\/setup-node@/.test(lines[i])) continue
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const m = lines[j].match(/^\s+node-version:\s*(.+?)\s*(?:#.*)?$/)
          if (!m) continue
          const raw = m[1].trim()
          // Strip surrounding quotes
          const value = raw.replace(/^['"]|['"]$/g, '')
          const usesEnvRef = /\$\{\{\s*env\.NODE_VERSION\s*\}\}/.test(value)
          if (usesEnvRef) break
          if (workflowNodeVersion !== null && value === workflowNodeVersion) break
          violations.push({
            file: fullPath,
            line: j + 1,
            value,
            workflowEnv: workflowNodeVersion,
          })
          break
        }
      }
    }
    if (violations.length === 0) {
      pass(
        'All setup-node node-version values reference ${{ env.NODE_VERSION }} or match workflow env'
      )
    } else {
      const formatted = violations
        .map(
          (v) =>
            `  ${v.file}:${v.line} — node-version: '${v.value}' (workflow env.NODE_VERSION: ${
              v.workflowEnv ?? 'undeclared'
            })`
        )
        .join('\n')
      warn(
        `${violations.length} setup-node step(s) with drifted node-version:\n${formatted}\n  Fix: replace literal with \${{ env.NODE_VERSION }} or align value with workflow-level env.NODE_VERSION declaration.`
      )
    }
  }
}

// 38. Pure-JS carve-out drift prevention (SMI-4647 + SMI-4648)
// Two invariants on .github/workflows/ci.yml:
//   A) Every job with `needs: docker-build` either invokes `docker run skillsmith-ci:`
//      OR carries the `# audit:carveout-pure-js` marker comment in its header.
//   B) Every job carrying the carve-out marker that invokes `npm run audit:standards`
//      must NOT pass `--only <flag>` for any flag in the native-loading deny-list.
// Catches both directions of drift: re-coupling pure-JS jobs to Docker AND adding
// native-loading audit-standards flags to a carved-out job.
console.log(`\n${BOLD}38. CI pure-JS carve-out drift (SMI-4647 + SMI-4648)${RESET}`)
{
  const ciYml = '.github/workflows/ci.yml'
  if (!existsSync(ciYml)) {
    pass('Skipped (.github/workflows/ci.yml not present)')
  } else {
    // Deny-list: --only flags whose closure lazy-loads native bindings.
    // Update when a new flag adds an import of better-sqlite3 / onnxruntime-node.
    const NATIVE_LOADING_AUDIT_FLAGS = ['retro-frontmatter']
    const jobs = parseCiYmlJobs(readFileSync(ciYml, 'utf8'))
    const { violationsA, violationsB } = checkCarveOutInvariants(jobs, NATIVE_LOADING_AUDIT_FLAGS)
    if (violationsA.length === 0 && violationsB.length === 0) {
      pass(
        `Carve-out invariants hold (${jobs.length} jobs scanned; deny-list: ${NATIVE_LOADING_AUDIT_FLAGS.join(', ')})`
      )
    } else {
      const aMsgs = violationsA
        .map((v) => `  ${ciYml}:${v.line} — job '${v.name}': ${v.reason}`)
        .join('\n')
      const bMsgs = violationsB
        .map(
          (v) =>
            `  ${ciYml}:${v.line} — job '${v.name}' is carved out but invokes 'audit:standards --only ${v.flag}' (native-loading flag)`
        )
        .join('\n')
      const parts = []
      if (violationsA.length) {
        parts.push(
          `Invariant A — needs: docker-build without Docker invocation:\n${aMsgs}\n  Fix: add 'docker run skillsmith-ci:...' OR add '# audit:carveout-pure-js — see <plan>' marker on the job's header.`
        )
      }
      if (violationsB.length) {
        parts.push(
          `Invariant B — carved-out job uses native-loading audit flag:\n${bMsgs}\n  Fix: remove the '--only ${NATIVE_LOADING_AUDIT_FLAGS.join('/')}' flag, OR remove the carve-out marker (job will then run in Docker).`
        )
      }
      fail(parts.join('\n\n'))
    }
  }
}

// SMI-4641 (was SMI-4592 byte-identity): vercel.json structural sync.
// Two vercel.json files exist by design — they target different deploy paths:
//   • root vercel.json: read by Vercel's git-integrated deploy (rootDirectory=null
//     on the project). `buildCommand` here must materialize BOA at REPO-ROOT
//     `.vercel/output/`, hence the `cp -r packages/website/.vercel/output …` postbuild
//     step. The @astrojs/vercel adapter writes to `packages/website/.vercel/output/`,
//     but `vercel build` reads from `<projectRoot>/.vercel/output/`.
//   • packages/website/vercel.json: read by `cd packages/website && vercel --prod`.
//     The local CLI's `vercel build` runs with cwd=packages/website/, so BOA is
//     written and read at `packages/website/.vercel/output/` — no postbuild copy needed.
//
// What MUST match across both files (else preview/staging and prod ship divergent UX):
//   • framework, installCommand, redirects, headers
// What is ALLOWED to differ:
//   • buildCommand (root needs the BOA postbuild copy; website-local does not)
//   • outputDirectory (today not set in either — the cp-step makes it unnecessary;
//     if reintroduced, validate as a relative POSIX path with no `..` segments)
console.log(`\n${BOLD}39. vercel.json structural sync (SMI-4641)${RESET}`)
try {
  const root = JSON.parse(readFileSync('vercel.json', 'utf8'))
  const website = JSON.parse(readFileSync('packages/website/vercel.json', 'utf8'))
  const result = validateVercelJsonSync(root, website)
  if (!result.ok && result.kind === 'drift') {
    fail(
      `vercel.json drift on ${result.drifted.join(', ')} between repo root and packages/website/`,
      `Sync the listed fields. Both files ship redirects/headers/CSP to end users; divergence means preview/staging and prod render differently. \`buildCommand\` and \`outputDirectory\` are allowed to differ because the two files target different cwd contexts (repo root vs packages/website/).`
    )
  } else if (!result.ok && result.kind === 'shape') {
    fail(
      `vercel.json#outputDirectory has an invalid path shape on ${result.side} (value: ${JSON.stringify(result.value)})`,
      'outputDirectory must be a non-empty relative POSIX path: no leading "/", no ".." segments, no backslashes. If unset (preferred — let the buildCommand materialize BOA), drop the field.'
    )
  } else {
    pass(
      `vercel.json structural sync OK (${VERCEL_JSON_SHARED_FIELDS.join('/')} match; buildCommand/outputDirectory may differ by design)`
    )
  }
} catch (e) {
  warn('Could not check vercel.json sync: ' + e.message)
}

// 39. SMI-4693: fixture-leak guard — every test that spawns `git` against a
// temp repo must import scripts/tests/_lib/git-fixture-env so GIT_DISCOVERY_VARS
// are stripped from the spawned env. Without this, the SMI-4693 leak path
// (vitest fork-pool worker cwd inheritance + macOS realpath asymmetry +
// inherited GIT_INDEX_FILE) can re-mutate the parent worktree's branch state
// when host vitest runs from a feature-branch worktree.
//
// B-2: regex covers `execFileSync` / `execSync` / `spawnSync` / template-literal
//      `execSync(\`git …\`)`. SHELL_WRAPPER_EXEMPT documents the manually-
//      audited carve-out for `runScript`-style fixtures whose tested shell
//      script invokes git two layers removed (the .test.ts file itself does
//      not spawn git directly).
// S-5: glob includes `packages/&#42;/{src,tests}/**/*.test.ts` to catch
//      `git-commits.test.ts` and any future colocated fixtures.
console.log(`\n${BOLD}40. Fixture Git Env Sanitisation (SMI-4693)${RESET}`)
{
  const FIXTURE_GIT_AUDIT_GLOBS = [
    'scripts/tests',
    'packages/core/src',
    'packages/core/tests',
    'packages/mcp-server/src',
    'packages/mcp-server/tests',
    'packages/cli/src',
    'packages/cli/tests',
    'packages/doc-retrieval-mcp/src',
    'packages/doc-retrieval-mcp/tests',
    'packages/enterprise/src',
    'packages/enterprise/tests',
  ]

  // SHELL_WRAPPER_EXEMPT — manually audited 2026-05-03. These tests invoke
  // shell scripts that themselves run git; the .test.ts file itself does not
  // spawn git, so the helper does not apply. The shell scripts must use
  // git-scoped flags directly. Reverify quarterly when the SMI-4693 retro
  // soak completes (Wave 4 follow-up PR).
  // NOTE: `rebase-worktree.test.ts` and `remove-worktree.test.ts` DO spawn
  // git directly (they build the fixture repo via execSync('git init …'))
  // BEFORE invoking the shell wrapper, so they are NOT exempt — they were
  // migrated in Wave 2.
  const SHELL_WRAPPER_EXEMPT = new Set([])

  // B-2: broadened regex — execFileSync | execSync | spawnSync | exec()
  //      with template-literal first arg starting with `git`.
  const SPAWNS_GIT =
    /(?:execFileSync|execSync|spawnSync)\(\s*['"`]git['"`]|(?:execSync|exec)\(\s*[`'"]\s*git\b/

  // Match relative imports of `_lib/git-fixture-env` from any depth. The path
  // may include intermediate segments (e.g. `../../../../scripts/tests/_lib/…`
  // from packages/doc-retrieval-mcp/src/adapters/), so we accept any
  // relative-prefixed string ending in `_lib/git-fixture-env(.js|.ts)?` — a
  // bare specifier (no extension) is the historical norm, but an explicit
  // `.ts` suffix is also an established repo-wide import style (86 files
  // under scripts/tests/ alone), confirmed missing here when it produced a
  // false positive on scripts/tests/indexer/smi5879-gate-check.dispositions.test.ts,
  // SMI-5879 Wave 3 item 4.
  const HAS_HELPER_IMPORT = /from ['"]\.\.?\/[^'"]*_lib\/git-fixture-env(?:\.(?:js|ts))?['"]/

  // SMI-4693-EXEMPT escape hatch: a `// SMI-4693-EXEMPT: <reason>` comment
  // anywhere in the file marks an intentional opt-out. Use sparingly; document
  // why the helper does not apply (e.g. test asserts on RAW process.env state).
  const EXEMPT_MARKER = /\/\/\s*SMI-4693-EXEMPT:/

  function listTestFiles(dirs) {
    const out = []
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      // Walk recursively; collect *.test.ts (NOT .test.sh — vitest only
      // picks up .test.ts per CLAUDE.md SMI-1780).
      const stack = [dir]
      while (stack.length) {
        const cur = stack.pop()
        let entries
        try {
          entries = readdirSync(cur, { withFileTypes: true })
        } catch {
          continue
        }
        for (const ent of entries) {
          const full = join(cur, ent.name)
          if (ent.isDirectory()) {
            if (ent.name === 'node_modules' || ent.name === 'dist') continue
            stack.push(full)
          } else if (ent.isFile() && ent.name.endsWith('.test.ts')) {
            out.push(full)
          }
        }
      }
    }
    return out
  }

  try {
    const files = listTestFiles(FIXTURE_GIT_AUDIT_GLOBS)
    const violations = []
    let scanned = 0
    for (const f of files) {
      if (SHELL_WRAPPER_EXEMPT.has(f)) continue
      const text = readFileSync(f, 'utf8')
      if (!SPAWNS_GIT.test(text)) continue
      scanned++
      if (HAS_HELPER_IMPORT.test(text)) continue
      if (EXEMPT_MARKER.test(text)) continue
      violations.push(f)
    }
    if (violations.length === 0) {
      pass(`All ${scanned} test fixtures that spawn git import the SMI-4693 helper`)
    } else {
      const list = violations.map((v) => `  - ${v}`).join('\n')
      fail(
        `${violations.length} test fixture(s) spawn git without importing scripts/tests/_lib/git-fixture-env:\n${list}`,
        `Each listed file calls execFileSync/execSync/spawnSync with 'git' as the first arg but does not import \`makeFixtureEnv\` from \`scripts/tests/_lib/git-fixture-env\`. Without it, GIT_DISCOVERY_VARS inherited from the vitest worker can redirect the spawn into the parent worktree (the SMI-4693 leak). Migrate per the pattern in scripts/tests/session-priming-hook.test.ts. If the file legitimately needs raw process.env, add a \`// SMI-4693-EXEMPT: <reason>\` comment.`
      )
    }
  } catch (e) {
    warn(`Could not check fixture git env sanitisation: ${e.message}`)
  }
}

// 41. SMI-4758: realpath-asymmetry path-comparison detector. Backstops the
// SMI-4688/SMI-4692 anti-pattern (caught by PR #920) — comparing two paths
// where one operand is `fs.realpath`'d and the other is `path.resolve`'d
// silently fails on macOS (`/var/folders` ↔ `/private/var/folders`) but
// passes on Linux. Heuristic regex-based detector; suppression via
// `// audit-allow:realpath-asymmetry — <reason>` comment.
//
// SMI-6192: factored into a standalone function (previously inline top-level
// code) and try/catch-wrapped, matching Checks 2/3/4 above — this was
// previously the only unguarded getFilesRecursive('packages', ...) caller
// among the source-scanning checks, so a filesystem error (e.g. the live
// ENOENT observed when a file disappears between getFilesRecursive's own
// readdirSync listing it and a subsequent statSync call — see the plan doc's
// Root Cause section) crashed the entire `npm run audit:standards` process
// instead of degrading to a fail() line. The standalone-function shape also
// lets it be registered in CHECK_REGISTRY above as a narrow `--only
// realpath-asymmetry` entry point for testing the real production code.
function runRealpathAsymmetryCheck() {
  console.log(`\n${BOLD}41. Realpath-Asymmetry Path Comparison (SMI-4758)${RESET}`)
  try {
    const sourceFiles = getFilesRecursive('packages', ['.ts', '.tsx', '.mts', '.cts']).filter(
      (f) =>
        !f.includes('/node_modules/') &&
        !f.includes('/dist/') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.tsx') &&
        !f.endsWith('.spec.ts') &&
        !f.endsWith('.spec.tsx') &&
        !f.endsWith('.d.ts')
    )
    const allViolations = []
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8')
      const { violations } = findRealpathAsymmetry(content, file)
      for (const v of violations) {
        allViolations.push({ file, ...v })
      }
    }
    if (allViolations.length === 0) {
      pass(`No realpath-asymmetry path comparisons found (${sourceFiles.length} files scanned)`)
      return true
    }
    const formatted = allViolations
      .map(
        (v) =>
          `  ${v.file}:${v.line} — '${v.lhs}.${v.op}(${v.rhs}...)' (one side realpath'd, other path.resolve'd)`
      )
      .join('\n')
    fail(
      `${allViolations.length} realpath-asymmetry comparison(s) detected:\n${formatted}`,
      'Realpath both sides — `const Yreal = await fs.realpath(Y).catch(() => Y); X.startsWith(Yreal + sep)` — OR add `// audit-allow:realpath-asymmetry — <reason>` on the line above to suppress.'
    )
    return false
  } catch (e) {
    fail(`Error checking realpath-asymmetry: ${e.message}`)
    return false
  }
}
runRealpathAsymmetryCheck()

// 42. SMI-4758: GitHub Actions `uses:` SHA-pin invariant. Repo convention is
// `<owner>/<repo>(/<path>)?@<40-hex-sha> # <human-tag>`. Floating tag refs
// (e.g. `actions/setup-node@v6`) silently absorb upstream tag-pointer
// rewrites — a supply-chain risk. Inline-fixed for `wasm-env-snapshot.yml`
// in PR #975 commit 06267d27; this check prevents the next instance.
// Uses `fail()` (not `warn()` like Check 37) — security invariant, not style.
console.log(`\n${BOLD}42. Workflow uses: SHA-Pin (SMI-4758)${RESET}`)
{
  const workflowDir = '.github/workflows'
  if (!existsSync(workflowDir)) {
    pass('Skipped (no .github/workflows/ directory)')
  } else {
    const workflowFiles = readdirSync(workflowDir).filter(
      (f) => f.endsWith('.yml') || f.endsWith('.yaml')
    )
    const allViolations = []
    for (const file of workflowFiles) {
      const fullPath = join(workflowDir, file)
      const content = readFileSync(fullPath, 'utf8')
      const violations = findUnpinnedActionUses(content, fullPath)
      for (const v of violations) {
        allViolations.push({ file: fullPath, ...v })
      }
    }
    if (allViolations.length === 0) {
      pass(
        `All ${workflowFiles.length} workflow file(s) SHA-pin every remote 'uses:' (skipping ./ and docker:// refs)`
      )
    } else {
      const formatted = allViolations
        .map((v) => `  ${v.file}:${v.line} — uses '${v.value}' (kind: ${v.kind})`)
        .join('\n')
      fail(
        `${allViolations.length} unpinned 'uses:' reference(s) detected:\n${formatted}`,
        'Replace the floating ref with the 40-hex commit SHA. Find it via: `gh api /repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha`. Canonical form: `<owner>/<repo>@<40-hex-sha> # <tag>`.'
      )
    }
  }
}

// 43. CHANGELOG [Unreleased] Placement (SMI-4776)
//
// In the v0.6.0 / v0.5.0 release on 2026-05-06, two of four CHANGELOGs (mcp-server
// + vscode-extension) had their `## [Unreleased]` block placed AFTER a `## v...`
// version heading. The release prep ran `--no-changelog --no-commit` and hand-
// curated the entries; the misplacement was subtle enough to slip past review.
//
// `[Unreleased]` MUST be the first heading after the introductory paragraph (i.e.
// before any versioned release section). Otherwise consumers reading the file
// top-to-bottom see a stale "current" section. Auto-generators that prepend
// new sections also break: prepending above the (misplaced) `[Unreleased]`
// orphans it inside an old release section.
console.log(`\n${BOLD}43. CHANGELOG [Unreleased] Placement (SMI-4776)${RESET}`)
{
  const pkgDirs = existsSync('packages')
    ? readdirSync('packages').filter((d) => existsSync(join('packages', d, 'package.json')))
    : []

  const targets = [
    { changelogPath: 'CHANGELOG.md', label: 'root' },
    ...pkgDirs.map((d) => ({
      changelogPath: join('packages', d, 'CHANGELOG.md'),
      label: `packages/${d}`,
    })),
  ]

  let placementIssues = 0
  let duplicateIssues = 0
  for (const { changelogPath, label } of targets) {
    if (!existsSync(changelogPath)) continue

    const content = readFileSync(changelogPath, 'utf8')

    // Find ALL h2 headings in order. Look for `## ` at the start of a line.
    // Capture both `[Unreleased]` and version forms (`## vX.Y.Z`, `## [X.Y.Z]`,
    // `## X.Y.Z`).
    const headingRegex = /^## (.+)$/gm
    const headings = []
    let match
    while ((match = headingRegex.exec(content)) !== null) {
      const text = match[1].trim()
      const isUnreleased = /^\[?Unreleased\]?$/i.test(text)
      const isVersion = /^\[?v?\d+\.\d+\.\d+\]?(\s|$)/.test(text)
      if (isUnreleased || isVersion) {
        headings.push({ text, isUnreleased, isVersion, index: match.index })
      }
    }

    if (headings.length === 0) continue

    // SMI-5845: assert exactly one `[Unreleased]` heading BEFORE the
    // firstVersionIdx/-1 guard below — a CHANGELOG with only [Unreleased]
    // headings and zero version headings (e.g. packages/doc-retrieval-mcp,
    // packages/skillsmith-cli) has firstVersionIdx === -1 and would `continue`
    // past this check entirely if it ran after that guard, exactly
    // reproducing the SMI-5845 root cause (a duplicate heading invisible to
    // the placement logic) for that file shape.
    const unreleasedLines = findUnreleasedHeadingLines(content)
    if (unreleasedLines.length > 1) {
      duplicateIssues++
      const [keepLine, ...dupeLines] = unreleasedLines
      fail(
        `${label}: found ${unreleasedLines.length} '## [Unreleased]' headings in ${changelogPath} (line ${keepLine}, plus duplicate(s) at line ${dupeLines.join(', ')}) — expected exactly one`,
        `Merge the content under the duplicate '## [Unreleased]' heading(s) at ${changelogPath}:${dupeLines.join(', ')} into their real version sections (or into line ${keepLine} if genuinely unreleased), then delete the duplicate heading(s)`
      )
    }

    const firstUnreleasedIdx = headings.findIndex((h) => h.isUnreleased)
    const firstVersionIdx = headings.findIndex((h) => h.isVersion)

    if (firstUnreleasedIdx === -1 || firstVersionIdx === -1) continue

    if (firstUnreleasedIdx > firstVersionIdx) {
      placementIssues++
      const offendingVersion = headings[firstVersionIdx].text
      // Convert char offsets to 1-indexed line numbers so operators can jump
      // straight to the misordered headings (SMI-4776 acceptance criterion).
      const versionLine = content.slice(0, headings[firstVersionIdx].index).split('\n').length
      const unreleasedLine = content.slice(0, headings[firstUnreleasedIdx].index).split('\n').length
      fail(
        `${label}: '## [Unreleased]' (${changelogPath}:${unreleasedLine}) is placed after '## ${offendingVersion}' (${changelogPath}:${versionLine})`,
        `Move the [Unreleased] section above the first ## v... heading in ${changelogPath}`
      )
    }
  }

  if (placementIssues === 0 && duplicateIssues === 0) {
    pass(
      'No CHANGELOG has more than one [Unreleased] heading, and placement is correct where present'
    )
  }
}

// SMI-4764 Wave 2 — Eval cron heartbeat freshness (advisory).
//
// Reads packages/doc-retrieval-mcp/eval/.cron-heartbeat (written by
// scripts/eval-baseline-cron.sh on each canonical-dev run) and emits a
// warning if the most recent timestamp is >14 days old. Intent: surface
// "canonical dev's cron stopped running" so the replacement protocol
// (.claude/development/eval-cron-setup.md) can be invoked.
//
// Skipped when the file doesn't exist — that's the pre-Wave-2-rollout
// state, not a regression.
console.log(`\n${BOLD}44. Eval Cron Heartbeat Freshness (SMI-4764 Wave 2)${RESET}`)
{
  const heartbeatPath = 'packages/doc-retrieval-mcp/eval/.cron-heartbeat'
  if (!existsSync(heartbeatPath)) {
    pass(
      `No .cron-heartbeat file present (canonical-dev cron not yet installed; see .claude/development/eval-cron-setup.md)`
    )
  } else {
    try {
      const content = readFileSync(heartbeatPath, 'utf8').trim()
      // Heartbeat format: <ISO-timestamp>\t<git-HEAD-sha>\t(OK|FAIL)
      // Take the last non-empty line — the file is overwritten on each
      // run today, but tolerate multi-line variants for forward-compat.
      const lines = content.split('\n').filter((l) => l.length > 0)
      if (lines.length === 0) {
        warn(
          `Eval cron heartbeat is empty — cron may have failed to write. See ~/.skillsmith/logs/eval-cron-*.log`
        )
      } else {
        const latest = lines[lines.length - 1]
        const [ts, _sha, status] = latest.split('\t')
        const parsedMs = Date.parse(ts)
        if (Number.isNaN(parsedMs)) {
          warn(
            `Eval cron heartbeat first column is not a valid ISO timestamp: "${ts}". Reset the file or rerun the cron.`
          )
        } else {
          const ageMs = Date.now() - parsedMs
          const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
          if (ageDays > 14) {
            warn(
              `Eval cron heartbeat is ${ageDays} days old (>14d threshold). Designate a replacement canonical dev or restart the cron — see .claude/development/eval-cron-setup.md §Replacement protocol.`
            )
          } else if (status === 'FAIL') {
            warn(
              `Eval cron most recent run reported FAIL (${ageDays}d ago). Inspect ~/.skillsmith/logs/eval-cron-*.log on the canonical dev's machine.`
            )
          } else {
            pass(`Eval cron heartbeat is ${ageDays} days old (status: ${status || 'unknown'})`)
          }
        }
      }
    } catch (e) {
      warn(`Could not read .cron-heartbeat: ${e.message}`)
    }
  }
}

// SMI-4764 Wave 3 — Eval baseline signature provenance (advisory).
//
// When packages/doc-retrieval-mcp/eval/baseline.json is modified in a PR diff
// (GITHUB_BASE_REF...HEAD when set, otherwise local working-tree diff against
// HEAD), compute its SHA-256 and look it up in the .signatures.log registry
// emitted by eval-runner-signatures.ts. Hash absent -> emit informational
// annotation prompting reviewers to verify the developer ran
// RETRIEVAL_EVAL_REAL=1 locally. Never fails CI; never bumps the global
// failure or warning counters. This is observability, not security; ed25519
// cryptographic signing is Wave 5.
//
// SMI-5708 Item #5(d) / plan-review finding H3: this is the SECOND, independent
// consumer of .signatures.log (the first is scripts/eval-baseline-validator.mjs's
// lookupSignatures()) — it does its own inline lookup rather than calling that
// function. When eval-baseline-validator.mjs gained a headSha-ancestor check
// (SMI-5708 Item #5(a)), this check would otherwise silently imply a STRONGER
// guarantee than it actually verifies (content-hash match only). To keep the
// two consumers' guarantees honest and in sync, this now performs the same
// ancestor-tolerant headSha check (see isEvalSignatureHeadShaAcceptable below)
// and annotates the weaker case distinctly, rather than reporting a plain
// "present" pass for a signature recorded against an unrelated commit.
//
// Mirrors scripts/eval-baseline-validator.mjs's isHeadShaAcceptable(): a
// signature's headSha is accepted if it IS the current git HEAD, or an
// ANCESTOR of it (not required to match exactly — SMI-2597 wave-branch-
// stacking routinely lands new commits on top of the one a signature was
// recorded against, and an exact-match requirement would false-flag a
// still-legitimately-fresh signature purely because later commits landed on
// the branch. This does NOT tolerate an actual rebase/amend, which produces
// a sibling commit rather than a descendant — correctly requiring a fresh
// signature there, per Codex review finding).
//
// Uses execFileSync (not this file's more common execSync string-
// interpolation pattern) because headSha comes from `.signatures.log`, a
// file a PR diff can influence — passing it through a shell string would be
// an avoidable command-injection surface. Fails closed: any git error
// (unresolvable sha, missing history, etc.) returns false, same as "not an
// ancestor" — never treated as a pass.
//
// Test coverage note (Opus review, Low): this function is a verbatim mirror
// of scripts/eval-baseline-validator.mjs's isHeadShaAcceptable() -- same git
// commands, same fail-closed semantics, same exact-match-then-ancestor
// logic. That function is already thoroughly proven correct via real git
// fixtures in scripts/tests/eval-baseline-validator.test.ts (exact match,
// true ancestor, non-ancestor, unresolvable-sha cases). Not duplicating a
// second fixture-repo test suite here for byte-for-byte identical logic --
// Check 45 is advisory-only (never fails CI, never bumps warn/fail
// counters), and this file has no existing git-fixture test harness of its
// own (its sibling scripts/tests/audit-standards*.test.ts files test pure
// string/parsing helpers only). If this function's logic ever diverges from
// its eval-baseline-validator.mjs counterpart, both should gain their own
// fixture coverage at that point.
function isEvalSignatureHeadShaAcceptable(candidateSha) {
  if (!candidateSha || candidateSha.trim().length === 0) return false
  let currentHead
  try {
    currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return false
  }
  if (candidateSha === currentHead) return true
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', candidateSha, currentHead], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

console.log(`\n${BOLD}45. Eval Baseline Signature Provenance (SMI-4764 Wave 3)${RESET}`)
{
  const baselinePath = 'packages/doc-retrieval-mcp/eval/baseline.json'
  const sigsPath = 'packages/doc-retrieval-mcp/eval/.signatures.log'
  let advisoryCount = 0
  if (!existsSync(sigsPath)) {
    pass(`No .signatures.log present (pre-Wave-3 backward-compat; provenance check inactive)`)
  } else {
    let changedFiles = []
    try {
      const baseRef = process.env.GITHUB_BASE_REF
      if (baseRef && baseRef.length > 0) {
        // PR context: diff between PR base and HEAD. origin/<base> is the
        // canonical reference actions/checkout fetches.
        const out = execSync(`git diff --name-only origin/${baseRef}...HEAD`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        changedFiles = out.split('\n').filter((l) => l.length > 0)
      } else {
        // Local run: stage + worktree diff vs HEAD covers both committed and
        // uncommitted edits the developer is about to push.
        const out = execSync('git diff --name-only HEAD', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        changedFiles = out.split('\n').filter((l) => l.length > 0)
      }
    } catch {
      // Diff failed (shallow clone, no HEAD, etc.) — silently skip; this is
      // observability and must not block.
      changedFiles = []
    }

    const baselineChanged = changedFiles.includes(baselinePath)
    if (!baselineChanged || !existsSync(baselinePath)) {
      pass('baseline.json unchanged in diff; provenance check skipped')
    } else {
      const baselineBytes = readFileSync(baselinePath)
      const sha = createHash('sha256').update(baselineBytes).digest('hex')
      const sigLines = readFileSync(sigsPath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
      // Actual layout (matches the writer, packages/doc-retrieval-mcp/eval/
      // eval-runner-signatures.ts): <sha256>\t<ISO-timestamp>\t<headSha>, sha
      // at index 0. (Opus review finding: an older version of this comment
      // claimed <ISO-timestamp>\t<sha256>\t<commit-sha-or-none> with sha at
      // index 1 -- that was already wrong before this change and contradicted
      // the correct layout note just below; corrected here rather than left
      // to drift further out of sync.)
      //
      // Collect ALL matching lines, not just the first (Codex review finding,
      // High): the same baseline.json content can legitimately be re-signed
      // more than once within the log's 15-line FIFO window (e.g. re-running
      // the eval after a commit that didn't change ranking/corpus/gold-set),
      // and an older entry's headSha could be stale/non-ancestor while a
      // later entry for the SAME content has a valid one. Checking only the
      // first match would let the older entry's staleness shadow the later,
      // valid signature.
      const matchingLines = sigLines.filter((line) => line.split('\t')[0] === sha)
      if (matchingLines.length > 0) {
        // Content-hash matched at least one entry. Also check headSha
        // ancestry (SMI-5708 Item #5(d) / H3) so this check doesn't imply a
        // stronger guarantee than eval-baseline-validator.mjs now provides
        // for the same log -- pass if ANY matching entry has an acceptable
        // headSha, not only the first.
        const recordedHeadShas = matchingLines.map((line) => line.split('\t')[2])
        const anyAcceptable = recordedHeadShas.some((headSha) =>
          isEvalSignatureHeadShaAcceptable(headSha)
        )
        if (anyAcceptable) {
          pass(
            `baseline.json sha256 ${sha.slice(0, 12)}… present in .signatures.log (headSha verified)`
          )
        } else {
          // Advisory: never fails CI, never bumps warn/fail counters.
          advisoryCount++
          console.log(
            `ℹ INFO: baseline.json sha256 ${sha.slice(0, 12)}… matches .signatures.log, but none of its recorded headSha(s) are the current HEAD or an ancestor of it; this can mean the signature(s) were recorded against an unrelated branch or a commit never merged into this history. Reviewer please verify the developer ran RETRIEVAL_EVAL_REAL=1 against this history before merging.`
          )
          console.log(
            `  recorded headSha(s): ${recordedHeadShas.map((h) => h || '(none)').join(', ')}`
          )
        }
      } else {
        // Advisory: never fails CI, never bumps warn/fail counters.
        advisoryCount++
        console.log(
          `ℹ INFO: baseline.json change has no matching signature in .signatures.log; reviewer please verify the developer ran RETRIEVAL_EVAL_REAL=1 locally before merging.`
        )
        console.log(`  computed sha256: ${sha}`)
        console.log(`  registry: ${sigsPath} (${sigLines.length} entries)`)
      }
    }
  }
  if (advisoryCount > 0) {
    console.log(`  (${advisoryCount} advisory annotation(s); not failing CI per SMI-4764 Wave 3)`)
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

// Check 55: Strategy submodule pointer-on-tip-of-declared-branch
// Pre-cutover: .gitmodules has no strategy submodule entries → no-op (pass).
// Post-cutover (shape b′): three strategy submodule entries, each pinned to
// its own branch (`skills`, `plans`, `hive-mind`) within smith-horn/skillsmith-strategy.
// Verify each pointer matches the tip of the declared branch (not main).
// Severity: warn for first 30 days post-cutover, then promote to fail
// (Open Q#3 decision, SMI-4829 implementation plan).
// "strategy" submodule = any submodule URL containing "skillsmith-strategy".
// Each [submodule] block must include `branch = <name>` (per shape b′ topology).
console.log(`\n${BOLD}Check 55: Strategy submodule pointer-on-tip${RESET}`)
{
  let gitmodules = ''
  try {
    gitmodules = readFileSync('.gitmodules', 'utf8')
  } catch {
    pass('Check 55: .gitmodules not found — skipped (pre-cutover)')
    gitmodules = null
  }
  if (gitmodules !== null) {
    // Parse all [submodule] blocks to find strategy entries (path, url, branch)
    const strategyEntries = []
    let curPath = null
    let curUrl = null
    let curBranch = null
    const flush = () => {
      if (curPath && curUrl && curUrl.includes('skillsmith-strategy')) {
        strategyEntries.push({ path: curPath, url: curUrl, branch: curBranch })
      }
      curPath = null
      curUrl = null
      curBranch = null
    }
    for (const line of gitmodules.split('\n')) {
      if (line.match(/^\[submodule/)) {
        flush()
        continue
      }
      const pathMatch = line.match(/^\s*path\s*=\s*(.+)/)
      const urlMatch = line.match(/^\s*url\s*=\s*(.+)/)
      const branchMatch = line.match(/^\s*branch\s*=\s*(.+)/)
      if (pathMatch) curPath = pathMatch[1].trim()
      if (urlMatch) curUrl = urlMatch[1].trim()
      if (branchMatch) curBranch = branchMatch[1].trim()
    }
    flush()

    if (strategyEntries.length === 0) {
      pass('Check 55: No strategy submodules in .gitmodules — no-op (pre-cutover)')
    } else {
      // Validate path/branch chars before shell interpolation (SMI-4829 governance retro P1).
      // .gitmodules is version-controlled but a contributor with write access could otherwise
      // smuggle shell metacharacters via subPath/branch into the execSync calls below.
      const SAFE_TOKEN = /^[A-Za-z0-9._\-/]+$/
      for (const { path: subPath, branch } of strategyEntries) {
        if (!branch) {
          warn(
            `Check 55: Strategy submodule '${subPath}' missing 'branch = ' declaration in .gitmodules (shape b′ requires per-branch pinning)`,
            'Add `branch = <skills|plans|hive-mind>` to the [submodule "' + subPath + '"] block'
          )
          continue
        }
        if (!SAFE_TOKEN.test(subPath) || !SAFE_TOKEN.test(branch)) {
          warn(
            `Check 55: Strategy submodule '${subPath}' has unsafe characters in path or branch '${branch}' — refusing to shell out`,
            'Verify .gitmodules manually; only [A-Za-z0-9._-/] permitted in path/branch tokens'
          )
          continue
        }
        try {
          // Local pointer SHA from the parent repo's index
          const localSha = execSync(`git ls-files -s "${subPath}"`, { encoding: 'utf8' })
            .trim()
            .split(/\s+/)[1]
          // Remote tip of the DECLARED branch (not main).
          // subPath/branch validated above; .gitmodules subshell expansion is safe because
          // the submodule URL lookup uses git's own parser, not shell metacharacters.
          // SMI-5080: capture stderr so the `fatal: ...` lines from a failing
          // ls-remote (e.g. SSL handshake failure in slim Docker images) do
          // not leak to console — the catch block below classifies the error.
          const remoteSha = execSync(
            `git ls-remote "$(git config --file .gitmodules "submodule.${subPath}.url")" "${branch}"`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
          )
            .trim()
            .split(/\s+/)[0]
          if (!localSha || !remoteSha) {
            warn(
              `Check 55: Could not resolve SHAs for strategy submodule '${subPath}' (branch=${branch}) — skipping`,
              'Ensure the submodule is initialized and the remote branch exists'
            )
          } else if (localSha !== remoteSha) {
            warn(
              `Check 55: Strategy submodule '${subPath}' pointer (${localSha.slice(0, 8)}) is behind remote ${branch} tip (${remoteSha.slice(0, 8)})`,
              `Run: git submodule update --remote ${subPath} && git add ${subPath} && git commit -m 'chore: bump strategy submodule ${subPath} to ${branch} tip'`
            )
          } else {
            pass(`Check 55: Strategy submodule '${subPath}' pointer is at remote ${branch} tip`)
          }
        } catch (e) {
          // SMI-5080: in Docker containers without ca-certificates installed (e.g.
          // node:22-slim base image), `git ls-remote` fails on HTTPS submodule
          // URLs with a certificate-verification error. The daily-cron / host
          // audit run still catches real submodule drift; the Docker run is
          // structurally unable to make this check, so degrade SSL/network
          // failures to a clean `pass('Skipped ...')` (matches main check 23's
          // (Implementation Completeness) skip-as-pass idiom) instead of
          // emitting a misleading WARN.
          const msg = String(e?.message || '')
          const isNetworkUnavailable =
            /certificate verification failed|unable to access|Could not resolve host|Connection refused|Operation timed out|ssl/i.test(
              msg
            )
          if (isNetworkUnavailable) {
            pass(
              `Check 55 skipped for '${subPath}' (branch=${branch}) — SSL/network unavailable in this environment`
            )
          } else {
            warn(
              `Check 55: Could not check strategy submodule '${subPath}' (branch=${branch}) tip: ${e.message}`,
              'Ensure remote is reachable and submodule is initialized'
            )
          }
        }
      }
    }
  }
}

// (Check 22 removed in SMI-4829 cutover — sparse-checkout cone mode cannot
// strip upstream path prefixes, so the prior shape (b) approach was abandoned
// in favor of shape (b′): one branch per mount-point with content at root.
// Replaced with per-branch pointer verification in Check 55.)

// Check 56: `git config --file <path>` subshell-out-of-cwd discipline
// From a worktree path inside a Linux Docker container, `git config --file <abs-path>`
// STILL walks cwd to evaluate `[includeIf "gitdir:..."]` directives. A stale .git
// file (e.g. worktree imported from another host with an invalid gitdir pointer)
// makes git exit 128 silently — turning the result into "no submodules" with no
// error output. The fix is to subshell into / before calling git config --file.
// Same RCA class as SMI-4699 + SMI-4693. Surfaced in Wave 2A commit c61d06e6.
//
// Exempt marker: add `# audit-standards-check-56-exempt: <reason>` in the same line
// or the 3 lines above the `git config --file` call.
// Severity: fail (this is a real bug in any affected call-site today, not a future concern).
console.log(`\n${BOLD}Check 56: git config --file subshell discipline${RESET}`)
{
  const dirsToScan = ['scripts', '.husky']
  // Shell comment prefixes: lines starting with # (after trimming) are documentation,
  // not executable invocations. Also exclude the audit script itself (it contains
  // the pattern in strings and comments for reporting purposes).
  const SELF = 'scripts/audit-standards.mjs'
  const violations = []
  for (const dir of dirsToScan) {
    if (!existsSync(dir)) continue
    const files = getFilesRecursive(dir, ['.sh', '.bash', '.zsh', '.mjs', '.js', ''])
    for (const file of files) {
      // Skip self — this file contains the pattern in string literals and comments
      if (file === SELF || file.endsWith('/audit-standards.mjs')) continue
      let content
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        // Skip pure comment lines (shell: starts with #; JS/TS: starts with //)
        if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue
        if (!trimmed.includes('git config --file')) continue
        const lineNum = i + 1
        // Check for subshell pattern on the same line: (cd / && git config --file ...)
        const hasSubshell = lines[i].includes('(cd /')
        // Check for exempt marker in the current line or up to 3 lines above
        const windowLines = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
        const hasExempt = windowLines.includes('# audit-standards-check-56-exempt:')
        if (!hasSubshell && !hasExempt) {
          violations.push(`${file}:${lineNum}: ${trimmed}`)
        }
      }
    }
  }
  if (violations.length === 0) {
    pass(
      'Check 56: All `git config --file` calls in scripts/ and .husky/ use subshell-out-of-cwd or have exempt marker'
    )
  } else {
    for (const v of violations) {
      fail(
        `Check 56: Bare \`git config --file\` without subshell: ${v}`,
        'Wrap as: (cd / && git config --file ...) — see scripts/_lib.sh enumerate_submodules() for the canonical pattern. Or add `# audit-standards-check-56-exempt: <reason>` if subshelling is genuinely impossible.'
      )
    }
  }
}

// Check 57: No internal references in rendered published website content (SMI-4916)
//
// Internal Linear issue IDs (SMI-NNN), ADR numbers (ADR-NNN), and private doc
// paths (docs/internal/) are engineering jargon and must never reach end users.
// This check scans rendered website content — .astro pages and blog markdown —
// and fails the build if such a reference appears in user-visible text.
//
// Non-rendered regions are stripped before matching so legitimate internal refs
// in frontmatter, comments, and <style>/<script> blocks stay legal:
//   - .astro: frontmatter fence (--- … ---), <!-- … -->, {/* … */} JSX comments,
//     and entire <style>…</style> / <script>…</script> blocks. Inside the
//     frontmatter fence ONLY, // line comments and /* … */ block comments are
//     also stripped. In the template body, // and /* */ are literal rendered
//     text and are NOT stripped.
//   - .md/.mdx: <!-- … --> only. Fenced code blocks are rendered and kept.
// A line carrying the marker `audit:internal-ref-ok` (matched on the raw line
// before stripping) is skipped, for the rare case a page must legitimately name
// a reference.
console.log(
  `\n${BOLD}Check 57: No internal references in rendered website content (SMI-4916)${RESET}`
)

// Apply a stripping regex repeatedly until the text stabilizes. A single
// .replace() pass can leave a partial delimiter behind when matches overlap
// (e.g. `<!--<!---->`), which CodeQL flags as incomplete multi-character
// sanitization (js/incomplete-multi-character-sanitization).
function stripUntilStable(text, regex) {
  let prev
  do {
    prev = text
    text = text.replace(regex, '')
  } while (text !== prev)
  return text
}

function stripAstroNonRendered(content) {
  const rawLines = content.split('\n')
  const out = []
  let inFrontmatter = false
  let frontmatterDone = false
  let inStyleOrScript = false
  let inOpeningTag = false // <style/<script seen, > not yet found
  let inHtmlComment = false
  let inJsxComment = false
  let jsxBracePending = false // a line ended with a bare `{` — a `/*` next opens a JSX comment
  let inBlockComment = false // /* */ inside frontmatter only

  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i]

    // Frontmatter fence: a leading `---` on the first non-empty line opens it.
    if (!frontmatterDone && !inFrontmatter && line.trim() === '---') {
      inFrontmatter = true
      out.push('')
      continue
    }
    if (inFrontmatter) {
      if (line.trim() === '---') {
        inFrontmatter = false
        frontmatterDone = true
        out.push('')
        continue
      }
      // Inside frontmatter: strip // line comments and /* */ block comments.
      if (inBlockComment) {
        const end = line.indexOf('*/')
        if (end === -1) {
          out.push('')
          continue
        }
        line = line.slice(end + 2)
        inBlockComment = false
      }
      line = line.replace(/\/\*[\s\S]*?\*\//g, '')
      const openBlock = line.indexOf('/*')
      if (openBlock !== -1) {
        line = line.slice(0, openBlock)
        inBlockComment = true
      }
      line = line.replace(/\/\/.*$/, '')
      out.push(line)
      continue
    }

    frontmatterDone = true

    // Multi-line HTML comment continuation.
    if (inHtmlComment) {
      const end = line.indexOf('-->')
      if (end === -1) {
        out.push('')
        continue
      }
      line = line.slice(end + 3)
      inHtmlComment = false
    }
    // Multi-line JSX comment continuation.
    if (inJsxComment) {
      const end = line.indexOf('*/}')
      if (end === -1) {
        out.push('')
        continue
      }
      line = line.slice(end + 3)
      inJsxComment = false
    }
    // A prior line ended with a bare `{`; if this line opens with `/*` (after
    // optional whitespace) it is a JSX comment whose opener was split.
    if (jsxBracePending) {
      jsxBracePending = false
      const m = line.match(/^\s*\/\*/)
      if (m) {
        const end = line.indexOf('*/}')
        if (end === -1) {
          inJsxComment = true
          out.push('')
          continue
        }
        line = line.slice(end + 3)
      }
    }
    // Multi-line opening tag continuation: <style/<script seen, > not yet found.
    if (inOpeningTag) {
      const gt = line.indexOf('>')
      if (gt === -1) {
        out.push('')
        continue
      }
      line = line.slice(gt + 1)
      inOpeningTag = false
      inStyleOrScript = true
    }
    // Multi-line <style>/<script> body continuation.
    if (inStyleOrScript) {
      const end = line.search(/<\/(style|script)\b[^>]*>/i)
      if (end === -1) {
        out.push('')
        continue
      }
      line = line.slice(line.indexOf('>', end) + 1)
      inStyleOrScript = false
    }

    // Strip single-line HTML comments, then detect an unterminated one.
    line = stripUntilStable(line, /<!--[\s\S]*?-->/g)
    const openHtml = line.indexOf('<!--')
    if (openHtml !== -1) {
      line = line.slice(0, openHtml)
      inHtmlComment = true
    }
    // Strip single-line JSX comments, then detect an unterminated one.
    line = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    const openJsx = line.indexOf('{/*')
    if (openJsx !== -1) {
      line = line.slice(0, openJsx)
      inJsxComment = true
    }
    // Strip single-line <style>/<script> blocks, then detect an open one.
    line = stripUntilStable(line, /<(style|script)\b[^>]*>[\s\S]*?<\/(style|script)\b[^>]*>/gi)
    const styleScriptOpen = line.search(/<(style|script)\b/i)
    if (styleScriptOpen !== -1) {
      const gt = line.indexOf('>', styleScriptOpen)
      line = line.slice(0, styleScriptOpen)
      if (gt === -1) {
        inOpeningTag = true // `>` is on a later line
      } else {
        inStyleOrScript = true
      }
    }

    // A line whose remaining content ends with a bare `{` may open a JSX
    // comment on the next line (Astro allows whitespace between `{` and `/*`).
    if (/\{\s*$/.test(line)) {
      jsxBracePending = true
    }

    out.push(line)
  }
  return out
}

function stripMdNonRendered(content) {
  const rawLines = content.split('\n')
  const out = []
  let inHtmlComment = false
  for (let line of rawLines) {
    if (inHtmlComment) {
      const end = line.indexOf('-->')
      if (end === -1) {
        out.push('')
        continue
      }
      line = line.slice(end + 3)
      inHtmlComment = false
    }
    line = stripUntilStable(line, /<!--[\s\S]*?-->/g)
    const openHtml = line.indexOf('<!--')
    if (openHtml !== -1) {
      line = line.slice(0, openHtml)
      inHtmlComment = true
    }
    out.push(line)
  }
  return out
}

const INTERNAL_REF_PATTERN = /\bSMI-\d+\b|\bADR-\d+\b|docs\/internal\//
const internalRefPagesDir = 'packages/website/src/pages'
const internalRefBlogDir = 'packages/website/src/content/blog'

if (!existsSync(internalRefPagesDir) && !existsSync(internalRefBlogDir)) {
  warn('Check 57: Website pages/blog directories not found - skipping internal-ref check')
} else {
  const internalRefHits = []
  const astroFilesForRefCheck = existsSync(internalRefPagesDir)
    ? getFilesRecursive(internalRefPagesDir, ['.astro'])
    : []
  const mdFilesForRefCheck = existsSync(internalRefBlogDir)
    ? getFilesRecursive(internalRefBlogDir, ['.md', '.mdx'])
    : []

  for (const file of astroFilesForRefCheck) {
    const content = readFileSync(file, 'utf8')
    const rawLines = content.split('\n')
    const strippedLines = stripAstroNonRendered(content)
    for (let i = 0; i < strippedLines.length; i++) {
      if (rawLines[i] && rawLines[i].includes('audit:internal-ref-ok')) continue
      const match = strippedLines[i].match(INTERNAL_REF_PATTERN)
      if (match) {
        internalRefHits.push({ file: relative('.', file), line: i + 1, match: match[0] })
      }
    }
  }
  for (const file of mdFilesForRefCheck) {
    const content = readFileSync(file, 'utf8')
    const rawLines = content.split('\n')
    const strippedLines = stripMdNonRendered(content)
    for (let i = 0; i < strippedLines.length; i++) {
      if (rawLines[i] && rawLines[i].includes('audit:internal-ref-ok')) continue
      const match = strippedLines[i].match(INTERNAL_REF_PATTERN)
      if (match) {
        internalRefHits.push({ file: relative('.', file), line: i + 1, match: match[0] })
      }
    }
  }

  if (internalRefHits.length === 0) {
    pass('Check 57: No internal references (SMI-/ADR-/docs/internal/) in rendered website content')
  } else {
    fail(
      `Check 57: ${internalRefHits.length} internal reference(s) found in rendered website content`,
      'Reword to drop the internal ref (Linear ID, ADR number, or docs/internal/ path). For a legitimate exception, add an `audit:internal-ref-ok` marker on that line.'
    )
    internalRefHits.forEach(({ file, line, match }) =>
      console.log(`    ${file}:${line} — ${match}`)
    )
  }
}

// 46. Skills-recreate migration FK-cascade guard (SMI-4925)
//
// Background: SQLite fires ON DELETE CASCADE actions immediately when
// `foreign_keys = ON` (the driver default). Any migration that recreates the
// `skills` table via DROP TABLE + RENAME therefore silently deletes all rows
// in every child table that holds a hard `skill_id REFERENCES skills(id)
// ON DELETE CASCADE`. As of schema-sql.ts, `skill_categories` is the ONLY
// such child; `skill_versions`, `skill_advisories`, `skill_co_installs`,
// `skill_dependencies`, and `risk_score_history` all use soft `skill_id TEXT`
// columns with no FK and are unaffected.
//
// SMI-4919 introduced the conforming pattern in v17: back `skill_categories`
// up into `_skill_categories_backup` (TEMP table) BEFORE `DROP TABLE skills`,
// then restore it AFTER the RENAME — all inside one BEGIN/COMMIT.
//
// v16 performed the same recreate WITHOUT the guard; it is allow-listed here
// because fixing it retroactively (fix-forward) is intentional — re-applying
// v16 on an existing DB would still trigger the cascade on the old schema where
// `skill_categories` may be empty, and the migration is already deployed.
//
// EXTEND THIS CHECK if a new ON DELETE CASCADE child of `skills` is added to
// schema-sql.ts: update the helper regex in audit-standards-helpers.mjs to
// require backup/restore pairs for the new child table as well.
console.log(`\n${BOLD}46. Skills-recreate migration FK-cascade guard (SMI-4925)${RESET}`)
{
  const coreMigrationsDir = 'packages/core/src/db/migrations'
  if (!existsSync(coreMigrationsDir)) {
    pass('No core migrations dir — skipping skills-recreate FK-cascade guard')
  } else {
    try {
      const migrationFiles = readdirSync(coreMigrationsDir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(coreMigrationsDir, f))
      const migrationsByPath = {}
      for (const f of migrationFiles) migrationsByPath[f] = readFileSync(f, 'utf8')
      const violations = findUnsafeSkillsRecreateMigrations(migrationsByPath, {
        // v16 recreates skills without the guard; allow-listed as fix-forward
        // (the migration is already deployed and retroactive patching is not
        // needed — v17 introduced the conforming backup/restore pattern).
        allowList: ['v16-skill-source.ts'],
      })
      const recreateCount = Object.entries(migrationsByPath).filter(([, src]) =>
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?skills\b/i.test(src)
      ).length
      if (violations.length === 0) {
        pass(
          `Skills-recreate FK-cascade guard: ${recreateCount} recreate migration(s) scanned — all safe or allow-listed`
        )
      } else {
        for (const v of violations) {
          fail(
            `Skills-recreate FK-cascade guard: ${v.file} — ${v.reason}`,
            'Follow the v17 RECREATE_TABLE_SQL pattern in ' +
              'packages/core/src/db/migrations/v17-curated-trust-tier.ts: ' +
              'add `DROP TABLE IF EXISTS _skill_categories_backup; ' +
              'CREATE TEMP TABLE _skill_categories_backup AS SELECT * FROM skill_categories;` ' +
              'BEFORE `DROP TABLE skills`, and ' +
              '`INSERT INTO skill_categories SELECT * FROM _skill_categories_backup; ' +
              'DROP TABLE _skill_categories_backup;` AFTER the RENAME. ' +
              '`skill_categories` is the only ON DELETE CASCADE child of `skills` ' +
              'per packages/core/src/db/schema-sql.ts — re-check that file if a new cascade child is added.'
          )
        }
      }
    } catch (e) {
      warn(`Could not check skills-recreate FK-cascade guard: ${e.message}`)
    }
  }
}

// 47. SMI-4963 retro Lesson 1: Edge-function multi-script registration coherence
//
// Adding a new edge function requires four coordinated edits:
//   1. supabase/functions/<name>/index.ts (the function itself)
//   2. scripts/deploy-edge-functions.sh — append to NO_VERIFY_JWT_FUNCTIONS xor
//      VERIFY_JWT_FUNCTIONS (controls the --no-verify-jwt deploy flag)
//   3. scripts/validate-edge-functions.sh — append to ANONYMOUS xor
//      AUTHENTICATED xor SERVICE_ROLE (encodes the runtime auth model)
//   4. supabase/config.toml — [functions.<name>] verify_jwt = false iff (2)
//      placed it in NO_VERIFY_JWT_FUNCTIONS (Check 10 already covers config
//      and CLAUDE.md surfaces; this check closes the gap on the two shell
//      scripts and cross-validates against config.toml)
//
// PR #1213 silently broke main's deploy workflow for ~50 min by registering
// coverage-report in the validate script but forgetting the deploy script.
// This check enforces both registrations and the config.toml predicate.
//
// IMPORTANT — the two script taxonomies are ORTHOGONAL:
//   - deploy-edge-functions.sh tracks the `--no-verify-jwt` deploy FLAG
//   - validate-edge-functions.sh tracks the runtime AUTH MODEL
// A function may legitimately be NO_VERIFY (anonymous deploy) AND SERVICE_ROLE
// (validates its own service-role bearer internally), or NO_VERIFY AND
// AUTHENTICATED (internal JWT validation in handler) — see Check 10's
// `NO_VERIFY_JWT_FUNCTIONS` rationale comments. This check enforces per-script
// presence and the NO_VERIFY → config.toml link, NOT cross-script consistency.
console.log(`\n${BOLD}47. Edge-function registration coherence (SMI-4963)${RESET}`)
{
  const FUNCTIONS_DIR = 'supabase/functions'
  const DEPLOY_SCRIPT = 'scripts/deploy-edge-functions.sh'
  const VALIDATE_SCRIPT = 'scripts/validate-edge-functions.sh'
  const CONFIG_TOML = 'supabase/config.toml'

  // SMI-5003: predicate 4 (test-neighbor) suppression list. Each entry has
  // a corresponding test backfill tracked by SMI-5011; entries are removed
  // only after the test file lands. New deployable functions fail-fast —
  // the allowlist is not extensible (CI will reject new entries via a
  // future audit guard or code review).
  const TEST_BACKFILL_ALLOWLIST = new Set([
    // SMI-5866: alert-notify's index.test.ts landed (HTML-escaping regression
    // coverage) — removed per this allowlist's own "entries are removed only
    // after the test file lands" convention.
    // SMI-6079: expire-complimentary's index.test.ts already existed (from
    // an earlier SMI) — this entry was stale and has been removed.
    'checkout',
    'contact-submit',
    'coverage-report',
    'create-portal-session',
    'early-access-signup',
    'email-inbound',
    'generate-license',
    'health',
    'list-invoices',
    'ops-report',
    'quota-monitor',
    'regenerate-license',
    'skills-outreach',
    'skills-outreach-preferences',
    'skills-recommend',
    'skills-refresh-metadata',
    'stats',
    'stripe-webhook',
    'update-seat-count',
  ])

  if (
    !existsSync(FUNCTIONS_DIR) ||
    !existsSync(DEPLOY_SCRIPT) ||
    !existsSync(VALIDATE_SCRIPT) ||
    !existsSync(CONFIG_TOML)
  ) {
    warn('Check 47: required file(s) missing — skipping registration-coherence check')
  } else {
    try {
      // Walk dirs with index.ts (validate-edge-functions.sh:79 idiom — _shared/
      // has no index.ts so is excluded by the file-existence filter alone).
      const deployableFns = readdirSync(FUNCTIONS_DIR)
        .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
        .filter((name) => {
          try {
            return (
              statSync(join(FUNCTIONS_DIR, name)).isDirectory() &&
              existsSync(join(FUNCTIONS_DIR, name, 'index.ts'))
            )
          } catch {
            return false
          }
        })
        .sort()

      // parseBashArray is imported from audit-standards-helpers.mjs (Check 47,
      // SMI-4963). Exported there so it can be unit-tested via vitest.

      const deploySrc = readFileSync(DEPLOY_SCRIPT, 'utf8')
      const validateSrc = readFileSync(VALIDATE_SCRIPT, 'utf8')
      const configSrc = readFileSync(CONFIG_TOML, 'utf8')

      const noVerifyDeploy = parseBashArray(deploySrc, 'NO_VERIFY_JWT_FUNCTIONS')
      const verifyDeploy = parseBashArray(deploySrc, 'VERIFY_JWT_FUNCTIONS')
      const anonValidate = parseBashArray(validateSrc, 'ANONYMOUS_FUNCTIONS')
      const authValidate = parseBashArray(validateSrc, 'AUTHENTICATED_FUNCTIONS')
      const serviceValidate = parseBashArray(validateSrc, 'SERVICE_ROLE_FUNCTIONS')

      if (!noVerifyDeploy || !verifyDeploy || !anonValidate || !authValidate || !serviceValidate) {
        warn(
          'Check 47: could not parse one or more bash arrays — verify the ' +
            'NAME=(\\n...\\n) shape in scripts/{deploy,validate}-edge-functions.sh ' +
            'has not changed'
        )
      } else {
        // Parse config.toml for [functions.<name>] verify_jwt = false blocks.
        // Uses [^\[]*? so that any keys between the section header and
        // verify_jwt (e.g. future service_role or timeout settings) are tolerated
        // without causing a false-negative. Stops before the next section header.
        const configNoVerify = new Set()
        const configRe = /\[functions\.([a-z0-9_-]+)\][^\[]*?verify_jwt\s*=\s*false/gis
        let cMatch
        while ((cMatch = configRe.exec(configSrc)) !== null) {
          configNoVerify.add(cMatch[1])
        }

        const deployableFnsSet = new Set(deployableFns)
        const failures = []

        // SMI-5004 predicate 5: @consumers tag in supabase/functions/_shared/auth.ts
        // must equal the grep-derived consumer set across supabase/functions/.
        // See: docs/internal/implementation/smi-5004-consumer-sync.md
        // Pure Node (no child_process): readdirSync + readFileSync + String.includes.
        const AUTH_PATH = join(FUNCTIONS_DIR, '_shared/auth.ts')
        // SMI-5004: predicate 5 reads content from supabase/functions/**, which
        // is git-crypt encrypted. In CI jobs that check out without the
        // git-crypt key (e.g. the `code-review` job in ci.yml — `quality-checks`
        // unlocks first, code-review does not), `_shared/auth.ts` is the
        // ciphertext blob starting with \x00GITCRYPT. The @consumers regex
        // would then fail-to-match and falsely fire "missing tag". Skip the
        // predicate in that case — quality-checks already enforces it.
        // Sentinel pattern mirrors vitest.config.root-tests.ts:gitCryptLocked.
        const gitCryptLocked = existsSync(AUTH_PATH) && isGitCryptEncrypted(AUTH_PATH)
        if (!existsSync(AUTH_PATH)) {
          warn(
            'Check 47 predicate 5: supabase/functions/_shared/auth.ts ' +
              'missing — skipping consumer-sync'
          )
        } else if (gitCryptLocked) {
          warn(
            'Check 47 predicate 5: supabase/functions/** is git-crypt ' +
              'locked here — skipping consumer-sync (quality-checks job ' +
              'enforces it after unlock)'
          )
        } else {
          const authSrc = readFileSync(AUTH_PATH, 'utf-8')
          const parsedConsumers = parseConsumersTag(authSrc)

          // Compute the actual consumer set from the function tree.
          // Excludes underscore- and dot-prefixed dirs (helper hosts, hidden).
          const actualConsumers = new Set()
          for (const name of readdirSync(FUNCTIONS_DIR)) {
            if (name.startsWith('_') || name.startsWith('.')) continue
            const idxPath = join(FUNCTIONS_DIR, name, 'index.ts')
            if (!existsSync(idxPath)) continue
            const idxSrc = readFileSync(idxPath, 'utf-8')
            if (idxSrc.includes('isServiceRoleCaller(')) actualConsumers.add(name)
          }

          if (parsedConsumers === null) {
            failures.push({
              fn: '@consumers',
              problems: [
                `  - supabase/functions/_shared/auth.ts @consumers tag has ` +
                  `an invalid token (must match /^[a-z0-9][a-z0-9-]*$/, ` +
                  `comma-separated, alphabetical). Expected: ` +
                  `\`* @consumers ${[...actualConsumers].sort().join(', ')}\`.`,
              ],
            })
          } else if (!parsedConsumers.found) {
            failures.push({
              fn: '@consumers',
              problems: [
                `  - supabase/functions/_shared/auth.ts is missing the ` +
                  `@consumers tag. Add: ` +
                  `\`* @consumers ${[...actualConsumers].sort().join(', ')}\` ` +
                  `to the top JSDoc block.`,
              ],
            })
          } else {
            const headerSet = new Set(parsedConsumers.names)
            const missing = [...actualConsumers].filter((n) => !headerSet.has(n))
            const extra = [...headerSet].filter((n) => !actualConsumers.has(n))
            for (const fn of missing.sort()) {
              failures.push({
                fn,
                problems: [
                  `  - supabase/functions/${fn}/index.ts calls ` +
                    `isServiceRoleCaller(...) but is not declared in ` +
                    `supabase/functions/_shared/auth.ts @consumers tag. Add ` +
                    `'${fn}' to the @consumers line (alphabetical, ` +
                    `comma-separated).`,
                ],
              })
            }
            for (const fn of extra.sort()) {
              failures.push({
                fn: '@consumers',
                problems: [
                  `  - supabase/functions/_shared/auth.ts @consumers ` +
                    `declares '${fn}', but no isServiceRoleCaller( call ` +
                    `found in supabase/functions/${fn}/index.ts. Remove ` +
                    `from @consumers or restore the helper call.`,
                ],
              })
            }
            if (!parsedConsumers.sorted) {
              failures.push({
                fn: '@consumers',
                problems: [
                  `  - supabase/functions/_shared/auth.ts @consumers list ` +
                    `is not alphabetically sorted. Expected: ` +
                    `${[...parsedConsumers.names].sort().join(', ')}. Got: ` +
                    `${parsedConsumers.names.join(', ')}.`,
                ],
              })
            }
          }
        }

        // Reverse direction: entries in deploy/validate arrays that have no
        // corresponding supabase/functions/<name>/index.ts. A typo in an array
        // entry (e.g. 'foobar' when the dir is 'foo-bar') would otherwise be
        // invisible — the forward-direction loop only iterates deployableFns.
        const allArrayEntries = new Set([
          ...noVerifyDeploy,
          ...verifyDeploy,
          ...anonValidate,
          ...authValidate,
          ...serviceValidate,
        ])
        for (const entry of [...allArrayEntries].sort()) {
          if (!deployableFnsSet.has(entry)) {
            failures.push({
              fn: entry,
              problems: [
                `  - Listed in a deploy/validate array but has no ` +
                  `supabase/functions/${entry}/index.ts (typo or stale entry?)`,
              ],
            })
          }
        }

        for (const fn of deployableFns) {
          const inNoVerify = noVerifyDeploy.has(fn)
          const inVerify = verifyDeploy.has(fn)
          const deployCount = (inNoVerify ? 1 : 0) + (inVerify ? 1 : 0)

          const inAnon = anonValidate.has(fn)
          const inAuth = authValidate.has(fn)
          const inService = serviceValidate.has(fn)
          const validateCount = (inAnon ? 1 : 0) + (inAuth ? 1 : 0) + (inService ? 1 : 0)

          const configMissing = inNoVerify && !configNoVerify.has(fn)

          const testMissing =
            !existsSync(join(FUNCTIONS_DIR, fn, 'index.test.ts')) &&
            !TEST_BACKFILL_ALLOWLIST.has(fn)

          if (deployCount === 1 && validateCount === 1 && !configMissing && !testMissing) continue

          const problems = []
          if (deployCount === 0) {
            problems.push(
              `  - Missing from scripts/deploy-edge-functions.sh ` +
                `(add to either NO_VERIFY_JWT_FUNCTIONS or VERIFY_JWT_FUNCTIONS)`
            )
          } else if (deployCount === 2) {
            problems.push(`  - Listed in BOTH deploy arrays (must appear in exactly one)`)
          }
          if (validateCount === 0) {
            problems.push(
              `  - Missing from scripts/validate-edge-functions.sh ` +
                `(add to ANONYMOUS_FUNCTIONS, AUTHENTICATED_FUNCTIONS, ` +
                `or SERVICE_ROLE_FUNCTIONS)`
            )
          } else if (validateCount > 1) {
            problems.push(`  - Listed in MULTIPLE validate arrays (must appear in exactly one)`)
          }
          if (configMissing) {
            problems.push(
              `  - In NO_VERIFY_JWT_FUNCTIONS but missing ` +
                `[functions.${fn}] with verify_jwt = false from supabase/config.toml`
            )
          }
          if (testMissing) {
            problems.push(
              `  - Missing sibling test file: ` +
                `supabase/functions/${fn}/index.test.ts ` +
                `(predicate 4 enforces file presence only; SMI-5010 will add ` +
                `depth enforcement)`
            )
          }
          failures.push({ fn, problems })
        }

        if (failures.length === 0) {
          pass(
            `Check 47: ${deployableFns.length} deployable function(s) — ` +
              `all coherently registered across deploy-script + validate-script + config.toml; ` +
              `no stale array entries`
          )
        } else {
          for (const { fn, problems } of failures) {
            fail(
              `Check 47: ${fn} is not correctly registered\n${problems.join('\n')}`,
              `The deploy --no-verify-jwt flag and the runtime auth model are orthogonal — ` +
                `a function may legitimately be NO_VERIFY (anonymous deploy) + SERVICE_ROLE ` +
                `(validates its own bearer). Fix the specific gap(s) above; do not "fix" ` +
                `perceived cross-script mismatches. ` +
                `See .claude/development/edge-function-patterns.md § Function Auth Matrix.`
            )
          }
        }
      }
    } catch (e) {
      warn(`Could not run Check 47 (edge-function registration coherence): ${e.message}`)
    }
  }
}

// 48. SMI-5060/SMI-5066 regression test: publish.yml dependents must gate
// every `needs.publish-<pkg>.result == 'skipped'` clause on a paired
// `pre-publish-check.outputs.<outputKey>-exists == 'true'` predicate
// (with outputKey resolved via PUBLISH_JOB_TO_OUTPUT_ALIAS for the
// `publish-mcp-server` → `mcp-exists` outlier).
//
// Background (SMI-5060): when validate fails, `publish-<pkg>` auto-skips
// (its `needs:` failed), and GitHub Actions reports
// `needs.publish-<pkg>.result == 'skipped'`. Without the paired exists
// predicate, dependent publish-* jobs treated failure-mode skips identically
// to legitimate skips ("package was already on npm"), and published broken
// dependents (orphaned npm release on 2026-05-20, run 26186802726).
//
// SMI-5066: generalized from publish-core-only to any publish-<pkg> via the
// helper `auditPublishYmlDependentGate`. The alias map handles the
// pre-existing convention drift where `publish-mcp-server`'s output key is
// `mcp-exists`, not `mcp-server-exists`. Narrow on purpose: broader
// actions-expression soundness lint would need an AST parser.
console.log(`\n${BOLD}48. publish.yml dependent-gate soundness (SMI-5060/SMI-5066)${RESET}`)
{
  const PUBLISH_YML = '.github/workflows/publish.yml'
  if (!existsSync(PUBLISH_YML)) {
    warn(`Check 48: ${PUBLISH_YML} not found — skipping`)
  } else {
    try {
      const content = readFileSync(PUBLISH_YML, 'utf8')
      const { matches, failures } = auditPublishYmlDependentGate(content)

      if (matches.length === 0) {
        warn(
          `Check 48: no 'publish-<pkg>.result == skipped' clauses found in ${PUBLISH_YML} — ` +
            `if this is intentional (e.g. publish.yml restructured), delete this check.`
        )
      } else if (failures.length > 0) {
        for (const { lineno, pkg, outputKey } of failures) {
          fail(
            `Check 48: ${PUBLISH_YML}:${lineno} accepts 'publish-${pkg}.result == \\'skipped\\'' ` +
              `without the paired 'pre-publish-check.outputs.${outputKey}-exists == \\'true\\'' predicate. ` +
              `This is the SMI-5060 regression class: validate-failure skips and package-already-published ` +
              `skips both surface as result == 'skipped' but only the latter is safe to proceed on. ` +
              `Add the paired predicate or update PUBLISH_JOB_TO_OUTPUT_ALIAS in audit-standards-helpers.mjs.`,
            `Tighten the if: clause: (needs.publish-${pkg}.result == 'success' || ` +
              `(needs.publish-${pkg}.result == 'skipped' && needs.pre-publish-check.outputs.${outputKey}-exists == 'true'))`
          )
        }
      } else {
        pass(
          `Check 48: all ${matches.length} 'publish-<pkg>.result == skipped' clause(s) in ` +
            `${PUBLISH_YML} are paired with the <outputKey>-exists predicate (SMI-5060/SMI-5066 regression guard).`
        )
      }

      // SMI-5123: POSITIVE-COVERAGE — the soundness check above only validates
      // gates that EXIST. It says nothing about a REQUIRED gate that is missing
      // entirely (the SMI-5123 bug: publish-cli depends on @skillsmith/mcp-server
      // in package.json but had no gate on publish-mcp-server, so cli could
      // publish a live dangling ref while mcp-server was skipped). Derive the
      // required gates from ground truth — each publishable package's
      // workspace-sibling deps that are themselves publishable — and assert the
      // consumer's publish job both needs: the sibling and carries the paired
      // predicate.
      const publishableNames = JSON.parse(
        (content.match(/PUBLISHABLE_PACKAGES_JSON:\s*'(\[[^']*\])'/) || [])[1] || '[]'
      )
      const pkgJsons = []
      for (const name of publishableNames) {
        const short = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
        const pkgPath = `packages/${short}/package.json`
        if (existsSync(pkgPath)) {
          try {
            pkgJsons.push({ name, json: JSON.parse(readFileSync(pkgPath, 'utf8')) })
          } catch (e) {
            warn(`Check 48 (required gates): could not parse ${pkgPath}: ${e.message}`)
          }
        }
      }

      if (pkgJsons.length === 0) {
        warn('Check 48 (required gates): no publishable package.json files found — skipping')
      } else {
        const { required, failures: gateFailures } = auditPublishYmlRequiredGates(content, pkgJsons)
        if (gateFailures.length > 0) {
          for (const { consumer, sibling, reason } of gateFailures) {
            fail(
              `Check 48 (required gates): publish-${consumer} → publish-${sibling}: ${reason}`,
              `${consumer}'s package.json depends on a publishable sibling; the consumer's ` +
                `publish job must needs: the sibling job and carry the SMI-5060 paired predicate ` +
                `so it cannot publish a dangling ref while the sibling is skipped.`
            )
          }
        } else {
          pass(
            `Check 48 (required gates): all ${required.length} package.json workspace-sibling ` +
              `dep(s) have the matching publish-job needs: + paired predicate in ${PUBLISH_YML} (SMI-5123).`
          )
        }
      }
    } catch (e) {
      warn(`Could not run Check 48 (publish.yml dependent-gate soundness): ${e.message}`)
    }
  }
}

// 49. SMI-5026 M5: "Convention check before novelty" backstop
//
// Encodes the four telemetry-specific convention-check greps from the
// `skill-invoke-telemetry.md` plan (lines 666-674 + 723-730) as static
// invariants that re-run on every PR — not just at plan time.
//
// Per the implementation-plan template (.claude/templates/implementation-plan.md
// § Surface Grounding / Convention check before novelty), generic per-PR
// pattern surveys would require knowing the plan's `<pattern-prefix>` to
// grep for, which can't be statically discovered. We therefore encode the
// four telemetry-specific assertions explicitly here. Adding a future
// Check-49-style invariant for a different SMI = extending the helper's
// `findConventionDrift` input shape, not rewriting the audit loop.
//
// Sub-checks:
//   49a (fail): SkillsmithEventType union ⊇ {skill_invoke, skill_context_load,
//               skill_invoke_unparsed}
//   49b (fail): ALLOWED_EVENTS in supabase/functions/events/index.ts ⊇ same set
//   49c (warn): withTelemetry has exactly ONE definition site, at
//               packages/core/src/telemetry/wrap.ts
//   49d (warn): /tmp/skillsmith-* not used in production source (M8 — runtime
//               state lives in ~/.skillsmith/run/, /tmp doesn't survive reboot)
//
// Exemption: a comment containing canonical `audit:check-49-ack` or its
// deprecated-but-supported `audit:check-48-ack` alias opts out of the
// grep-heuristic warns — 49d per-line (same line as the reference) and 49c on
// the def line or the comment block immediately above the parallel definition.
// 49a/49b are exact-string set membership against declared sources of truth —
// there is no legitimate exemption.
//
// Severity: 49c/49d are `warn()` for v1 to avoid false-positive fatigue
// blocking unrelated PRs (CLAUDE.md governance retro guidance). Promote to
// `fail()` after a soak period if the warn rate is zero.
console.log(`\n${BOLD}49. Convention drift backstop (SMI-5026 M5)${RESET}`)
{
  const POSTHOG_PATH = 'packages/core/src/telemetry/posthog.ts'
  const EVENTS_PATH = 'supabase/functions/events/index.ts'
  const CANONICAL_WRAP_PATH = 'packages/core/src/telemetry/wrap.ts'
  const EXPECTED_EVENTS = ['skill_invoke', 'skill_context_load', 'skill_invoke_unparsed']

  if (!existsSync(POSTHOG_PATH) || !existsSync(EVENTS_PATH)) {
    warn('Check 49: required telemetry source file(s) missing — skipping convention-drift backstop')
  } else {
    try {
      const posthogSrc = readFileSync(POSTHOG_PATH, 'utf8')
      const eventsSrc = readFileSync(EVENTS_PATH, 'utf8')

      // 49c/49d scope: all .ts files under packages/ and scripts/, excluding
      // node_modules, dist, build, and the audit script itself (which discusses
      // /tmp/skillsmith- in comments and references withTelemetry as an
      // identifier — the audit must not flag itself).
      // Git-crypt locked supabase/functions/** is read separately via
      // EVENTS_PATH; we don't walk it for the survey because the smudge
      // filter may leave it as a binary blob in CI checkouts that don't
      // hold the key (see Check 47 predicate 5 comment for the same idiom).
      const surveySrcByPath = {}
      const walk = (dir) => {
        if (!existsSync(dir)) return
        for (const name of readdirSync(dir)) {
          if (
            name === 'node_modules' ||
            name === 'dist' ||
            name === 'build' ||
            name === '.next' ||
            name === '.turbo' ||
            name.startsWith('.')
          ) {
            continue
          }
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            walk(p)
          } else if (
            (p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.mjs') || p.endsWith('.js')) &&
            // Exclude the audit script itself — it references withTelemetry
            // as a string identifier in comments + check-49 prose.
            p !== 'scripts/audit-standards.mjs' &&
            p !== 'scripts/audit-standards-helpers.mjs'
          ) {
            try {
              surveySrcByPath[p] = readFileSync(p, 'utf8')
            } catch {
              // Unreadable (e.g. git-crypt locked) — skip silently; another
              // check enforces decryption posture.
            }
          }
        }
      }
      walk('packages')
      walk('scripts')

      const result = findConventionDrift({
        posthogSrc,
        eventsSrc,
        surveySrcByPath,
        expectedNewEvents: EXPECTED_EVENTS,
        canonicalWithTelemetryPath: CANONICAL_WRAP_PATH,
      })

      // 49a — SkillsmithEventType union coherence (FAIL)
      if (result.eventTypeUnionParseFailed) {
        warn(
          `Check 49a: Could not locate \`export type SkillsmithEventType\` in ` +
            `${POSTHOG_PATH} — file may have been restructured; check that the ` +
            `discriminated-union shape still uses the canonical \`= | 'foo' | 'bar'\` form.`
        )
      } else if (result.eventTypeUnionMissing.length > 0) {
        fail(
          `Check 49a: SkillsmithEventType union missing event(s): ` +
            `${result.eventTypeUnionMissing.join(', ')}`,
          `Add the missing literal(s) to the union in ${POSTHOG_PATH}. ` +
            `The events are the canonical SMI-5026 telemetry surface — see ` +
            `docs/internal/implementation/skill-invoke-telemetry.md § Wire format.`
        )
      } else {
        pass(`Check 49a: SkillsmithEventType union includes all SMI-5026 telemetry events`)
      }

      // 49b — ALLOWED_EVENTS validation list coherence (FAIL)
      if (result.allowedEventsParseFailed) {
        warn(
          `Check 49b: Could not locate \`const ALLOWED_EVENTS = [...]\` in ` +
            `${EVENTS_PATH} — file may have been restructured.`
        )
      } else if (result.allowedEventsMissing.length > 0) {
        fail(
          `Check 49b: ALLOWED_EVENTS in ${EVENTS_PATH} missing event(s): ` +
            `${result.allowedEventsMissing.join(', ')}`,
          `Add the missing literal(s) to ALLOWED_EVENTS. The edge function ` +
            `rejects any event not in this list — drift here causes silent ` +
            `400s for clients on the new event names.`
        )
      } else {
        pass(`Check 49b: ALLOWED_EVENTS includes all SMI-5026 telemetry events`)
      }

      // 49c — withTelemetry single-source-of-truth (WARN)
      if (result.parallelWithTelemetryDefs.length === 0) {
        pass(`Check 49c: withTelemetry has a single definition site ` + `(${CANONICAL_WRAP_PATH})`)
      } else {
        const sites = result.parallelWithTelemetryDefs
          .map((d) => `  ${d.file}:${d.line} — ${d.snippet}`)
          .join('\n')
        warn(
          `Check 49c: parallel withTelemetry definition(s) detected — ` +
            `single-source-of-truth violation per SMI-5016 H1:\n${sites}`,
          `The canonical definition is in ${CANONICAL_WRAP_PATH}. Re-export ` +
            `from there instead of redefining. Suppress a genuinely-justified ` +
            `parallel definition with \`// audit:check-49-ack <reason>\` on the ` +
            `definition line or in the comment block immediately above it.`
        )
      }

      // 49d — /tmp/skillsmith- absent from prod source (WARN)
      if (result.tmpSkillsmithRefs.length === 0) {
        pass(`Check 49d: /tmp/skillsmith- not referenced in production source (M8)`)
      } else {
        const refs = result.tmpSkillsmithRefs
          .map((r) => `  ${r.file}:${r.line} — ${r.snippet}`)
          .join('\n')
        warn(
          `Check 49d: /tmp/skillsmith- referenced in production source — ` +
            `should live under ~/.skillsmith/run/ per M8 (/tmp doesn't survive reboot):\n${refs}`,
          `Move runtime state to ~/.skillsmith/run/ (mkdir -p, atomic temp ` +
            `rename). For inline doc/example references, append ` +
            `\`// audit:check-49-ack <reason>\` to the line.`
        )
      }
    } catch (e) {
      warn(`Could not run Check 49 (convention drift backstop): ${e.message}`)
    }
  }
}

// Check 50: Migration ordering guard (SMI-5162 / SMI-5159 recurrence guard)
console.log(`\n${BOLD}50. Migration Ordering Guard (SMI-5162)${RESET}`)
{
  const MIG = 'supabase/migrations'
  const baseRef = process.env.GITHUB_BASE_REF
  let added = []
  let baseFiles = []
  let skipReason = null
  try {
    if (baseRef && baseRef.length > 0) {
      // PR context: resolve the merge-base SHA so the BASE set reflects what
      // this branch actually forked from, not the current tip of origin/<base>
      // (E3: if main advanced after this branch forked, using ls-tree
      // origin/<base> would inflate maxBaseVersion and false-fail a correctly
      // ordered migration).
      const mergeBase = execSync(`git merge-base origin/${baseRef} HEAD`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      // ADDED set: --diff-filter=AR (E2) catches git-mv renames (R) in addition
      // to plain adds (A). --name-only prints the NEW path for renames, which is
      // the name that governs ordering. Three-dot = diff against merge-base,
      // matching the Check 45 pattern.
      added = execSync(`git diff --name-only --diff-filter=AR ${mergeBase}...HEAD -- ${MIG}/`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .filter(Boolean)
      // BASE set: list the merge-base tree (not the branch tip).
      baseFiles = execSync(`git ls-tree -r --name-only ${mergeBase} -- ${MIG}/`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .filter(Boolean)
    } else {
      // Local run (no PR base ref). Fall back to origin/main if present; else skip.
      const base = execSync('git rev-parse --verify --quiet origin/main || true', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (!base) {
        skipReason = 'no origin/main ref (shallow/local)'
      } else {
        const mergeBase = execSync('git merge-base origin/main HEAD', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        added = execSync(`git diff --name-only --diff-filter=AR ${mergeBase}...HEAD -- ${MIG}/`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .split('\n')
          .filter(Boolean)
        baseFiles = execSync(`git ls-tree -r --name-only ${mergeBase} -- ${MIG}/`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .split('\n')
          .filter(Boolean)
      }
    }
  } catch (e) {
    // Shallow clone, detached HEAD, no base — must NOT false-fail. Mirror
    // Check 45's catch-and-skip behaviour.
    skipReason = e.message
  }

  if (skipReason) {
    pass(`Migration ordering guard skipped (${skipReason})`)
  } else {
    const toBase = (p) => p.split('/').pop()
    const addedSql = added.filter((f) => f.endsWith('.sql')).map(toBase)
    const baseSql = baseFiles.filter((f) => f.endsWith('.sql')).map(toBase)
    const { maxBaseVersion, violations } = findOutOfOrderMigrations(addedSql, baseSql)
    if (addedSql.length === 0) {
      pass('No migrations added in this diff')
    } else if (violations.length === 0) {
      pass(
        `All ${addedSql.length} added migration(s) sort at/above base tip ${maxBaseVersion ?? '(none)'}`
      )
    } else {
      for (const v of violations) {
        fail(
          `Out-of-order migration: ${v.file} (version ${v.version}) sorts BELOW base tip ${v.maxBaseVersion} — ` +
            `would be SILENTLY SKIPPED by \`supabase db push\` (exit 0) — the SMI-5159 /account/telemetry incident.`,
          `Rename to a version > ${v.maxBaseVersion} (e.g. \`$(date -u +%Y%m%d%H%M%S)_<name>.sql\`). SQL content unchanged.`
        )
      }
    }
  }
}

// Check 51: function_search_path_mutable gate (SMI-5203 recurrence guard)
// Scans migration files changed in this PR for CREATE [OR REPLACE] FUNCTION blocks
// that lack SET search_path. Warns (not fails) — matches Supabase advisory severity.
// Known limitation: anonymous DO $$ ... $$ blocks that internally define functions
// bypass grep detection (acceptable scope for a file-level static check).
console.log(`\n${BOLD}51. Function search_path Gate — migration authoring guard (SMI-5203)${RESET}`)
{
  const MIG_DIR = 'supabase/migrations'
  let changedSqlFiles = []
  let skipReason = null

  try {
    const baseRef = process.env.GITHUB_BASE_REF
    let mergeBase
    if (baseRef && baseRef.length > 0) {
      mergeBase = execSync(`git merge-base origin/${baseRef} HEAD`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } else {
      const originMain = execSync('git rev-parse --verify --quiet origin/main || true', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (!originMain) {
        skipReason = 'no origin/main ref (shallow/local)'
      } else {
        mergeBase = execSync('git merge-base origin/main HEAD', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      }
    }

    if (!skipReason) {
      changedSqlFiles = execSync(
        `git diff --name-only --diff-filter=AR ${mergeBase}...HEAD -- ${MIG_DIR}/`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
        .split('\n')
        .filter((f) => f.endsWith('.sql') && Boolean(f))
    }
  } catch (e) {
    skipReason = e.message
  }

  if (skipReason) {
    pass(`Check 51: function search_path gate skipped (${skipReason})`)
  } else if (changedSqlFiles.length === 0) {
    pass('Check 51: no migration SQL files changed in this diff')
  } else {
    let totalViolations = 0
    for (const sqlFile of changedSqlFiles) {
      let content
      try {
        content = readFileSync(sqlFile, 'utf8')
      } catch {
        // File may be git-crypt encrypted (binary) — skip silently
        continue
      }
      const violations = findFunctionsWithoutSearchPath(content, sqlFile)
      for (const v of violations) {
        warn(
          `Check 51: function_search_path_mutable — ${v.funcName}() in ${sqlFile} ` +
            `has no SET search_path. Add SET search_path = public, extensions to the function body.`
        )
        totalViolations++
      }
    }
    if (totalViolations === 0) {
      pass(
        `Check 51: all CREATE FUNCTION blocks in ${changedSqlFiles.length} changed migration(s) include SET search_path`
      )
    }
  }
}

// Check 52: SECURITY DEFINER anon-grant lockdown (SMI-5526 recurrence guard for
// the SMI-5520/5525/5526 class). Supabase's ALTER DEFAULT PRIVILEGES silently
// grants `anon` EXECUTE on every newly created public function — including
// SECURITY DEFINER functions, where that grant can be a privilege-escalation
// hole (DEFINER bypasses RLS). This check FAILS (not warns) when a new public
// SECURITY DEFINER function ships without an explicit, signature-matched
// `REVOKE ... FROM anon`, and isn't one of the deliberately anon-callable
// exceptions below.
//
// Note on numbering: Check 51 (immediately above) already claimed the "51"
// slot for the SMI-5203 search_path gate, so this recurrence guard is Check 52.
console.log(`\n${BOLD}52. SECURITY DEFINER anon-Grant Lockdown (SMI-5526)${RESET}`)
{
  // Deliberately anon-callable SECURITY DEFINER functions. Each entry carries
  // its own one-line justification so this allowlist can't silently grow —
  // see docs/internal/implementation/smi-5526-definer-grant-audit.md Bucket C.
  const SECDEF_ANON_ALLOWLIST = [
    'search_skills', // public catalog search, reached anon/JWT via skills-search/skills-recommend/health
    'resolve_team_from_license', // MCP anon-key caller; the license key itself is the credential
    'user_team_ids', // RLS-policy helper: evaluated with the invoking role's EXECUTE, zero-arg/auth.uid()-based
    'user_admin_team_ids', // RLS-policy helper: evaluated with the invoking role's EXECUTE, zero-arg/auth.uid()-based
    'user_member_team_ids', // RLS-policy helper: evaluated with the invoking role's EXECUTE, zero-arg/auth.uid()-based
    'user_owned_team_ids', // RLS-policy helper: evaluated with the invoking role's EXECUTE, zero-arg/auth.uid()-based
    'check_team_tier_access', // RLS-policy helper: revoking anon risks breaking anon-reachable policy evaluation
  ]

  // This PR's (SMI-5526) first migration. Exempts historical CREATE-here /
  // REVOKE-later pairs from before the lockdown effort, and gates this PR plus
  // all future migrations.
  const SECDEF_LOCKDOWN_CUTOFF = '20260704000000'

  if (!existsSync(MIGRATIONS_DIR)) {
    warn(
      'Check 52: supabase/migrations directory not found — skipping SECURITY DEFINER anon-grant lockdown'
    )
  } else {
    const migrationsForSecdefAudit = []
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
      const filePath = join(MIGRATIONS_DIR, file)
      // Skip git-crypt encrypted files (binary blobs starting with \x00GITCRYPT) —
      // same idiom as the Check 11 migration-header scan above.
      if (isGitCryptEncrypted(filePath)) {
        continue
      }
      migrationsForSecdefAudit.push({ name: file, content: readFileSync(filePath, 'utf8') })
    }

    const secdefViolations = auditSecdefAnonGrants(migrationsForSecdefAudit, {
      cutoff: SECDEF_LOCKDOWN_CUTOFF,
      allowlist: SECDEF_ANON_ALLOWLIST,
    })

    if (secdefViolations.length === 0) {
      pass('All new public SECURITY DEFINER functions revoke anon EXECUTE or are allowlisted')
    } else {
      for (const v of secdefViolations) {
        fail(
          `Check 52: ${v.file}: ${v.fn}(${v.signature}) is SECURITY DEFINER and anon still has EXECUTE — ${v.reason}`,
          `Add "REVOKE EXECUTE ON FUNCTION public.${v.fn}(${v.signature}) FROM anon;" in ${v.file} ` +
            `(or a follow-up migration), or add '${v.fn}' to SECDEF_ANON_ALLOWLIST in ` +
            `scripts/audit-standards.mjs with a one-line justification if it is intentionally anon-callable.`
        )
      }
    }
  }
}

// Check 53: MCP registry server.json field-length limits (SMI-5651)
// packages/mcp-server/server.json's `description` field grew to 153 chars
// across several rebrand passes and silently blocked every registry publish
// (the registry rejects it with a 422 — "expected length <= 100") — nothing
// caught this before it shipped. This check fails loudly if description,
// title, name, version (top-level or packages[].version), or icons[].src
// ever exceed the registry schema's limits again.
console.log(`\n${BOLD}Check 53: MCP registry server.json field-length limits (SMI-5651)${RESET}`)
{
  const SERVER_JSON_PATH = 'packages/mcp-server/server.json'
  if (!existsSync(SERVER_JSON_PATH)) {
    warn(`Check 53: ${SERVER_JSON_PATH} not found — skipping registry field-length check`)
  } else {
    try {
      const serverJson = JSON.parse(readFileSync(SERVER_JSON_PATH, 'utf8'))
      const violations = findServerJsonFieldLengthViolations(serverJson)
      if (violations.length === 0) {
        pass(`${SERVER_JSON_PATH} fields are within MCP registry schema length limits`)
      } else {
        for (const v of violations) {
          fail(
            `Check 53: ${SERVER_JSON_PATH}: ${v.field} is ${v.length} chars (limit ${v.limit})`,
            `Shorten ${SERVER_JSON_PATH}'s ${v.field} to <= ${v.limit} chars — see the registry ` +
              'schema at https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
          )
        }
      }
    } catch (e) {
      warn(`Check 53: could not parse ${SERVER_JSON_PATH}: ${e.message}`)
    }
  }
}

// Check 54: CHANGELOG entry gate (SMI-5680)
//
// PR #1878 (SMI-5671) merged real source changes to packages/mcp-server/src/**
// and packages/core/src/** with zero CHANGELOG.md entries in either package —
// nothing caught it (backfilled manually in PR #1881). This check fails a PR
// that touches a released package's non-test src/** with no matching growth
// in that package's CHANGELOG.md `## [Unreleased]` section, in the same diff.
// Ships as fail() from day one — no warn-only burn-in (see plan §3 / C2).
// See docs/internal/implementation/smi-5680-changelog-entry-gate.md for the
// full VP-reviewed design.
console.log(`\n${BOLD}54. CHANGELOG Entry Gate (SMI-5680)${RESET}`)
console.log('(content, not placement — see Check 43 for heading order)')
{
  const SKIP_MARKER = '[skip-changelog-check]'
  const PR_BODY = process.env.PR_BODY || ''
  const skipAcknowledged = PR_BODY.includes(SKIP_MARKER)
  if (skipAcknowledged) {
    console.log(
      `::notice::${SKIP_MARKER} opt-out found in PR body — Check 54 will report findings but not fail.`
    )
    // L3: log the paragraph following the marker for audit trail, matching
    // concurrency-audit-pr.yml's ::group::Acknowledgement reason pattern.
    const idx = PR_BODY.indexOf(SKIP_MARKER)
    const after = PR_BODY.slice(idx + SKIP_MARKER.length)
    const reasonParagraph = after.split(/\n\s*\n/)[0].trim()
    console.log('::group::Acknowledgement reason')
    console.log(reasonParagraph || '(no reason paragraph found immediately after the marker)')
    console.log('::endgroup::')
  }

  let mergeBase = null
  let skipReason = null
  try {
    const baseRef = process.env.GITHUB_BASE_REF
    if (baseRef && baseRef.length > 0) {
      // PR context: resolve the merge-base SHA, matching Checks 50/51.
      mergeBase = execSync(`git merge-base origin/${baseRef} HEAD`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } else {
      // Local run (no PR base ref). Fall back to origin/main if present; else skip.
      const originMain = execSync('git rev-parse --verify --quiet origin/main || true', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (!originMain) {
        skipReason = 'no origin/main ref (shallow/local)'
      } else {
        mergeBase = execSync('git merge-base origin/main HEAD', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      }
    }
  } catch (e) {
    // Shallow clone, detached HEAD, no base — must NOT false-fail. Mirrors
    // Checks 45/50/51's catch-and-skip behaviour.
    skipReason = e.message
  }

  if (skipReason) {
    pass(`Check 54: CHANGELOG entry gate skipped (${skipReason})`)
  } else {
    const gitShow = (ref, path) => {
      try {
        return execSync(`git show ${ref}:${path}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        return null // file absent at this ref (or unreadable) — caller degrades gracefully
      }
    }

    let touchedTotal = 0
    let touchedMissing = 0

    for (const spec of PACKAGE_SPECS) {
      // H2: path construction always uses spec.dir ('packages/vscode-extension'),
      // never spec.shortName ('vscode') — the shortName has no corresponding
      // directory and would silently exempt vscode-extension from this gate.
      const pkgDir = spec.dir
      const pkg = pkgDir.replace(/^packages\//, '')

      let changedFiles = []
      try {
        changedFiles = execSync(`git diff --name-only ${mergeBase}...HEAD -- ${pkgDir}/src/`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .split('\n')
          .filter(Boolean)
      } catch {
        changedFiles = []
      }

      // M1: exclude test files via the shared TEST_PATTERNS export
      // (scripts/ci/source-patterns.mjs) rather than reinventing a third ad
      // hoc test-file regex.
      const nonTestChanged = changedFiles.filter((f) => !TEST_PATTERNS.some((p) => p.test(f)))
      if (nonTestChanged.length === 0) continue // nothing to check for this package

      touchedTotal++

      const changelogPath = `${pkgDir}/CHANGELOG.md`
      const pkgJsonAtBase = gitShow(mergeBase, spec.packageJsonPath)
      const pkgJsonAtHead = gitShow('HEAD', spec.packageJsonPath)
      const changelogAtBase = gitShow(mergeBase, changelogPath)
      const changelogAtHead = gitShow('HEAD', changelogPath)

      // Step 0 (C1): release-prep commits drain, not grow, [Unreleased] —
      // exempt them structurally rather than false-failing every
      // core/mcp-server release PR forever.
      if (
        pkgJsonAtBase &&
        pkgJsonAtHead &&
        changelogAtBase &&
        changelogAtHead &&
        isReleasePrepDiff(pkgJsonAtBase, pkgJsonAtHead, changelogAtBase, changelogAtHead)
      ) {
        pass(
          `Check 54: packages/${pkg} — release-prep commit detected (version bump + CHANGELOG version-section insertion); [Unreleased] growth not required`
        )
        continue
      }

      if (changelogAtHead === null) {
        warn(`Check 54: ${changelogPath} not found at HEAD — cannot verify [Unreleased] growth`)
        continue
      }

      const headCount = countUnreleasedEntries(changelogAtHead)
      const baseCount = changelogAtBase === null ? 0 : countUnreleasedEntries(changelogAtBase)

      // Sentinel (null): '## [Unreleased]' heading missing/malformed — cannot
      // safely reason about growth. Warn, don't fail (mirrors Check 47's
      // "could not parse — warn" convention for a file the check can't
      // safely reason about).
      if (headCount === null || baseCount === null) {
        warn(
          `Check 54: ${changelogPath}'s '## [Unreleased]' heading could not be found/parsed — skipping content-growth check`
        )
        continue
      }

      if (headCount > baseCount) {
        pass(`Check 54: ${changelogPath}'s [Unreleased] section grew (${baseCount} → ${headCount})`)
      } else if (skipAcknowledged) {
        pass(
          `Check 54: packages/${pkg} — [skip-changelog-check] acknowledged; [Unreleased] growth not required`
        )
      } else {
        touchedMissing++
        fail(
          `Check 54: packages/${pkg}/src/** changed (${nonTestChanged.join(', ')}) with no new content in packages/${pkg}/CHANGELOG.md's '## [Unreleased]' section`,
          `Add a bullet under '## [Unreleased]' in packages/${pkg}/CHANGELOG.md describing this change. ` +
            `If this is a revert of work that was never released, or another package's entry already covers this change, add '[skip-changelog-check]' plus a reason paragraph to the PR body — see docs/internal/process/guards-and-opt-outs.md.`
        )
      }
    }

    if (touchedTotal === 0) {
      pass('Check 54: no packages had src/** changes requiring a CHANGELOG entry in this diff')
    }

    // M7: rollup tally as a plain console.log — NOT a second pass()/fail()
    // call (would double-increment the global counters) — so a multi-package
    // PR's earlier per-package pass() can't be misread as an overall pass
    // while a later fail() for a different package goes unnoticed.
    console.log(
      `Check 54: ${touchedMissing}/${touchedTotal} touched package(s) missing a CHANGELOG entry — see above`
    )
  }
}

// Check 58: Internal @skillsmith/*/@smith-horn/* version-coherence gate
// (SMI-5715)
//
// Numbering note: Checks 55/56/57 (strategy submodule pointer-on-tip,
// `git config --file` subshell discipline, website internal-reference scan)
// were already registered earlier in this file by the time this check was
// added — the file's physical layout is not number-ordered (Check 54 itself
// sits at the very end despite being numbered lower). This check is Check 58,
// the true next-available number, not "55" as an earlier draft of the plan
// assumed before Checks 55–57 existed.
//
// packages/doc-retrieval-mcp/package.json pinned `@skillsmith/core` to
// `^0.8.0` while the workspace's actual `@skillsmith/core` version had moved
// to `0.11.2` — three minor versions of drift, invisible because nothing
// checked that internal `@skillsmith/*`/`@smith-horn/*` dependency ranges
// track the workspace's actual current versions. That single stale range
// broke both Turborepo's `dependsOn: ["^build"]` task-graph edge (Turbo only
// creates the edge when the declared range IS satisfied by the workspace
// version) and npm's workspace-symlink resolution (a fresh worktree's first
// build resolved the nested registry tarball instead of the hoisted
// workspace symlink). See
// docs/internal/implementation/smi-5715-doc-retrieval-core-version-drift.md
// for the full root-cause writeup.
//
// Ships as fail() from day one — no warn-only burn-in, matching Check 54's
// precedent (SMI-5680 C2). Scoped to the dynamic `packages/*` glob (like
// Checks 24/43), not the 5-package PACKAGE_SPECS list Check 54 uses — this
// check's whole purpose is catching packages PACKAGE_SPECS doesn't cover
// (doc-retrieval-mcp is `private: true`; skillsmith-cli is the published
// convenience-wrapper package — neither is in PACKAGE_SPECS).
console.log(
  `\n${BOLD}Check 58: Internal @skillsmith/*/@smith-horn/* version-coherence gate (SMI-5715)${RESET}`
)
{
  // [skip-version-coherence-check] — for a genuinely deliberate stale pin
  // (e.g. a compatibility shim intentionally lagging the workspace version).
  // Mirrors Check 54's [skip-changelog-check] marker exactly: PR-body-only,
  // boolean marker + required prose reason paragraph, downgrades a would-be
  // fail() to pass(). Registered in docs/internal/process/guards-and-opt-outs.md.
  const SKIP_MARKER = '[skip-version-coherence-check]'
  const PR_BODY = process.env.PR_BODY || ''
  const skipAcknowledged = PR_BODY.includes(SKIP_MARKER)
  if (skipAcknowledged) {
    console.log(
      `::notice::${SKIP_MARKER} opt-out found in PR body — Check 58 will report findings but not fail.`
    )
    const idx = PR_BODY.indexOf(SKIP_MARKER)
    const after = PR_BODY.slice(idx + SKIP_MARKER.length)
    const reasonParagraph = after.split(/\n\s*\n/)[0].trim()
    console.log('::group::Acknowledgement reason')
    console.log(reasonParagraph || '(no reason paragraph found immediately after the marker)')
    console.log('::endgroup::')
  }

  const pkgDirs = existsSync('packages')
    ? readdirSync('packages').filter((d) => existsSync(join('packages', d, 'package.json')))
    : []

  const packagesByDir = {}
  for (const d of pkgDirs) {
    try {
      packagesByDir[d] = JSON.parse(readFileSync(join('packages', d, 'package.json'), 'utf8'))
    } catch (e) {
      warn(`Check 58: could not parse packages/${d}/package.json: ${e.message}`)
    }
  }

  const results = evaluateInternalVersionCoherence(packagesByDir)
  let okCount = 0
  let violationCount = 0
  let danglingCount = 0

  for (const r of results) {
    if (r.status === 'ok') {
      okCount++
    } else if (r.status === 'dangling') {
      danglingCount++
      warn(
        `Check 58: packages/${r.dir}'s ${r.section} references ${r.depName} (range ${r.range}), which has no corresponding workspace package`,
        `Confirm the correct workspace package name for ${r.depName} and update packages/${r.dir}/package.json's ${r.section} entry accordingly`
      )
    } else if (skipAcknowledged) {
      pass(
        `Check 58: packages/${r.dir}: ${r.depName} range ${r.range} vs workspace version ${r.actualVersion} — [skip-version-coherence-check] acknowledged`
      )
    } else {
      violationCount++
      fail(
        `Check 58: packages/${r.dir}: ${r.depName} range ${r.range} does not satisfy workspace version ${r.actualVersion}`,
        `Bump the range to ^${r.actualVersion} in packages/${r.dir}/package.json. If this is a deliberate, intentionally-lagging pin, add '[skip-version-coherence-check]' plus a reason paragraph to the PR body — see docs/internal/process/guards-and-opt-outs.md.`
      )
    }
  }

  if (violationCount === 0) {
    pass(
      `Check 58: all ${okCount} internal @skillsmith/*/@smith-horn/* dependency range(s) satisfy their workspace versions` +
        (danglingCount > 0 ? ` (${danglingCount} dangling-name warning(s) above)` : '')
    )
  }
}

// Check 59: CLI-tool pin invariants (SMI-5746)
//
// Dependabot only scans package.json/package-lock.json, GitHub Actions
// versions, and the root Dockerfile base image — it has no visibility into
// standalone CLI-tool binaries pinned outside those manifests. This check is
// the static-invariant half of the remediation (the other half is a weekly
// drift-flagger cron, scripts/cli-pin-drift-check.sh). See
// docs/internal/implementation/cli-tool-version-drift-remediation.md for the
// full incident history (two real production incidents already traced to
// this blind spot) and design rationale.
//
// Ships warn-level for a two-week shadow burn-in (matching the Check 49
// convention), then promotes to fail-level — CHECK_59_SHADOW_END_DATE below,
// same pattern as team-compliance-check-pr.yml's SHADOW_MODE_END_DATE.
console.log(`\n${BOLD}Check 59: CLI-tool pin invariants (SMI-5746)${RESET}`)
{
  const CHECK_59_SHADOW_END_DATE = '2026-08-01'
  const inShadow = new Date() < new Date(CHECK_59_SHADOW_END_DATE)
  const report = inShadow ? warn : fail
  const shadowSuffix = inShadow
    ? ` [shadow mode through ${CHECK_59_SHADOW_END_DATE} — advisory only]`
    : ''

  let check59Violations = 0

  const floatingSupabase = findFloatingSupabaseCliInstalls(join('.github', 'workflows'))
  for (const f of floatingSupabase) {
    check59Violations++
    report(
      `Check 59: ${f.file}:${f.line} — supabase/setup-cli step has ${
        f.versionLine === null ? 'no version: input' : `version: ${f.versionLine}`
      } (must pin an exact devDependency-derived version)${shadowSuffix}`,
      `Read the pin from package.json's devDependencies.supabase into a step output and reference it — see the deploy-edge-functions.yml pattern.`
    )
  }

  const unpinnedBareNpx = findUnpinnedBareNpxCliInPackageJson('.')
  for (const f of unpinnedBareNpx) {
    check59Violations++
    report(
      `Check 59: ${f.file} script "${f.script}" runs bare "npx ${f.tool}" with no matching devDependency pin${shadowSuffix}`,
      `Add "${f.tool}" as an exact-pinned devDependency so npx resolves the local copy instead of registry-latest.`
    )
  }

  const rufloFinding = findUnpinnedRufloMcpEntry('.mcp.json')
  if (rufloFinding) {
    check59Violations++
    report(`Check 59: .mcp.json — ${rufloFinding.reason} (${rufloFinding.pkgArg})${shadowSuffix}`)
  }

  const claudeFlowHits = findClaudeFlowReintroductions(resolvePath('.'))
  for (const f of claudeFlowHits) {
    check59Violations++
    report(
      `Check 59: ${f.file}:${f.line} — reintroduces "npx claude-flow" (pre-rename name)${shadowSuffix}`,
      `Replace with the local-bin form: node node_modules/ruflo/bin/ruflo.js ...`
    )
  }

  if (check59Violations === 0) {
    pass('Check 59: no CLI-tool pin invariant violations found')
  }
}

// Check 60: README "What's New" Currency (SMI-5613)
//
// packages/{core,cli,mcp-server}/README.md each carry a manually-maintained
// "## What's New in vX.Y.Z" section that ships verbatim to npmjs.com.
// scripts/prepare-release.ts bumps package.json/CHANGELOG.md/version constants
// on every release but never touches README.md — this drift has silently
// recurred three times (April 2026, SMI-5612, SMI-5759) with no automated
// detection. See docs/internal/implementation/readme-whats-new-drift-check.md.
//
// Scoped to the dynamic packages/* glob (like Checks 24/58), not a hardcoded
// package list — a package with no "What's New" heading at all is silently
// skipped (matching Check 24's asymmetry), since most packages legitimately
// have no such section.
//
// Ships warn-level through a shadow burn-in (CHECK_60_SHADOW_END_DATE below,
// matching Check 59's convention) — this is new detection logic without a
// battle-tested regex/heading-format assumption across a real release cycle
// yet, unlike Check 58's immediate fail(). Promotes to fail-level after.
console.log(`\n${BOLD}Check 60: README "What's New" Currency (SMI-5613)${RESET}`)
{
  const CHECK_60_SHADOW_END_DATE = '2026-08-02'
  const inShadow = new Date() < new Date(CHECK_60_SHADOW_END_DATE)
  const report = inShadow ? warn : fail
  const shadowSuffix = inShadow
    ? ` [shadow mode through ${CHECK_60_SHADOW_END_DATE} — advisory only]`
    : ''

  // [skip-whats-new-check] — PR-body marker for a genuinely deliberate
  // exception once at fail-tier. Boolean marker + required prose reason
  // paragraph, mirrors [skip-changelog-check] / [skip-version-coherence-check]
  // exactly. Registered in docs/internal/process/guards-and-opt-outs.md.
  // Gated on !inShadow: during shadow mode `report` is already `warn`
  // regardless, so checking the marker then would just add a confusing
  // "acknowledged" suffix implying something was blocked when nothing was.
  const SKIP_MARKER = '[skip-whats-new-check]'
  const PR_BODY = process.env.PR_BODY || ''
  const skipAcknowledged = !inShadow && PR_BODY.includes(SKIP_MARKER)
  if (skipAcknowledged) {
    console.log(
      `::notice::${SKIP_MARKER} opt-out found in PR body — Check 60 will report findings but not fail.`
    )
  }

  const pkgDirs = existsSync('packages')
    ? readdirSync('packages').filter((d) => existsSync(join('packages', d, 'package.json')))
    : []

  let whatsNewIssues = 0
  for (const d of pkgDirs) {
    const pkgPath = join('packages', d, 'package.json')
    const readmePath = join('packages', d, 'README.md')
    if (!existsSync(readmePath)) continue

    try {
      const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
      if (!pkgVersion) continue

      const readmeVersion = extractWhatsNewVersion(readFileSync(readmePath, 'utf8'))
      if (readmeVersion === null) continue // No "What's New" section — not this check's concern

      if (readmeVersion !== pkgVersion) {
        whatsNewIssues++
        const msg = `packages/${d}: README "What's New" section is stale — heading says v${readmeVersion} but package.json is at v${pkgVersion}${shadowSuffix}`
        const fix = `Update ${readmePath}'s "What's New" section for v${pkgVersion}`
        if (skipAcknowledged) {
          warn(msg + ' — [skip-whats-new-check] acknowledged', fix)
        } else {
          report(msg, fix)
        }
      }
    } catch (e) {
      warn(`Could not check README "What's New" currency for packages/${d}: ` + e.message)
    }
  }

  if (whatsNewIssues === 0) {
    pass(`Check 60: all README "What's New" sections are current with their package.json versions`)
  }
}

// Check 61: git-crypt filter `--unset` remediation ban (SMI-5702)
//
// `git config --local --unset filter.git-crypt.{smudge,clean}` writes to
// the shared repo-wide $GIT_COMMON_DIR/config -- ALL worktrees and the main
// checkout share this state (git-crypt's own worktreeConfig=true extension
// is set but unused). Printed remediation text containing this command was
// followed literally and broke the filter repo-wide, TWICE (SMI-5702,
// recurrence 12 days later as SMI-5861). The fix is
// scripts/_lib.sh's ensure_git_crypt_filter_registered() self-heal
// (write-only, never removes keys) plus
// ./scripts/worktree-crypt.sh fix <path> as the single canonical
// remediation printed everywhere. This check is the mechanical backstop
// that makes a doc-only fix (what shipped, and silently regressed, the
// first time) structurally impossible: it fails on any remaining `--unset`
// near a `filter.git-crypt` mention, repo-wide, with a narrow carve-out for
// historical plan docs and the skillsmith-strategy submodule (fixed
// separately, see docs/internal/implementation/
// smi-5702-worktree-git-crypt-filter-deadlock.md Wave 4).
//
// scripts/tests/git-crypt-remediation-strings.test.ts (T11) is the
// executable twin of this check -- same helper, same invariant -- so a
// green unit suite and a green CI gate can never silently disagree.
console.log(`\n${BOLD}Check 61: git-crypt filter --unset remediation ban (SMI-5702)${RESET}`)
{
  const gitCryptUnsetFindings = findGitCryptUnsetRemediations('.')
  if (gitCryptUnsetFindings.length === 0) {
    pass(
      'Check 61: no `--unset filter.git-crypt` remediation text found outside historical plan docs'
    )
  } else {
    for (const f of gitCryptUnsetFindings) {
      fail(
        `Check 61: ${f.file}:${f.line} — \`--unset\` near \`filter.git-crypt\`: ${f.text}`,
        'Replace with ensure_git_crypt_filter_registered() (scripts/_lib.sh) or print_git_crypt_filter_remediation() (single line: ./scripts/worktree-crypt.sh fix <path>) — never write a bare `--unset filter.git-crypt.*` command, printed or executed. See docs/internal/implementation/smi-5702-worktree-git-crypt-filter-deadlock.md.'
      )
    }
  }
}

// Check 62: MCP server service-role usage lockdown (SMI-6109)
//
// SMI-6109 removed the customer-facing README instructions to configure
// SUPABASE_SERVICE_ROLE_KEY on an MCP host, and moved list()/get()/
// getNamespace() (registry-tools.live.ts) off the service-role client onto
// the signed-in user's own JWT. This check is the mechanical backstop that
// keeps a NEW customer-facing service-role dependency from silently
// reappearing under packages/mcp-server/src/** — the exact class of gap
// SMI-6109 itself was created to close.
//
// Matches only real usage (a getSupabaseAdminClient(...) CALL, or a literal
// process.env.SUPABASE_SERVICE_ROLE_KEY read) — not narrative mentions of
// the string in a doc comment (e.g. registry-tools.live.ts's own header,
// explaining the history of this exact fix), which would otherwise
// false-positive on the very file that fixed this.
console.log(`\n${BOLD}Check 62: MCP server service-role usage lockdown (SMI-6109)${RESET}`)
{
  // Every CURRENT, pre-existing, deliberately-out-of-scope service-role usage under
  // packages/mcp-server/src/**, each with its own one-line justification — see
  // docs/internal/implementation (SMI-6109 plan)'s "Explicitly out of scope" section for the
  // full rationale on each. supabase-client.ts itself is excluded from the scan below (it is
  // the legitimate definition site for both the function and the env read), not allowlisted.
  //
  // Keyed by full repo-relative path, not basename (cross-provider review finding, SMI-6109):
  // a basename-only allowlist would silently exempt any FUTURE file sharing one of these names in
  // a different subdirectory. `integration-tools.service.ts` was deliberately dropped from an
  // earlier draft of this list — it only has a narrative comment mentioning
  // SUPABASE_SERVICE_ROLE_KEY, which neither pattern below actually matches, so it never needed
  // an entry; keeping it would itself have been a silent, unnecessary allowlist grant.
  const MCP_SERVICE_ROLE_ALLOWLIST_JUSTIFICATIONS = {
    'packages/mcp-server/src/tools/team-workspace.live.ts':
      'identical list/get-shaped pattern across 8 methods, writes included — needs its own design (SMI-6109 plan)',
    'packages/mcp-server/src/tools/registry-tools.live.audit.ts':
      'audit-log write path — a system-table insert, fail-soft, structurally different from a tenant-data read',
    // registry-tools.live.content.ts's entry was removed here (SMI-6111, 2026-08-24): its
    // getContent()/install() entitlement check now uses check_registry_team_entitlement(), a
    // SECURITY DEFINER RPC via the member client — no getSupabaseAdminClient() call remains in
    // that file, so it needs no allowlist entry. If this Check ever fails on that file again,
    // treat it as a real regression, not a stale-allowlist gap.
  }
  const MCP_SERVICE_ROLE_ALLOWLIST = new Set(Object.keys(MCP_SERVICE_ROLE_ALLOWLIST_JUSTIFICATIONS))

  const MCP_SERVER_SRC = join('packages', 'mcp-server', 'src')
  const SERVICE_ROLE_CALL = /getSupabaseAdminClient\s*\(/
  const SERVICE_ROLE_ENV_READ = /process\.env\.SUPABASE_SERVICE_ROLE_KEY/

  function listMcpServerSourceFiles(dir) {
    const out = []
    if (!existsSync(dir)) return out
    const stack = [dir]
    while (stack.length) {
      const cur = stack.pop()
      let entries
      try {
        entries = readdirSync(cur, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        const full = join(cur, ent.name)
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name === 'dist') continue
          stack.push(full)
        } else if (
          ent.isFile() &&
          ent.name.endsWith('.ts') &&
          !ent.name.endsWith('.test.ts') &&
          !ent.name.endsWith('.spec.ts') &&
          !ent.name.endsWith('.test-helpers.ts') &&
          ent.name !== 'supabase-client.ts'
        ) {
          out.push(full)
        }
      }
    }
    return out
  }

  const mcpServiceRoleFindings = []
  // Cross-provider review finding (SMI-6109): an allowlist entry whose file no longer actually
  // matches either pattern is itself worth catching — it means the entry is stale (either the
  // usage was since removed, a la integration-tools.service.ts's comment-only mention which never
  // matched at all, or the file was renamed/moved). A silently-stale entry can mask a REAL future
  // regression at that same path if the pattern's match state flips back later unnoticed.
  const staleAllowlistEntries = []
  const seenAllowlistPaths = new Set()
  for (const file of listMcpServerSourceFiles(MCP_SERVER_SRC)) {
    const relPath = relative(process.cwd(), file)
    const content = readFileSync(file, 'utf8')
    const matchesServiceRole =
      SERVICE_ROLE_CALL.test(content) || SERVICE_ROLE_ENV_READ.test(content)
    if (MCP_SERVICE_ROLE_ALLOWLIST.has(relPath)) {
      seenAllowlistPaths.add(relPath)
      if (!matchesServiceRole) staleAllowlistEntries.push(relPath)
      continue
    }
    if (matchesServiceRole) mcpServiceRoleFindings.push(relPath)
  }
  // An allowlisted path that was never visited at all (renamed/deleted) is equally stale.
  for (const allowed of MCP_SERVICE_ROLE_ALLOWLIST) {
    if (!seenAllowlistPaths.has(allowed)) staleAllowlistEntries.push(allowed)
  }

  if (mcpServiceRoleFindings.length === 0 && staleAllowlistEntries.length === 0) {
    pass(
      'Check 62: no new service-role usage outside the SMI-6109 allowlist under packages/mcp-server/src/**'
    )
  } else {
    for (const f of mcpServiceRoleFindings) {
      fail(
        `Check 62: ${f} calls getSupabaseAdminClient()/reads SUPABASE_SERVICE_ROLE_KEY directly`,
        'Use getMemberUserClient()/getAdminUserClient() (registry-tools.live.auth.ts) instead, so the ' +
          "operation runs on the signed-in user's own JWT with RLS as the authorization boundary " +
          '(SMI-6109) — or, if this usage is genuinely a new, deliberately-scoped exception, add the ' +
          "file's full repo-relative path to MCP_SERVICE_ROLE_ALLOWLIST_JUSTIFICATIONS in " +
          "scripts/audit-standards.mjs with a one-line justification, matching this repo's other " +
          'named-allowlist conventions (e.g. NO_VERIFY_JWT_FUNCTIONS, SECDEF_ANON_ALLOWLIST).'
      )
    }
    for (const stale of staleAllowlistEntries) {
      fail(
        `Check 62: ${stale} is allowlisted in MCP_SERVICE_ROLE_ALLOWLIST_JUSTIFICATIONS but no ` +
          'longer contains a matching getSupabaseAdminClient()/SUPABASE_SERVICE_ROLE_KEY usage ' +
          '(or the file no longer exists at that path)',
        `Remove the stale entry for '${stale}' from MCP_SERVICE_ROLE_ALLOWLIST_JUSTIFICATIONS in ` +
          'scripts/audit-standards.mjs — an unnecessary allowlist grant is itself a finding, not a ' +
          'harmless no-op (SMI-6109 cross-provider review: integration-tools.service.ts was ' +
          'allowlisted for a comment-only mention that never matched either pattern).'
      )
    }
  }
}

// Check 63: Export-surface coherence for @skillsmith/*/@smith-horn/*
// workspace-sibling imports (SMI-6146)
//
// Background: SMI-6143 shipped @skillsmith/mcp-server@0.7.10 depending on
// @skillsmith/core exports (getApiBaseUrl, resolveSessionTier,
// SessionTierAuthError, SessionTierTransientError) that core's *published*
// version didn't yet have — every fresh install broke immediately. Both
// verify-publish-deps.mjs Check 2 and this file's own Check 58 were
// supposed to catch exactly this and didn't, for the same reason: at that
// point core's *local* package.json version was still unchanged, so both
// checks compared the same version string to itself and passed. Neither
// check has ever opened a source file, a dist/, or a declaration file —
// they reason only about version-range STRINGS.
//
// Version-range coherence (Checks 2/58) proves the DECLARED RANGES are
// internally consistent with each other. Export-surface coherence (this
// check) proves the IMPORTED SYMBOLS actually exist in the sibling's
// source, independent of what either package's version field says — the
// two are complementary, not redundant: a consumer can have a perfectly
// satisfied version range (Check 58 green) while still importing a name
// the sibling's source has never exported (this check, red), which is
// exactly the SMI-6143 shape. See
// docs/internal/implementation/smi-6146-export-surface-coherence-check.md
// for the full design, including why scripts/smoke-test-published.ts was
// the only existing mechanism that actually caught SMI-6143 in practice
// (it's the only thing that installs and imports the real published npm
// tarball) — and only after `npm publish` had already run. This check
// closes that gap earlier: it reads source, not dist/ or a published
// tarball, so it runs pre-merge in the existing `quality-checks` job with
// no new CI job and no new install/build step.
//
// Reuses the existing parseTsExports/collectTsEntryExports helpers
// (scripts/audit-standards-helpers.mjs, Check 29/SMI-4193) via the new
// scripts/audit-export-surface-resolver-helpers.mjs (sibling export-surface
// resolution across a package's full `exports` map, generic dist->src
// mapping) and scripts/audit-export-surface-consumer-helpers.mjs (consumer
// import extraction — ImportDeclaration + ImportTypeNode — plus the
// comparison/violation logic).
//
// Ships warn-level through a shadow burn-in (CHECK_63_SHADOW_END_DATE
// below, matching Check 59/60's convention) — this is genuinely new
// detection logic (multi-entry-point resolution, alias/type-query
// handling, dist->src path convention) with real false-positive surface,
// unlike Check 58's immediate fail(). Shortened to 1 week (not the usual
// 2) given the incident's severity — leaving the exact SMI-6143 failure
// class undetected for longer than necessary isn't the right default.
console.log(
  `\n${BOLD}Check 63: Export-surface coherence for workspace-sibling imports (SMI-6146)${RESET}`
)
{
  const CHECK_63_SHADOW_END_DATE = '2026-09-01'
  // [skip-export-surface-check] — a DEDICATED marker, deliberately not a
  // reuse of [skip-version-coherence-check]: a legitimate reason to skip
  // version-range coherence (e.g. an intentional pre-release range) says
  // nothing about whether the actual import target exists, so conflating
  // the two escape hatches would let a real missing-export bug hide behind
  // an unrelated skip marker. Registered in
  // docs/internal/process/guards-and-opt-outs.md.
  const SKIP_MARKER = '[skip-export-surface-check]'
  const PR_BODY = process.env.PR_BODY || ''

  // Gate/marker decision logic lives in evaluateExportSurfaceShadowGate
  // (audit-export-surface-consumer-helpers.mjs) — extracted out of this
  // inline block so it's unit-testable in isolation, matching the pattern
  // already inlined for Check 59/60 above but factored out here.
  const {
    report: reportLevel,
    shadowSuffix,
    skipAcknowledged,
  } = evaluateExportSurfaceShadowGate({
    shadowEndDate: CHECK_63_SHADOW_END_DATE,
    now: new Date(),
    prBody: PR_BODY,
    skipMarker: SKIP_MARKER,
  })
  const report = reportLevel === 'warn' ? warn : fail
  if (skipAcknowledged) {
    console.log(
      `::notice::${SKIP_MARKER} opt-out found in PR body — Check 63 will report findings but not fail.`
    )
  }

  const WORKSPACE_SCOPE_PREFIXES = ['@skillsmith/', '@smith-horn/']

  const pkgDirs = existsSync('packages')
    ? readdirSync('packages').filter((d) => existsSync(join('packages', d, 'package.json')))
    : []

  // packageName -> { dir, pkgJson, tsconfigJson } for every workspace
  // package with a scoped @skillsmith/*/@smith-horn/* name — the set of
  // resolvable "siblings" a consumer's import can be checked against.
  const packageInfoByName = new Map()
  for (const d of pkgDirs) {
    let pkgJson
    try {
      pkgJson = JSON.parse(readFileSync(join('packages', d, 'package.json'), 'utf8'))
    } catch (e) {
      warn(`Check 63: could not parse packages/${d}/package.json: ${e.message}`)
      continue
    }
    if (typeof pkgJson.name !== 'string') continue
    let tsconfigJson = null
    const tsconfigPath = join('packages', d, 'tsconfig.json')
    if (existsSync(tsconfigPath)) {
      try {
        tsconfigJson = JSON.parse(readFileSync(tsconfigPath, 'utf8'))
      } catch (e) {
        warn(`Check 63: could not parse packages/${d}/tsconfig.json: ${e.message}`)
      }
    }
    packageInfoByName.set(pkgJson.name, { dir: d, pkgJson, tsconfigJson })
  }

  const readFileIfExists = (absPath) => (existsSync(absPath) ? readFileSync(absPath, 'utf8') : null)
  // Same .js-in-source convention as Check 29's resolveModule
  // (scripts/audit-standards.mjs's own Check 29 block) — generic across
  // every package since it only ever resolves relative to the CURRENT
  // file's own directory.
  const resolveModule = (fromFile, spec) => {
    if (!spec.startsWith('.')) return null
    const base = resolvePath(dirname(fromFile), spec.replace(/\.(m?js)$/, ''))
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  // Per (package, export-entry) cache, shared across every consumer
  // processed in this run — a run touching multiple consumers of the same
  // sibling+subpath only parses that sibling's source once.
  const exportSetCache = new Map()
  const resolveExportSet = (packageName, subpath) => {
    const info = packageInfoByName.get(packageName)
    if (!info) return { status: 'no-exports-surface' }
    return resolveExportSetForSubpath({
      pkgDirAbs: resolvePath('packages', info.dir),
      pkgJson: info.pkgJson,
      tsconfigJson: info.tsconfigJson,
      subpath,
      readFile: readFileIfExists,
      resolveModule,
      cache: exportSetCache,
    })
  }

  let filesChecked = 0
  let importsChecked = 0
  let missingExportCount = 0
  let subpathViolationCount = 0
  let unresolvableSurfaceCount = 0
  let uncheckedTotal = 0
  const uncheckedFiles = new Set()

  for (const consumerDir of pkgDirs) {
    const srcDir = join('packages', consumerDir, 'src')
    if (!existsSync(srcDir)) continue
    const tsFiles = getFilesRecursive(srcDir, ['.ts']).filter(
      (f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts')
    )
    if (tsFiles.length === 0) continue

    const srcByPath = {}
    for (const f of tsFiles) {
      srcByPath[f] = readFileSync(f, 'utf8')
      filesChecked++
    }

    const { groups, unchecked } = groupConsumerWorkspaceImports(srcByPath, WORKSPACE_SCOPE_PREFIXES)

    // Only compare against KNOWN workspace siblings — an
    // @skillsmith/*/@smith-horn/* specifier that doesn't resolve to any
    // packages/* package.json `name` is out of this check's scope (not
    // currently possible in this monorepo; the filter is defensive).
    const resolvableGroups = new Map()
    for (const [key, group] of groups) {
      if (packageInfoByName.has(group.packageName)) {
        resolvableGroups.set(key, group)
        importsChecked += group.occurrences.length
      }
    }

    uncheckedTotal += unchecked.length
    for (const u of unchecked) uncheckedFiles.add(u.file)

    const { missingExportViolations, subpathViolations, unresolvableSurfaceWarnings } =
      evaluateExportSurfaceCoherence(resolvableGroups, resolveExportSet)

    for (const v of missingExportViolations) {
      missingExportCount++
      const relEntry = relative(process.cwd(), v.entrySourcePath)
      const msg =
        `Check 63: ${v.file}:${v.line} imports '${v.name}' from '${v.specifier}', which does not export it${shadowSuffix}\n` +
        `  (checked ${relEntry} and its export * chain — ${v.exportCount} name(s) found, '${v.name}' not among them)`
      const fix =
        `Three likely causes, in order: (1) typo in the import name — fix it; ` +
        `(2) '${v.packageName}' genuinely needs to export '${v.name}' yet (the SMI-6143 shape) — add the export to its source in this PR, ` +
        `or land a preceding PR that does, before this one merges; ` +
        `(3) known false-positive (e.g. an unchecked default/namespace import misclassified, or a Known Limitation) — ` +
        `add '[skip-export-surface-check]' plus a reason paragraph to the PR body — see docs/internal/process/guards-and-opt-outs.md.`
      if (skipAcknowledged) {
        warn(msg + ' — [skip-export-surface-check] acknowledged', fix)
      } else {
        report(msg, fix)
      }
    }

    for (const v of subpathViolations) {
      for (const occ of v.occurrences) {
        subpathViolationCount++
        const msg = `Check 63: ${occ.file}:${occ.line} imports from '${v.specifier}', but ${v.packageName}'s package.json declares no '${v.subpath}' export entry${shadowSuffix}`
        const fix =
          `Either fix the import path to a subpath '${v.packageName}' actually declares in its 'exports' map, ` +
          `or add the '${v.subpath}' entry to ${v.packageName}'s package.json 'exports' map if it's meant to be public. ` +
          `Known false-positive: add '[skip-export-surface-check]' plus a reason paragraph to the PR body.`
        if (skipAcknowledged) {
          warn(msg + ' — [skip-export-surface-check] acknowledged', fix)
        } else {
          report(msg, fix)
        }
      }
    }

    for (const w of unresolvableSurfaceWarnings) {
      for (const occ of w.occurrences) {
        unresolvableSurfaceCount++
        warn(
          `Check 63: ${occ.file}:${occ.line} imports from '${w.specifier}', but ${w.packageName}'s export surface could not be resolved (${w.status})`,
          w.status === 'no-exports-surface'
            ? `'${w.packageName}' has no 'exports'/'main'/'types' field in its package.json — this check cannot verify imports from it (see Known Limitations).`
            : `'${w.packageName}'s tsconfig.json outDir doesn't match its declared dist path for '${w.subpath}' — check that package's build config.`
        )
      }
    }
  }

  if (missingExportCount === 0 && subpathViolationCount === 0) {
    pass(
      `Check 63: all ${importsChecked} workspace-sibling import(s) across ${filesChecked} checked file(s) resolve in their sibling's export surface` +
        (unresolvableSurfaceCount > 0
          ? ` (${unresolvableSurfaceCount} unresolvable-surface warning(s) above)`
          : '')
    )
  }

  // Default/namespace/unresolved-dynamic-import rollup tally — plain
  // console.log, matching Check 54's M7 precedent: NOT a second
  // pass()/warn()/fail() call, which would double-increment the global
  // counters and let an earlier per-violation pass/fail be misread as the
  // overall verdict. Includes dynamic `import(...)` occurrences whose
  // imported names can't be determined statically (e.g. the whole
  // namespace object bound to a plain identifier and used elsewhere, the
  // packages/enterprise/src/audit/scheduled-scan.ts shape) alongside
  // static default/namespace imports — same reporting treatment, not
  // silently dropped.
  console.log(
    `Check 63: ${uncheckedTotal} default/namespace/dynamic-import unchecked import(s) across ${uncheckedFiles.size} file(s) not symbol-checked — see Known Limitations`
  )
}

// Check 64: `.husky/_/<hook>` stub-coverage guard (SMI-6334 Wave 2 Step 1)
//
// SMI-6334 makes `core.hooksPath` the relative literal '.husky/_', which
// git resolves against the invoking working tree's toplevel. Husky's own
// dispatcher (`.husky/_/h`) resolves the hook body to run from `$0` (i.e.
// from `.husky/_/<hook>`) -- so any `.husky/<hook>` body with no matching,
// non-trivial `.husky/_/<hook>` stub gets silently SKIPPED by git (a
// missing hook file is not an error), not routed to some other tree. This
// check is the mechanical backstop for the tree `npm run audit:standards`
// happens to run against; it cannot centrally sweep every currently-active
// worktree branch -- scripts/lib/check-hooks-path.sh (Check 64's per-
// invoking-tree companion, invoked from .husky/pre-push) is what catches
// this for whichever branch is actually being used, at push time.
console.log(`\n${BOLD}Check 64: .husky/_/<hook> stub coverage (SMI-6334)${RESET}`)
{
  const huskyFindings = findMissingHuskyStubs('.husky')
  if (huskyFindings.length === 0) {
    pass('Check 64: every .husky/<hook> has a matching, non-trivial .husky/_/<hook> stub')
  } else {
    for (const f of huskyFindings) {
      const detail =
        f.reason === 'missing'
          ? `.husky/_/${f.hook} is missing`
          : `.husky/_/${f.hook} is only ${f.size} byte(s) — looks truncated/empty, not a real husky stub`
      fail(
        `Check 64: ${detail} — .husky/${f.hook} will silently NEVER run once core.hooksPath is '.husky/_' (SMI-6334)`,
        `Re-add .husky/_/${f.hook} matching husky's own stub shape (` +
          '`#!/usr/bin/env sh` then `. "$(dirname "$0")/h"`), and make sure it is committed and executable.'
      )
    }
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
