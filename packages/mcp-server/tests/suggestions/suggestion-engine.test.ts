/**
 * Unit tests for SMI-913: Contextual skill suggestions after first success
 * Tests the SuggestionEngine class comprehensively
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SuggestionEngine } from '../../src/suggestions/suggestion-engine.js'
import type { ProjectContext } from '../../src/context/project-detector.js'
import type { SuggestionState } from '../../src/suggestions/types.js'

// Create test directory path
const TEST_BASE_DIR = path.join(os.tmpdir(), 'skillsmith-suggestion-test')
let testDir: string

/**
 * Helper to create a mock ProjectContext
 */
function createMockContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    hasDocker: false,
    hasLinear: false,
    hasGitHub: false,
    testFramework: null,
    apiFramework: null,
    hasNativeModules: false,
    language: null,
    ...overrides,
  }
}

/**
 * Helper to create a mock state file
 */
function writeMockState(stateDir: string, state: Partial<SuggestionState>): void {
  const fullState: SuggestionState = {
    lastSuggestionTime: 0,
    suggestionsToday: 0,
    optedOut: false,
    dismissedSkills: [],
    ...state,
  }
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true })
  }
  fs.writeFileSync(
    path.join(stateDir, 'suggestions-state.json'),
    JSON.stringify(fullState, null, 2)
  )
}

/**
 * Clean up test directory
 */
function cleanupTestDir(): void {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true })
  }
}

/**
 * Create a SuggestionEngine with test state directory
 */
function createTestEngine(
  config: Partial<{ cooldownMs: number; maxSuggestionsPerDay: number }> = {}
) {
  return new SuggestionEngine({ ...config, stateDir: testDir })
}

describe('SuggestionEngine', () => {
  beforeAll(() => {
    // Ensure base test directory exists
    if (!fs.existsSync(TEST_BASE_DIR)) {
      fs.mkdirSync(TEST_BASE_DIR, { recursive: true })
    }
  })

  afterAll(() => {
    // Clean up base test directory
    if (fs.existsSync(TEST_BASE_DIR)) {
      fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    // Create unique directory for each test
    testDir = path.join(TEST_BASE_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    cleanupTestDir()
  })

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const engine = createTestEngine()
      const state = engine.getState()

      expect(state.optedOut).toBe(false)
      expect(state.suggestionsToday).toBe(0)
      expect(state.dismissedSkills).toEqual([])
    })

    it('should accept custom config', () => {
      const engine = createTestEngine({
        cooldownMs: 10 * 60 * 1000,
        maxSuggestionsPerDay: 5,
      })

      // Engine should still work with custom config
      expect(engine.canSuggest()).toBe(true)
    })

    it('should load existing state from disk', () => {
      // Set lastSuggestionTime to today so the daily count doesn't reset
      writeMockState(testDir, {
        lastSuggestionTime: Date.now(),
        suggestionsToday: 2,
        dismissedSkills: ['community/docker'],
      })

      const engine = createTestEngine()
      const state = engine.getState()

      expect(state.suggestionsToday).toBe(2)
      expect(state.dismissedSkills).toContain('community/docker')
    })

    it('should reset daily count on new day', () => {
      // Write state from yesterday
      const yesterday = Date.now() - 24 * 60 * 60 * 1000
      writeMockState(testDir, {
        lastSuggestionTime: yesterday,
        suggestionsToday: 3,
      })

      const engine = createTestEngine()
      const state = engine.getState()

      expect(state.suggestionsToday).toBe(0)
    })

    it('should handle corrupted state file gracefully', () => {
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true })
      }
      fs.writeFileSync(path.join(testDir, 'suggestions-state.json'), '{ invalid json }')

      const engine = createTestEngine()
      const state = engine.getState()

      expect(state.optedOut).toBe(false)
      expect(state.suggestionsToday).toBe(0)
    })
  })

  describe('canSuggest', () => {
    it('should return true by default', () => {
      const engine = createTestEngine()
      expect(engine.canSuggest()).toBe(true)
    })

    it('should return false when opted out', () => {
      const engine = createTestEngine()
      engine.optOut()
      expect(engine.canSuggest()).toBe(false)
    })

    it('should return false when daily limit reached', () => {
      const engine = createTestEngine({ maxSuggestionsPerDay: 3 })

      // Simulate showing 3 suggestions
      engine.recordSuggestionShown()
      engine.recordSuggestionShown()
      engine.recordSuggestionShown()

      expect(engine.canSuggest()).toBe(false)
    })

    it('should return false during cooldown period', () => {
      const engine = createTestEngine({ cooldownMs: 5 * 60 * 1000 })

      engine.recordSuggestionShown()

      // Should be in cooldown immediately after showing
      expect(engine.canSuggest()).toBe(false)
    })

    it('should return true after cooldown expires', async () => {
      // Use 100ms cooldown for testing
      const engine = createTestEngine({ cooldownMs: 100 })

      engine.recordSuggestionShown()

      // Wait for cooldown
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(engine.canSuggest()).toBe(true)
    })
  })

  describe('getSuggestions', () => {
    it('should return empty array when opted out', () => {
      const engine = createTestEngine()
      engine.optOut()

      const context = createMockContext({ hasDocker: true, hasNativeModules: true })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toEqual([])
    })

    it('should return empty array when rate limited', () => {
      const engine = createTestEngine({ maxSuggestionsPerDay: 1 })
      engine.recordSuggestionShown()

      const context = createMockContext({ hasDocker: true, hasNativeModules: true })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toEqual([])
    })

    it('should suggest docker for native modules + docker projects', () => {
      const engine = createTestEngine()

      const context = createMockContext({ hasDocker: true, hasNativeModules: true })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].skillId).toBe('community/docker')
      expect(suggestions[0].skillName).toBe('docker')
      expect(suggestions[0].reason).toContain('native modules')
    })

    it('should suggest linear for Linear-integrated projects', () => {
      const engine = createTestEngine()

      const context = createMockContext({ hasLinear: true })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].skillId).toBe('user/linear')
      expect(suggestions[0].skillName).toBe('linear')
    })

    it('should suggest review-pr for GitHub projects', () => {
      const engine = createTestEngine()

      const context = createMockContext({ hasGitHub: true })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].skillId).toBe('anthropic/review-pr')
      expect(suggestions[0].skillName).toBe('review-pr')
    })

    it('should suggest jest-helper for Jest projects', () => {
      const engine = createTestEngine()

      const context = createMockContext({ testFramework: 'jest' })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].skillId).toBe('community/jest-helper')
      expect(suggestions[0].skillName).toBe('jest-helper')
    })

    it('should suggest vitest-helper for Vitest projects', () => {
      const engine = createTestEngine()

      const context = createMockContext({ testFramework: 'vitest' })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].skillId).toBe('community/vitest-helper')
      expect(suggestions[0].skillName).toBe('vitest-helper')
    })

    it('should suggest api-docs for Express projects', () => {
      const engine = createTestEngine()

      const context = createMockContext({ apiFramework: 'express' })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].skillId).toBe('community/api-docs')
      expect(suggestions[0].skillName).toBe('api-docs')
    })

    it('should suggest api-docs for Next.js projects', () => {
      const engine = createTestEngine()

      const context = createMockContext({ apiFramework: 'nextjs' })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].skillId).toBe('community/api-docs')
      expect(suggestions[0].skillName).toBe('api-docs')
    })

    it('should not suggest FastAPI for api-docs (only express/nextjs)', () => {
      const engine = createTestEngine()

      const context = createMockContext({ apiFramework: 'fastapi' })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(0)
    })

    it('should filter out installed skills', () => {
      const engine = createTestEngine()

      const context = createMockContext({ hasLinear: true })
      const suggestions = engine.getSuggestions(context, ['user/linear'])

      expect(suggestions).toHaveLength(0)
    })

    it('should filter out installed skills by partial name match', () => {
      const engine = createTestEngine()

      const context = createMockContext({ hasLinear: true })
      // Match by skill name within the installed skill ID
      const suggestions = engine.getSuggestions(context, ['some-prefix/linear'])

      expect(suggestions).toHaveLength(0)
    })

    it('should filter out dismissed skills', () => {
      const engine = createTestEngine()
      engine.dismissSkill('user/linear')

      const context = createMockContext({ hasLinear: true })
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(0)
    })

    it('should return highest priority suggestion when multiple match', () => {
      const engine = createTestEngine()

      // Docker + native modules (priority 1) + GitHub (priority 2)
      const context = createMockContext({
        hasDocker: true,
        hasNativeModules: true,
        hasGitHub: true,
      })

      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].skillName).toBe('docker')
      expect(suggestions[0].priority).toBe(1)
    })

    it('should include context matches in suggestion', () => {
      const engine = createTestEngine()

      const context = createMockContext({
        hasDocker: true,
        hasNativeModules: true,
        hasGitHub: true,
        testFramework: 'jest',
      })

      const suggestions = engine.getSuggestions(context)

      expect(suggestions[0].contextMatch).toContain('hasDocker')
      expect(suggestions[0].contextMatch).toContain('hasNativeModules')
      expect(suggestions[0].contextMatch).toContain('hasGitHub')
      expect(suggestions[0].contextMatch).toContain('testFramework:jest')
    })

    it('should return empty array for empty context', () => {
      const engine = createTestEngine()

      const context = createMockContext()
      const suggestions = engine.getSuggestions(context)

      expect(suggestions).toEqual([])
    })
  })

  describe('recordSuggestionShown', () => {
    it('should increment suggestionsToday', () => {
      const engine = createTestEngine()

      engine.recordSuggestionShown()
      expect(engine.getState().suggestionsToday).toBe(1)

      engine.recordSuggestionShown()
      expect(engine.getState().suggestionsToday).toBe(2)
    })

    it('should update lastSuggestionTime', () => {
      const engine = createTestEngine()
      const before = Date.now()

      engine.recordSuggestionShown()

      const state = engine.getState()
      expect(state.lastSuggestionTime).toBeGreaterThanOrEqual(before)
      expect(state.lastSuggestionTime).toBeLessThanOrEqual(Date.now())
    })

    it('should persist state to disk', () => {
      const engine = createTestEngine()
      engine.recordSuggestionShown()

      // Create new engine to load from disk
      const engine2 = createTestEngine()
      expect(engine2.getState().suggestionsToday).toBe(1)
    })
  })

  describe('dismissSkill', () => {
    it('should add skill to dismissed list', () => {
      const engine = createTestEngine()

      engine.dismissSkill('community/docker')

      expect(engine.getState().dismissedSkills).toContain('community/docker')
    })

    it('should not duplicate dismissed skills', () => {
      const engine = createTestEngine()

      engine.dismissSkill('community/docker')
      engine.dismissSkill('community/docker')

      expect(
        engine.getState().dismissedSkills.filter((s) => s === 'community/docker')
      ).toHaveLength(1)
    })

    it('should persist dismissed skills to disk', () => {
      const engine = createTestEngine()
      engine.dismissSkill('user/linear')

      const engine2 = createTestEngine()
      expect(engine2.getState().dismissedSkills).toContain('user/linear')
    })
  })

  describe('optOut/optIn', () => {
    it('should set optedOut to true', () => {
      const engine = createTestEngine()

      engine.optOut()

      expect(engine.getState().optedOut).toBe(true)
    })

    it('should persist opt-out to disk', () => {
      const engine = createTestEngine()
      engine.optOut()

      const engine2 = createTestEngine()
      expect(engine2.getState().optedOut).toBe(true)
    })

    it('should re-enable suggestions with optIn', () => {
      const engine = createTestEngine()
      engine.optOut()
      expect(engine.canSuggest()).toBe(false)

      engine.optIn()

      expect(engine.getState().optedOut).toBe(false)
      expect(engine.canSuggest()).toBe(true)
    })

    it('should persist opt-in to disk', () => {
      const engine = createTestEngine()
      engine.optOut()
      engine.optIn()

      const engine2 = createTestEngine()
      expect(engine2.getState().optedOut).toBe(false)
    })
  })

  describe('resetState', () => {
    it('should reset all state to defaults', () => {
      const engine = createTestEngine()

      engine.recordSuggestionShown()
      engine.dismissSkill('community/docker')
      engine.optOut()

      engine.resetState()

      const state = engine.getState()
      expect(state.suggestionsToday).toBe(0)
      expect(state.dismissedSkills).toEqual([])
      expect(state.optedOut).toBe(false)
      expect(state.lastSuggestionTime).toBe(0)
    })

    it('should persist reset state to disk', () => {
      const engine = createTestEngine()
      engine.optOut()
      engine.dismissSkill('user/linear')

      engine.resetState()

      const engine2 = createTestEngine()
      expect(engine2.getState().optedOut).toBe(false)
      expect(engine2.getState().dismissedSkills).toEqual([])
    })
  })

  describe('getState', () => {
    it('should return a copy of the state', () => {
      const engine = createTestEngine()
      const state = engine.getState()

      // Modifying the returned state should not affect the engine
      state.optedOut = true
      state.dismissedSkills.push('modified')

      expect(engine.getState().optedOut).toBe(false)
      expect(engine.getState().dismissedSkills).not.toContain('modified')
    })
  })

  describe('daily reset behavior', () => {
    it('should maintain count on same day', () => {
      const engine = createTestEngine()
      engine.recordSuggestionShown()
      engine.recordSuggestionShown()

      // Load fresh engine on same day
      const engine2 = createTestEngine()
      expect(engine2.getState().suggestionsToday).toBe(2)
    })

    it('should not reset count when loading multiple times on same day', () => {
      const engine1 = createTestEngine()
      engine1.recordSuggestionShown()

      const engine2 = createTestEngine()
      engine2.recordSuggestionShown()

      const engine3 = createTestEngine()
      expect(engine3.getState().suggestionsToday).toBe(2)
    })
  })

  describe('edge cases', () => {
    it('should handle missing state directory', () => {
      // Remove the test directory
      fs.rmSync(testDir, { recursive: true, force: true })

      // Directory should be created on first save
      const engine = createTestEngine()
      engine.recordSuggestionShown()

      expect(fs.existsSync(testDir)).toBe(true)
    })

    it('should handle concurrent modifications gracefully', () => {
      const engine1 = createTestEngine()
      const engine2 = createTestEngine()

      engine1.dismissSkill('skill1')
      engine2.dismissSkill('skill2')

      // Last write wins - this is acceptable behavior
      const engine3 = createTestEngine()
      // Should have skill2 (last write)
      expect(engine3.getState().dismissedSkills).toContain('skill2')
    })

    it('should work with zero cooldown', () => {
      const engine = createTestEngine({ cooldownMs: 0 })

      engine.recordSuggestionShown()

      // Should be able to suggest again immediately with zero cooldown
      expect(engine.canSuggest()).toBe(true)
    })

    it('should work with zero max suggestions per day', () => {
      const engine = createTestEngine({ maxSuggestionsPerDay: 0 })

      expect(engine.canSuggest()).toBe(false)
    })
  })
})
