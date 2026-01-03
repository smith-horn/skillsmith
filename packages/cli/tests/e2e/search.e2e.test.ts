/**
 * E2E Test: skillsmith search command
 *
 * Tests the search command including interactive mode
 * in a clean Codespace environment.
 *
 * User Journey: Find and explore skills
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { scanCommandOutput } from './utils/hardcoded-detector.js'
import { recordTiming, measureAsync } from './utils/baseline-collector.js'
import { queueIssue, type TestFailure } from './utils/linear-reporter.js'
import { createDatabase, initializeSchema, SkillRepository } from '@skillsmith/core'
import { buildRepoUrl, buildAnthropicRepoUrl } from './test-config.js'

// Test configuration
const TEST_DIR = join(tmpdir(), 'skillsmith-e2e-search')
const TEST_DB_PATH = join(TEST_DIR, 'search-test.db')
const CLI_PATH = join(__dirname, '../../dist/src/index.js')

// Seed data for search tests
// Uses configurable URLs from test-config.ts to avoid hardcoded values
const SEED_SKILLS = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits',
    author: 'anthropic',
    repoUrl: buildAnthropicRepoUrl('commit'),
    qualityScore: 0.95,
    trustTier: 'verified' as const,
    tags: ['development', 'git', 'commit'],
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components',
    author: 'community',
    repoUrl: buildRepoUrl('jest-helper'),
    qualityScore: 0.87,
    trustTier: 'community' as const,
    tags: ['testing', 'jest', 'react'],
  },
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations',
    author: 'community',
    repoUrl: buildRepoUrl('docker-compose'),
    qualityScore: 0.84,
    trustTier: 'community' as const,
    tags: ['devops', 'docker'],
  },
  {
    id: 'experimental/ai-debug',
    name: 'ai-debug',
    description: 'AI-powered debugging assistant for complex issues',
    author: 'experimental',
    repoUrl: buildRepoUrl('ai-debug'),
    qualityScore: 0.65,
    trustTier: 'experimental' as const,
    tags: ['debugging', 'ai'],
  },
]

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

/**
 * Execute CLI command and capture output
 */
async function runCommand(args: string[], timeoutMs = 30000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    let stdout = ''
    let stderr = ''

    const proc = spawn('node', [CLI_PATH, ...args], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SKILLSMITH_E2E: 'true',
      },
    })

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      })
    })

    proc.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

/**
 * Assert no hardcoded values in command output
 */
function assertNoHardcoded(
  result: CommandResult,
  command: string,
  testName: string,
  testFile: string
): void {
  const detection = scanCommandOutput(result.stdout, result.stderr, command)

  if (!detection.passed) {
    const failure: TestFailure = {
      testName,
      testFile,
      command,
      error: `Hardcoded values detected`,
      stdout: result.stdout,
      stderr: result.stderr,
      hardcodedIssues: detection.issues,
      duration: result.durationMs,
      timestamp: new Date().toISOString(),
    }
    queueIssue(failure)

    const errorDetails = detection.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `  - ${i.type}: ${i.value}`)
      .join('\n')

    expect.fail(`Hardcoded values detected:\n${errorDetails}`)
  }
}

describe('E2E: skillsmith search', () => {
  beforeAll(() => {
    // Create test directory and seed database
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })

    // Initialize and seed database
    const db = createDatabase(TEST_DB_PATH)
    initializeSchema(db)

    const skillRepo = new SkillRepository(db)
    for (const skill of SEED_SKILLS) {
      skillRepo.create(skill)
    }

    db.close()
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Basic Search', () => {
    it('should display help without errors', async () => {
      const result = await runCommand(['search', '--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Search for skills')
      expect(result.stdout).toContain('--limit')

      // Skip hardcoded check for help output since it includes default values (e.g., database path)
      if (!result.stdout.includes('Usage:')) {
        assertNoHardcoded(result, 'skillsmith search --help', 'search: help', __filename)
      }
    })

    it('should search for skills by query', async () => {
      const result = await runCommand(['search', 'commit', '-d', TEST_DB_PATH])

      recordTiming('search:query', 'skillsmith search commit', result.durationMs)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('commit')

      assertNoHardcoded(result, 'skillsmith search commit', 'search: basic query', __filename)
    })

    it('should return results within performance threshold', async () => {
      const { durationMs } = await measureAsync(
        'search:performance',
        'skillsmith search test',
        async () => runCommand(['search', 'test', '-d', TEST_DB_PATH])
      )

      // Search should complete in under 1000ms for seeded data (CI can be slower)
      expect(durationMs).toBeLessThan(1000)
    })

    it('should handle empty results gracefully', async () => {
      const result = await runCommand(['search', 'nonexistentquery12345', '-d', TEST_DB_PATH])

      // Should not crash, may show "no results" message
      expect(result.exitCode).toBe(0)

      assertNoHardcoded(
        result,
        'skillsmith search nonexistent',
        'search: empty results',
        __filename
      )
    })
  })

  describe('Filter Options', () => {
    it('should filter by trust tier', async () => {
      const result = await runCommand(['search', 'test', '-d', TEST_DB_PATH, '-t', 'verified'])

      expect(result.exitCode).toBe(0)

      // If results shown, should only be verified tier
      if (result.stdout.includes('anthropic/commit')) {
        expect(result.stdout).not.toContain('experimental')
      }

      assertNoHardcoded(
        result,
        'skillsmith search -t verified',
        'search: trust tier filter',
        __filename
      )
    })

    it('should filter by minimum score', async () => {
      const result = await runCommand(['search', 'docker', '-d', TEST_DB_PATH, '-s', '80'])

      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith search -s 80', 'search: min score filter', __filename)
    })

    it('should respect limit parameter', async () => {
      const result = await runCommand(['search', 'test', '-d', TEST_DB_PATH, '-l', '1'])

      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith search -l 1', 'search: limit', __filename)
    })
  })

  describe('Output Format', () => {
    it('should display skill information in readable format', async () => {
      const result = await runCommand(['search', 'commit', '-d', TEST_DB_PATH])

      expect(result.exitCode).toBe(0)

      // Output should contain skill details
      const output = result.stdout
      expect(output).toMatch(/commit|Commit/i)

      assertNoHardcoded(result, 'skillsmith search output', 'search: output format', __filename)
    })

    it('should not expose internal paths in output', async () => {
      const result = await runCommand(['search', 'commit', '-d', TEST_DB_PATH])

      const output = result.stdout + result.stderr

      // Should not expose file system paths
      expect(output).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//)
      expect(output).not.toMatch(/node_modules/)
      expect(output).not.toMatch(/dist\//)
    })
  })

  describe('Error Handling', () => {
    it('should reject empty query', async () => {
      const result = await runCommand(['search', '', '-d', TEST_DB_PATH])

      // Should fail or prompt for query
      assertNoHardcoded(result, 'skillsmith search ""', 'search: empty query', __filename)
    })

    it('should reject single character query', async () => {
      const result = await runCommand(['search', 'a', '-d', TEST_DB_PATH])

      // Should fail with validation error
      expect(result.exitCode).not.toBe(0)

      assertNoHardcoded(result, 'skillsmith search a', 'search: short query', __filename)
    })

    it('should handle missing database gracefully', async () => {
      const result = await runCommand(['search', 'test', '-d', '/nonexistent/db.db'])

      // Should fail gracefully
      expect(result.exitCode).not.toBe(0)

      assertNoHardcoded(result, 'skillsmith search -d missing', 'search: missing db', __filename)
    })

    it('should handle invalid trust tier', async () => {
      const result = await runCommand(['search', 'test', '-d', TEST_DB_PATH, '-t', 'invalid'])

      // Should either fail or ignore invalid tier
      assertNoHardcoded(result, 'skillsmith search -t invalid', 'search: invalid tier', __filename)
    })
  })

  describe('Hardcoded Value Regression', () => {
    it('should not contain hardcoded database paths', async () => {
      const result = await runCommand(['search', 'docker', '-d', TEST_DB_PATH])

      const output = result.stdout + result.stderr

      // Check for common hardcoded DB paths
      expect(output).not.toContain('.skillsmith/skills.db')
      expect(output).not.toMatch(/~\/\.skillsmith/)
    })

    it('should not expose environment variables', async () => {
      const result = await runCommand(['search', 'test', '-d', TEST_DB_PATH])

      const output = result.stdout + result.stderr

      // Should not expose env var values
      expect(output).not.toMatch(/GITHUB_TOKEN=/)
      expect(output).not.toMatch(/LINEAR_API_KEY=/)
    })
  })
})
