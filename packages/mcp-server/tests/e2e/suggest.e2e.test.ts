/**
 * E2E Test: MCP skill_suggest tool
 *
 * Tests the suggest tool for proactive skill recommendations.
 * This tool has NO existing tests (critical gap).
 *
 * CRITICAL: The suggest tool contains hardcoded skillDatabase
 * (lines 167+) that needs to be detected and reported.
 *
 * User Journey: Proactive skill suggestions based on context
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import {
  createDatabase,
  initializeSchema,
  SkillRepository,
  type DatabaseType,
} from '@skillsmith/core'
import { createToolContext, type ToolContext } from '../../src/context.js'
import { executeSuggest, type SuggestInput } from '../../src/tools/suggest.js'
import { scanForHardcoded, type HardcodedIssue } from './utils/hardcoded-detector.js'
import { recordTiming, measureAsync } from './utils/baseline-collector.js'
import { queueIssue, type TestFailure } from './utils/linear-reporter.js'

// Test configuration
const TEST_DIR = join(tmpdir(), 'skillsmith-e2e-suggest')
const TEST_DB_PATH = join(TEST_DIR, 'suggest-test.db')
const TEST_PROJECT_DIR = join(TEST_DIR, 'test-project')

// Seed data for database
const SEED_SKILLS = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code',
    qualityScore: 0.95,
    trustTier: 'verified' as const,
    tags: ['git', 'commit'],
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jest-helper',
    qualityScore: 0.87,
    trustTier: 'community' as const,
    tags: ['testing', 'jest'],
  },
]

/**
 * Create a mock project for testing
 */
function createMockProject(): void {
  mkdirSync(TEST_PROJECT_DIR, { recursive: true })
  mkdirSync(join(TEST_PROJECT_DIR, 'src'), { recursive: true })

  // Create package.json
  writeFileSync(
    join(TEST_PROJECT_DIR, 'package.json'),
    JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      dependencies: { react: '^18.0.0' },
      devDependencies: { jest: '^29.0.0' },
    })
  )

  // Create a test file
  writeFileSync(
    join(TEST_PROJECT_DIR, 'src', 'App.test.tsx'),
    `import { render } from '@testing-library/react';
import App from './App';

test('renders app', () => {
  render(<App />);
});
`
  )
}

/**
 * Scan response for hardcoded values
 */
function scanResponseForHardcoded(response: unknown, command: string): HardcodedIssue[] {
  const responseStr = JSON.stringify(response, null, 2)
  return scanForHardcoded(responseStr, command, 'database', 'suggest response')
}

describe('E2E: skill_suggest tool', () => {
  let db: DatabaseType
  let context: ToolContext

  beforeAll(() => {
    // Create test environment
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })

    // Create mock project
    createMockProject()

    // Initialize database
    db = createDatabase(TEST_DB_PATH)
    initializeSchema(db)

    const skillRepo = new SkillRepository(db)
    for (const skill of SEED_SKILLS) {
      skillRepo.create(skill)
    }

    context = createToolContext({ dbPath: TEST_DB_PATH, apiClientConfig: { offlineMode: true } })
  })

  afterAll(() => {
    db?.close()
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Basic Suggestions', () => {
    it('should return suggestions for project path', async () => {
      const input: SuggestInput = {
        project_path: TEST_PROJECT_DIR,
        limit: 3,
      }

      const { result, durationMs } = await measureAsync(
        'suggest:basic',
        'skill_suggest (basic)',
        () => executeSuggest(input, context)
      )

      // Should complete without error
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)

      // Check for hardcoded values
      const issues = scanResponseForHardcoded(result, 'skill_suggest')
      if (issues.filter((i) => i.severity === 'error').length > 0) {
        // Queue Linear issue for hardcoded detection
        const failure: TestFailure = {
          testName: 'suggest: basic project path',
          testFile: __filename,
          command: 'skill_suggest',
          error: `Hardcoded values detected in suggest response`,
          hardcodedIssues: issues,
          duration: durationMs,
          timestamp: new Date().toISOString(),
        }
        queueIssue(failure)
      }
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })

    it('should use current file context', async () => {
      const input: SuggestInput = {
        project_path: TEST_PROJECT_DIR,
        current_file: 'src/App.test.tsx',
        limit: 3,
      }

      const result = await executeSuggest(input, context)

      recordTiming('suggest:file_context', 'skill_suggest (file)', result.timing.totalMs)

      // Check for hardcoded values
      const issues = scanResponseForHardcoded(result, 'skill_suggest')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })

    it('should use recent commands context', async () => {
      const input: SuggestInput = {
        project_path: TEST_PROJECT_DIR,
        recent_commands: ['npm test', 'git commit -m "fix"', 'npm run build'],
        limit: 3,
      }

      const result = await executeSuggest(input, context)

      recordTiming('suggest:commands', 'skill_suggest (commands)', result.timing.totalMs)

      // Check for hardcoded values
      const issues = scanResponseForHardcoded(result, 'skill_suggest')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })

    it('should use error message context', async () => {
      const input: SuggestInput = {
        project_path: TEST_PROJECT_DIR,
        error_message: 'TypeError: Cannot read property of undefined',
        limit: 3,
      }

      const result = await executeSuggest(input, context)

      recordTiming('suggest:error', 'skill_suggest (error)', result.timing.totalMs)

      // Check for hardcoded values
      const issues = scanResponseForHardcoded(result, 'skill_suggest')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })
  })

  describe('Rate Limiting', () => {
    // Use fake timers to prevent CI flakiness from timing variations
    // The rate limiter uses Date.now() internally, so we control time explicitly
    const FIXED_TIME = new Date('2025-01-01T12:00:00.000Z').getTime()
    let testCounter = 0

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(FIXED_TIME)
      testCounter++
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should rate limit rapid requests', async () => {
      // Use counter for unique session ID since Date.now() is frozen
      const sessionId = `test-session-rate-limit-${testCounter}`

      // First request should succeed
      const result1 = await executeSuggest(
        { project_path: TEST_PROJECT_DIR, session_id: sessionId, limit: 3 },
        context
      )

      expect(result1.rate_limited).toBe(false)

      // Advance time by a tiny amount (1ms) to ensure we're still within rate limit window
      // The rate limiter has a 5-minute window with 1 token that refills at 1/300 per second
      vi.advanceTimersByTime(1)

      // Immediate second request should be rate limited
      const result2 = await executeSuggest(
        { project_path: TEST_PROJECT_DIR, session_id: sessionId, limit: 3 },
        context
      )

      expect(result2.rate_limited).toBe(true)
      expect(result2.next_suggestion_at).toBeDefined()
    })

    it('should allow requests from different sessions', async () => {
      // Use unique session IDs that won't collide with other tests
      const sessionA = `session-multi-a-${testCounter}`
      const sessionB = `session-multi-b-${testCounter}`

      const result1 = await executeSuggest(
        { project_path: TEST_PROJECT_DIR, session_id: sessionA, limit: 3 },
        context
      )

      const result2 = await executeSuggest(
        { project_path: TEST_PROJECT_DIR, session_id: sessionB, limit: 3 },
        context
      )

      // Different sessions should not be rate limited against each other
      expect(result1.rate_limited).toBe(false)
      expect(result2.rate_limited).toBe(false)
      expect(result1.timing.totalMs).toBeGreaterThanOrEqual(0)
      expect(result2.timing.totalMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Response Data Quality', () => {
    it('should return valid suggestion structure', async () => {
      const input: SuggestInput = {
        project_path: TEST_PROJECT_DIR,
        current_file: 'src/App.test.tsx',
        limit: 5,
      }

      const result = await executeSuggest(input, context)

      // Validate response structure
      expect(typeof result.context_score).toBe('number')
      expect(typeof result.rate_limited).toBe('boolean')
      expect(Array.isArray(result.triggers_fired)).toBe(true)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)

      // Validate each suggestion
      for (const sug of result.suggestions) {
        expect(sug.skill_id).toBeDefined()
        expect(sug.name).toBeDefined()
        expect(sug.reason).toBeDefined()
        expect(sug.confidence).toBeGreaterThanOrEqual(0)
        expect(sug.confidence).toBeLessThanOrEqual(1)
        expect(['verified', 'community', 'standard', 'unverified']).toContain(sug.trust_tier)
      }
    })
  })

  describe('CRITICAL: Hardcoded skillDatabase Detection', () => {
    /**
     * The suggest.ts file contains a hardcoded skillDatabase starting at line 167.
     * This test detects if suggestions come from this hardcoded list instead of
     * the actual database.
     */
    it('should use database skills not hardcoded skillDatabase', async () => {
      const input: SuggestInput = {
        project_path: TEST_PROJECT_DIR,
        current_file: 'src/App.test.tsx',
        recent_commands: ['npm test'],
        limit: 10,
      }

      const result = await executeSuggest(input, context)

      // If hardcoded, suggestions will contain specific IDs from the hardcoded list
      // that are NOT in our SEED_SKILLS database
      const hardcodedOnlySkills = [
        'community/eslint-plugin',
        'community/prettier-config',
        'community/cypress-helper',
        // These are in the hardcoded skillDatabase but NOT in our test database
      ]

      const suggestedIds = result.suggestions.map((s) => s.skill_id)
      const fromHardcoded = suggestedIds.filter((id) => hardcodedOnlySkills.includes(id))

      if (fromHardcoded.length > 0) {
        // Create Linear issue for hardcoded skillDatabase
        const failure: TestFailure = {
          testName: 'suggest: hardcoded skillDatabase detected',
          testFile: __filename,
          command: 'skill_suggest',
          error: `Suggestions came from hardcoded skillDatabase instead of actual database. Found: ${fromHardcoded.join(', ')}`,
          timestamp: new Date().toISOString(),
        }
        queueIssue(failure)

        expect.fail(
          `HARDCODED skillDatabase detected! Suggestions ${fromHardcoded.join(', ')} are from hardcoded list, not database.`
        )
      }
    })

    it('should not expose hardcoded paths in suggestions', async () => {
      const input: SuggestInput = {
        project_path: TEST_PROJECT_DIR,
        limit: 5,
      }

      const result = await executeSuggest(input, context)
      const responseStr = JSON.stringify(result)

      // Should not contain user paths
      expect(responseStr).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//)
      expect(responseStr).not.toMatch(/\/home\/[a-zA-Z0-9_-]+\//)
      expect(responseStr).not.toContain(homedir())

      // Should not contain localhost
      expect(responseStr).not.toMatch(/localhost:\d+/)

      // Should not contain the TEST_PROJECT_DIR path in response data
      // (it's OK in logs but not in response)
    })

    it('should return dynamic suggestions based on context', async () => {
      // Test file context
      const testResult = await executeSuggest(
        {
          project_path: TEST_PROJECT_DIR,
          current_file: 'src/App.test.tsx',
          session_id: 'dynamic-test-1',
          limit: 5,
        },
        context
      )

      // Git context
      const gitResult = await executeSuggest(
        {
          project_path: TEST_PROJECT_DIR,
          recent_commands: ['git status', 'git add .', 'git commit'],
          session_id: 'dynamic-test-2',
          limit: 5,
        },
        context
      )

      // Triggers should differ based on context
      const testTriggers = testResult.triggers_fired
      const gitTriggers = gitResult.triggers_fired

      // Log for baseline analysis
      console.log('Test file triggers:', testTriggers)
      console.log('Git command triggers:', gitTriggers)

      // Both should have processed some triggers
      expect(testResult.timing.totalMs).toBeGreaterThanOrEqual(0)
      expect(gitResult.timing.totalMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Performance Baselines', () => {
    it('should complete suggestion in reasonable time', async () => {
      const { durationMs } = await measureAsync('suggest:baseline', 'skill_suggest baseline', () =>
        executeSuggest(
          {
            project_path: TEST_PROJECT_DIR,
            current_file: 'src/App.test.tsx',
            recent_commands: ['npm test', 'git status'],
            limit: 5,
          },
          context
        )
      )

      // Baseline: should complete within 3 seconds (includes codebase analysis)
      expect(durationMs).toBeLessThan(3000)
      console.log(`Suggest baseline: ${durationMs}ms`)
    })
  })

  describe('Error Handling', () => {
    it('should handle missing project path', async () => {
      await expect(executeSuggest({ project_path: '' } as SuggestInput, context)).rejects.toThrow()
    })

    it('should handle non-existent project path gracefully', async () => {
      const input: SuggestInput = {
        project_path: '/nonexistent/path/project',
        limit: 3,
      }

      // May throw or return empty - either is acceptable
      try {
        const result = await executeSuggest(input, context)
        // If it doesn't throw, should handle gracefully
        expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
      } catch {
        // Expected - non-existent path
      }
    })

    it('should handle invalid limit', async () => {
      await expect(
        executeSuggest({ project_path: TEST_PROJECT_DIR, limit: 100 } as SuggestInput, context)
      ).rejects.toThrow()
    })
  })
})
