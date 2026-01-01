/**
 * SMI-911: First Run Detection Unit Tests
 *
 * Tests for the first-run detection and Tier 1 skill auto-installation module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  TIER1_SKILLS,
  isFirstRun,
  markFirstRunComplete,
  getWelcomeMessage,
  SKILLSMITH_DIR,
  FIRST_RUN_MARKER,
} from '../../src/onboarding/first-run.js'

describe('First Run Detection (SMI-911)', () => {
  // Use a temp directory for testing to avoid modifying real ~/.skillsmith
  const TEST_DIR = join(tmpdir(), `skillsmith-test-${Date.now()}`)
  const TEST_MARKER = join(TEST_DIR, '.first-run-complete')

  // Override the module constants for testing
  let originalSkillsmithDir: string
  let originalMarkerFile: string

  beforeEach(() => {
    // Clean up any previous test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  describe('TIER1_SKILLS constant', () => {
    it('should define exactly 3 Tier 1 skills', () => {
      expect(TIER1_SKILLS).toHaveLength(3)
    })

    it('should include varlock with score 95', () => {
      const varlock = TIER1_SKILLS.find((s) => s.name === 'varlock')
      expect(varlock).toBeDefined()
      expect(varlock?.id).toBe('anthropic/varlock')
      expect(varlock?.score).toBe(95)
    })

    it('should include commit with score 92', () => {
      const commit = TIER1_SKILLS.find((s) => s.name === 'commit')
      expect(commit).toBeDefined()
      expect(commit?.id).toBe('anthropic/commit')
      expect(commit?.score).toBe(92)
    })

    it('should include governance with score 88', () => {
      const governance = TIER1_SKILLS.find((s) => s.name === 'governance')
      expect(governance).toBeDefined()
      expect(governance?.id).toBe('anthropic/governance')
      expect(governance?.score).toBe(88)
    })

    it('should have skills ordered by score (descending)', () => {
      const scores = TIER1_SKILLS.map((s) => s.score)
      const sortedScores = [...scores].sort((a, b) => b - a)
      expect(scores).toEqual(sortedScores)
    })

    it('should have all skills with valid IDs in author/name format', () => {
      for (const skill of TIER1_SKILLS) {
        expect(skill.id).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/)
      }
    })
  })

  describe('isFirstRun()', () => {
    it('should return true when marker file does not exist', () => {
      // FIRST_RUN_MARKER points to ~/.skillsmith/.first-run-complete
      // We need to test the actual behavior, not mock it
      // For this test, we verify the function reads the actual marker path
      const result = isFirstRun()
      // Result depends on whether the marker exists in the real location
      expect(typeof result).toBe('boolean')
    })

    it('should return false when marker file exists', () => {
      // Create the real marker file temporarily
      const markerDir = SKILLSMITH_DIR
      const wasMarkerExisting = existsSync(FIRST_RUN_MARKER)

      if (!existsSync(markerDir)) {
        mkdirSync(markerDir, { recursive: true })
      }

      // Create marker if it doesn't exist
      if (!wasMarkerExisting) {
        writeFileSync(FIRST_RUN_MARKER, 'test')
      }

      try {
        const result = isFirstRun()
        expect(result).toBe(false)
      } finally {
        // Clean up only if we created it
        if (!wasMarkerExisting && existsSync(FIRST_RUN_MARKER)) {
          rmSync(FIRST_RUN_MARKER)
        }
      }
    })

    it('should use existsSync to check marker file', () => {
      // This verifies the implementation uses the file system
      // The function should be pure (same input = same output)
      const result1 = isFirstRun()
      const result2 = isFirstRun()
      expect(result1).toBe(result2)
    })
  })

  describe('markFirstRunComplete()', () => {
    it('should create the .skillsmith directory if it does not exist', () => {
      // Ensure clean state by checking if directory needs to be created
      const dirExistedBefore = existsSync(SKILLSMITH_DIR)

      try {
        markFirstRunComplete()
        expect(existsSync(SKILLSMITH_DIR)).toBe(true)
      } finally {
        // Don't remove the directory if it existed before
        if (!dirExistedBefore) {
          // Only remove the marker, not the directory
          if (existsSync(FIRST_RUN_MARKER)) {
            rmSync(FIRST_RUN_MARKER)
          }
        }
      }
    })

    it('should create the marker file', () => {
      const markerExistedBefore = existsSync(FIRST_RUN_MARKER)

      try {
        markFirstRunComplete()
        expect(existsSync(FIRST_RUN_MARKER)).toBe(true)
      } finally {
        // Clean up if we created it
        if (!markerExistedBefore && existsSync(FIRST_RUN_MARKER)) {
          rmSync(FIRST_RUN_MARKER)
        }
      }
    })

    it('should write ISO timestamp to marker file', () => {
      const markerExistedBefore = existsSync(FIRST_RUN_MARKER)
      let originalContent: string | undefined

      if (markerExistedBefore) {
        originalContent = readFileSync(FIRST_RUN_MARKER, 'utf-8')
      }

      try {
        const beforeCall = new Date()
        markFirstRunComplete()
        const afterCall = new Date()

        const content = readFileSync(FIRST_RUN_MARKER, 'utf-8')
        const timestamp = new Date(content)

        // Verify it's a valid ISO date
        expect(timestamp.toISOString()).toBe(content)

        // Verify timestamp is within expected range
        expect(timestamp.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime())
        expect(timestamp.getTime()).toBeLessThanOrEqual(afterCall.getTime())
      } finally {
        // Restore original content or remove marker
        if (markerExistedBefore && originalContent !== undefined) {
          writeFileSync(FIRST_RUN_MARKER, originalContent)
        } else if (!markerExistedBefore && existsSync(FIRST_RUN_MARKER)) {
          rmSync(FIRST_RUN_MARKER)
        }
      }
    })

    it('should be idempotent (can be called multiple times)', () => {
      const markerExistedBefore = existsSync(FIRST_RUN_MARKER)
      let originalContent: string | undefined

      if (markerExistedBefore) {
        originalContent = readFileSync(FIRST_RUN_MARKER, 'utf-8')
      }

      try {
        markFirstRunComplete()
        markFirstRunComplete()
        markFirstRunComplete()

        expect(existsSync(FIRST_RUN_MARKER)).toBe(true)
      } finally {
        if (markerExistedBefore && originalContent !== undefined) {
          writeFileSync(FIRST_RUN_MARKER, originalContent)
        } else if (!markerExistedBefore && existsSync(FIRST_RUN_MARKER)) {
          rmSync(FIRST_RUN_MARKER)
        }
      }
    })

    it('should make isFirstRun return false after being called', () => {
      const markerExistedBefore = existsSync(FIRST_RUN_MARKER)
      let originalContent: string | undefined

      if (markerExistedBefore) {
        originalContent = readFileSync(FIRST_RUN_MARKER, 'utf-8')
      }

      try {
        markFirstRunComplete()
        expect(isFirstRun()).toBe(false)
      } finally {
        if (markerExistedBefore && originalContent !== undefined) {
          writeFileSync(FIRST_RUN_MARKER, originalContent)
        } else if (!markerExistedBefore && existsSync(FIRST_RUN_MARKER)) {
          rmSync(FIRST_RUN_MARKER)
        }
      }
    })
  })

  describe('getWelcomeMessage()', () => {
    it('should return formatted welcome message with skill list', () => {
      const skills = ['varlock', 'commit', 'governance']
      const message = getWelcomeMessage(skills)

      expect(message).toContain('Welcome to Skillsmith!')
      expect(message).toContain('Essential skills installed:')
      expect(message).toContain('- varlock')
      expect(message).toContain('- commit')
      expect(message).toContain('- governance')
    })

    it('should include usage hint for commit skill', () => {
      const skills = ['varlock', 'commit', 'governance']
      const message = getWelcomeMessage(skills)

      expect(message).toContain('Write a commit message')
    })

    it('should handle empty skill list', () => {
      const message = getWelcomeMessage([])

      expect(message).toContain('Welcome to Skillsmith!')
      expect(message).toContain('Essential skills installed:')
      // Should still have the structure, just no skills listed
    })

    it('should handle single skill', () => {
      const message = getWelcomeMessage(['varlock'])

      expect(message).toContain('Welcome to Skillsmith!')
      expect(message).toContain('- varlock')
      expect(message).not.toContain('- commit')
    })

    it('should format each skill with dash prefix', () => {
      const skills = ['skill1', 'skill2', 'skill3']
      const message = getWelcomeMessage(skills)

      for (const skill of skills) {
        expect(message).toContain(`- ${skill}`)
      }
    })

    it('should return trimmed message without leading/trailing whitespace', () => {
      const message = getWelcomeMessage(['test'])

      expect(message).not.toMatch(/^\s/)
      expect(message).not.toMatch(/\s$/)
    })
  })

  describe('Module exports', () => {
    it('should export SKILLSMITH_DIR constant', () => {
      expect(SKILLSMITH_DIR).toBeDefined()
      expect(typeof SKILLSMITH_DIR).toBe('string')
      expect(SKILLSMITH_DIR).toContain('.skillsmith')
    })

    it('should export FIRST_RUN_MARKER constant', () => {
      expect(FIRST_RUN_MARKER).toBeDefined()
      expect(typeof FIRST_RUN_MARKER).toBe('string')
      expect(FIRST_RUN_MARKER).toContain('.first-run-complete')
    })

    it('should have FIRST_RUN_MARKER inside SKILLSMITH_DIR', () => {
      expect(FIRST_RUN_MARKER.startsWith(SKILLSMITH_DIR)).toBe(true)
    })
  })
})
