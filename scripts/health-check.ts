#!/usr/bin/env npx tsx
/**
 * Supabase Health Check Script
 *
 * Validates connectivity and data integrity for the Skillsmith Supabase instance.
 *
 * Checks performed:
 * 1. API Reachability - Can we connect to Supabase REST endpoint?
 * 2. Skills Table Accessible - Does the table exist and accept queries?
 * 3. Skills Table Has Data - Are there skills in the database?
 * 4. Search Functionality - Does ILIKE search work correctly?
 * 5. Response Time - Are all operations under threshold?
 *
 * Usage:
 *   npx tsx scripts/health-check.ts [options]
 *
 * Options:
 *   --json       Output results as JSON (for CI integration)
 *   --verbose    Show detailed response data
 *   --timeout    Override default timeout (default: 5000ms)
 *
 * Environment Variables:
 *   SUPABASE_URL       - Override default Supabase URL
 *   SUPABASE_ANON_KEY  - Anon key for authenticated requests (optional)
 *
 * Exit Codes:
 *   0 - All checks passed (healthy)
 *   1 - One or more checks failed (unhealthy)
 */

import * as fs from 'fs'
import * as path from 'path'

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_SUPABASE_URL = 'https://vrcnzpmndtroqxxoqkzy.supabase.co'
const DEFAULT_TIMEOUT_MS = 5000
const RESPONSE_TIME_THRESHOLD_MS = 500

// =============================================================================
// Types
// =============================================================================

interface HealthCheckResult {
  name: string
  status: 'pass' | 'fail'
  message: string
  durationMs: number
  details?: Record<string, unknown>
}

interface HealthCheckReport {
  healthy: boolean
  timestamp: string
  supabaseUrl: string
  checks: HealthCheckResult[]
  metrics: {
    totalSkills: number | null
    avgResponseTimeMs: number
    sampleSkill: {
      id: string
      name: string
      trust_tier: string
    } | null
  }
}

interface CliOptions {
  json: boolean
  verbose: boolean
  timeout: number
}

interface SkillRecord {
  id: string
  name: string
  description: string | null
  trust_tier: string
  quality_score: number | null
  tags: string[]
}

// =============================================================================
// Environment Loading
// =============================================================================

function loadEnv(): void {
  const envPath = path.join(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match) {
        const [, key, value] = match
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value.trim()
        }
      }
    }
  }
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  let timeout = DEFAULT_TIMEOUT_MS

  const timeoutIdx = args.indexOf('--timeout')
  if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
    const parsed = parseInt(args[timeoutIdx + 1], 10)
    if (!isNaN(parsed) && parsed > 0) {
      timeout = parsed
    }
  }

  return {
    json: args.includes('--json'),
    verbose: args.includes('--verbose'),
    timeout,
  }
}

// =============================================================================
// HTTP Helpers
// =============================================================================

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

function getHeaders(anonKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (anonKey) {
    headers['apikey'] = anonKey
    headers['Authorization'] = `Bearer ${anonKey}`
  }

  return headers
}

// =============================================================================
// Health Checks
// =============================================================================

async function checkApiReachability(
  baseUrl: string,
  headers: Record<string, string>,
  timeout: number
): Promise<HealthCheckResult> {
  const start = Date.now()
  const name = 'API Reachability'

  try {
    // Use the REST API health endpoint (returns empty array for non-existent table query)
    const response = await fetchWithTimeout(
      `${baseUrl}/rest/v1/`,
      { method: 'GET', headers },
      timeout
    )

    const durationMs = Date.now() - start

    if (response.ok || response.status === 404) {
      // 404 is expected for root endpoint without table name
      return {
        name,
        status: 'pass',
        message: `Supabase API is reachable (${response.status})`,
        durationMs,
      }
    }

    return {
      name,
      status: 'fail',
      message: `Unexpected status: ${response.status}`,
      durationMs,
    }
  } catch (error) {
    const durationMs = Date.now() - start
    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('abort')) {
      return {
        name,
        status: 'fail',
        message: `Connection timed out after ${timeout}ms`,
        durationMs,
      }
    }

    return {
      name,
      status: 'fail',
      message: `Connection failed: ${message}`,
      durationMs,
    }
  }
}

async function checkTableAccessible(
  baseUrl: string,
  headers: Record<string, string>,
  timeout: number
): Promise<HealthCheckResult> {
  const start = Date.now()
  const name = 'Skills Table Accessible'

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/rest/v1/skills?limit=1`,
      { method: 'GET', headers },
      timeout
    )

    const durationMs = Date.now() - start

    if (response.ok) {
      return {
        name,
        status: 'pass',
        message: 'Skills table exists and is queryable',
        durationMs,
      }
    }

    if (response.status === 404) {
      return {
        name,
        status: 'fail',
        message: 'Skills table not found (404)',
        durationMs,
      }
    }

    const errorText = await response.text()
    return {
      name,
      status: 'fail',
      message: `Table query failed: ${response.status} - ${errorText.substring(0, 100)}`,
      durationMs,
    }
  } catch (error) {
    const durationMs = Date.now() - start
    const message = error instanceof Error ? error.message : String(error)
    return {
      name,
      status: 'fail',
      message: `Query failed: ${message}`,
      durationMs,
    }
  }
}

async function checkTableHasData(
  baseUrl: string,
  headers: Record<string, string>,
  timeout: number
): Promise<HealthCheckResult & { count: number | null; sampleSkill: SkillRecord | null }> {
  const start = Date.now()
  const name = 'Skills Table Has Data'

  try {
    // Get count using Prefer header for exact count
    const countResponse = await fetchWithTimeout(
      `${baseUrl}/rest/v1/skills?select=count`,
      {
        method: 'HEAD',
        headers: {
          ...headers,
          Prefer: 'count=exact',
        },
      },
      timeout
    )

    let count: number | null = null
    const contentRange = countResponse.headers.get('content-range')
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/)
      if (match) {
        count = parseInt(match[1], 10)
      }
    }

    // If HEAD didn't give us count, try a different approach
    if (count === null) {
      const selectResponse = await fetchWithTimeout(
        `${baseUrl}/rest/v1/skills?select=id`,
        {
          method: 'GET',
          headers: {
            ...headers,
            Prefer: 'count=exact',
          },
        },
        timeout
      )

      const rangeHeader = selectResponse.headers.get('content-range')
      if (rangeHeader) {
        const match = rangeHeader.match(/\/(\d+)$/)
        if (match) {
          count = parseInt(match[1], 10)
        }
      }
    }

    // Get a sample skill for data integrity check
    const sampleResponse = await fetchWithTimeout(
      `${baseUrl}/rest/v1/skills?select=id,name,description,trust_tier,quality_score,tags&limit=1`,
      { method: 'GET', headers },
      timeout
    )

    let sampleSkill: SkillRecord | null = null
    if (sampleResponse.ok) {
      const data = await sampleResponse.json()
      if (Array.isArray(data) && data.length > 0) {
        sampleSkill = data[0] as SkillRecord
      }
    }

    const durationMs = Date.now() - start

    if (count !== null && count > 0) {
      return {
        name,
        status: 'pass',
        message: `Found ${count.toLocaleString()} skills in database`,
        durationMs,
        count,
        sampleSkill,
        details: { count },
      }
    }

    if (count === 0) {
      return {
        name,
        status: 'fail',
        message: 'Skills table is empty (0 records)',
        durationMs,
        count: 0,
        sampleSkill: null,
      }
    }

    return {
      name,
      status: 'fail',
      message: 'Unable to determine skill count',
      durationMs,
      count: null,
      sampleSkill: null,
    }
  } catch (error) {
    const durationMs = Date.now() - start
    const message = error instanceof Error ? error.message : String(error)
    return {
      name,
      status: 'fail',
      message: `Data check failed: ${message}`,
      durationMs,
      count: null,
      sampleSkill: null,
    }
  }
}

async function checkSearchFunctionality(
  baseUrl: string,
  headers: Record<string, string>,
  timeout: number
): Promise<HealthCheckResult> {
  const start = Date.now()
  const name = 'Search Functionality'

  try {
    // Test ILIKE search - a common search pattern
    const response = await fetchWithTimeout(
      `${baseUrl}/rest/v1/skills?name=ilike.*test*&limit=5`,
      { method: 'GET', headers },
      timeout
    )

    const durationMs = Date.now() - start

    if (response.ok) {
      const data = await response.json()
      const resultCount = Array.isArray(data) ? data.length : 0

      return {
        name,
        status: 'pass',
        message: `ILIKE search works (${resultCount} results for "test")`,
        durationMs,
        details: { searchTerm: 'test', resultCount },
      }
    }

    const errorText = await response.text()
    return {
      name,
      status: 'fail',
      message: `Search query failed: ${response.status} - ${errorText.substring(0, 100)}`,
      durationMs,
    }
  } catch (error) {
    const durationMs = Date.now() - start
    const message = error instanceof Error ? error.message : String(error)
    return {
      name,
      status: 'fail',
      message: `Search test failed: ${message}`,
      durationMs,
    }
  }
}

function checkResponseTime(checks: HealthCheckResult[]): HealthCheckResult {
  const avgResponseTime =
    checks.length > 0 ? checks.reduce((sum, c) => sum + c.durationMs, 0) / checks.length : 0

  const maxResponseTime = checks.length > 0 ? Math.max(...checks.map((c) => c.durationMs)) : 0

  const allUnderThreshold = checks.every((c) => c.durationMs < RESPONSE_TIME_THRESHOLD_MS)

  if (allUnderThreshold) {
    return {
      name: 'Response Time',
      status: 'pass',
      message: `All checks under ${RESPONSE_TIME_THRESHOLD_MS}ms threshold (avg: ${avgResponseTime.toFixed(0)}ms)`,
      durationMs: 0,
      details: {
        avgMs: Math.round(avgResponseTime),
        maxMs: maxResponseTime,
        thresholdMs: RESPONSE_TIME_THRESHOLD_MS,
      },
    }
  }

  const slowChecks = checks.filter((c) => c.durationMs >= RESPONSE_TIME_THRESHOLD_MS)
  return {
    name: 'Response Time',
    status: 'fail',
    message: `${slowChecks.length} check(s) exceeded ${RESPONSE_TIME_THRESHOLD_MS}ms threshold`,
    durationMs: 0,
    details: {
      avgMs: Math.round(avgResponseTime),
      maxMs: maxResponseTime,
      thresholdMs: RESPONSE_TIME_THRESHOLD_MS,
      slowChecks: slowChecks.map((c) => ({ name: c.name, durationMs: c.durationMs })),
    },
  }
}

// =============================================================================
// Output Formatters
// =============================================================================

function printHumanReadable(report: HealthCheckReport, verbose: boolean): void {
  const statusSymbol = report.healthy ? '\x1b[32m[HEALTHY]\x1b[0m' : '\x1b[31m[UNHEALTHY]\x1b[0m'

  console.log('')
  console.log('='.repeat(60))
  console.log(`Skillsmith Supabase Health Check ${statusSymbol}`)
  console.log('='.repeat(60))
  console.log(`Timestamp: ${report.timestamp}`)
  console.log(`Supabase URL: ${report.supabaseUrl}`)
  console.log('')

  console.log('Checks:')
  console.log('-'.repeat(60))

  for (const check of report.checks) {
    const icon = check.status === 'pass' ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m'
    const duration = `(${check.durationMs}ms)`

    console.log(`  ${icon} ${check.name} ${duration}`)
    console.log(`       ${check.message}`)

    if (verbose && check.details) {
      console.log(`       Details: ${JSON.stringify(check.details)}`)
    }
  }

  console.log('')
  console.log('Metrics:')
  console.log('-'.repeat(60))
  console.log(`  Total Skills: ${report.metrics.totalSkills?.toLocaleString() ?? 'Unknown'}`)
  console.log(`  Avg Response Time: ${report.metrics.avgResponseTimeMs.toFixed(0)}ms`)

  if (report.metrics.sampleSkill) {
    console.log('')
    console.log('  Sample Skill:')
    console.log(`    ID: ${report.metrics.sampleSkill.id}`)
    console.log(`    Name: ${report.metrics.sampleSkill.name}`)
    console.log(`    Trust Tier: ${report.metrics.sampleSkill.trust_tier}`)
  }

  console.log('')
  console.log('='.repeat(60))

  const passCount = report.checks.filter((c) => c.status === 'pass').length
  const totalCount = report.checks.length
  console.log(`Result: ${passCount}/${totalCount} checks passed`)

  if (!report.healthy) {
    console.log('')
    console.log('\x1b[33mTroubleshooting:\x1b[0m')
    console.log('  - Verify SUPABASE_URL is correct')
    console.log('  - Check if SUPABASE_ANON_KEY is set for authenticated access')
    console.log('  - Ensure the Supabase project is active and not paused')
    console.log('  - Run: npx tsx scripts/supabase/verify-schema.ts')
  }

  console.log('')
}

function printJson(report: HealthCheckReport): void {
  console.log(JSON.stringify(report, null, 2))
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  // Load environment variables from .env
  loadEnv()

  const options = parseArgs()

  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY

  const headers = getHeaders(anonKey)

  // Run all health checks
  const checks: HealthCheckResult[] = []

  // 1. API Reachability
  const apiCheck = await checkApiReachability(supabaseUrl, headers, options.timeout)
  checks.push(apiCheck)

  // Only continue if API is reachable
  if (apiCheck.status === 'pass') {
    // 2. Skills Table Accessible
    const tableCheck = await checkTableAccessible(supabaseUrl, headers, options.timeout)
    checks.push(tableCheck)

    // Only continue if table is accessible
    if (tableCheck.status === 'pass') {
      // 3. Skills Table Has Data
      const dataCheck = await checkTableHasData(supabaseUrl, headers, options.timeout)
      checks.push(dataCheck)

      // 4. Search Functionality
      const searchCheck = await checkSearchFunctionality(supabaseUrl, headers, options.timeout)
      checks.push(searchCheck)
    }
  }

  // 5. Response Time (always run, uses results from other checks)
  const responseTimeCheck = checkResponseTime(checks.filter((c) => c.durationMs > 0))
  checks.push(responseTimeCheck)

  // Extract metrics
  const dataCheckResult = checks.find((c) => c.name === 'Skills Table Has Data') as
    | (HealthCheckResult & { count: number | null; sampleSkill: SkillRecord | null })
    | undefined

  const avgResponseTime =
    checks.filter((c) => c.durationMs > 0).length > 0
      ? checks.filter((c) => c.durationMs > 0).reduce((sum, c) => sum + c.durationMs, 0) /
        checks.filter((c) => c.durationMs > 0).length
      : 0

  // Build report
  const report: HealthCheckReport = {
    healthy: checks.every((c) => c.status === 'pass'),
    timestamp: new Date().toISOString(),
    supabaseUrl,
    checks,
    metrics: {
      totalSkills: dataCheckResult?.count ?? null,
      avgResponseTimeMs: Math.round(avgResponseTime),
      sampleSkill: dataCheckResult?.sampleSkill
        ? {
            id: dataCheckResult.sampleSkill.id,
            name: dataCheckResult.sampleSkill.name,
            trust_tier: dataCheckResult.sampleSkill.trust_tier,
          }
        : null,
    },
  }

  // Output results
  if (options.json) {
    printJson(report)
  } else {
    printHumanReadable(report, options.verbose)
  }

  // Exit with appropriate code
  process.exit(report.healthy ? 0 : 1)
}

main().catch((error) => {
  console.error('Health check failed with error:', error)
  process.exit(1)
})
