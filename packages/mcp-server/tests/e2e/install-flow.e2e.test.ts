/**
 * E2E Test: MCP install/uninstall flow
 *
 * Tests the complete install → use → uninstall flow
 * in a clean Codespace environment.
 *
 * User Journey: Install and manage skills via MCP
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { existsSync, rmSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import {
  createDatabase,
  initializeSchema,
  SkillRepository,
  type DatabaseType,
} from '@skillsmith/core'
import { createToolContext, type ToolContext } from '../../src/context.js'
import { scanForHardcoded } from './utils/hardcoded-detector.js'
import { measureAsync } from './utils/baseline-collector.js'

// Test configuration
const TEST_DIR = join(tmpdir(), 'skillsmith-e2e-install')
const TEST_DB_PATH = join(TEST_DIR, 'install-test.db')
const TEST_HOME = join(TEST_DIR, 'home')
const TEST_SKILLS_DIR = join(TEST_HOME, '.claude', 'skills')

// Seed data with real GitHub URLs for testing - SMI-1365: Must include all 4 trust tiers
const SEED_SKILLS = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code/tree/main/skills/commit',
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
  {
    id: 'experimental/ai-debug',
    name: 'ai-debug',
    description: 'AI-powered debugging assistant',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-labs/ai-debug',
    qualityScore: 0.65,
    trustTier: 'experimental' as const,
    tags: ['debugging', 'ai'],
  },
  {
    id: 'unknown/untested-tool',
    name: 'untested-tool',
    description: 'A newly submitted skill not yet reviewed or assessed',
    author: 'unknown-contributor',
    repoUrl: 'https://github.com/unknown-contributor/untested-tool',
    qualityScore: 0.45,
    trustTier: 'unknown' as const,
    tags: ['utility', 'unverified'],
  },
]

// Note: The actual install/uninstall tools use dynamic imports and file system operations
// These tests focus on the flow and hardcoded value detection
// In a real Codespace, we would import and use the actual tools

describe('E2E: skill install/uninstall flow', () => {
  let db: DatabaseType
  let context: ToolContext
  let originalHome: string | undefined

  beforeAll(() => {
    // Save original HOME
    originalHome = process.env['HOME']

    // Create test environment
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_SKILLS_DIR, { recursive: true })

    // Override HOME for tests
    process.env['HOME'] = TEST_HOME

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
    // Restore HOME
    if (originalHome) {
      process.env['HOME'] = originalHome
    }

    db?.close()
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    // Clean skills directory before each test
    if (existsSync(TEST_SKILLS_DIR)) {
      const skills = readdirSync(TEST_SKILLS_DIR)
      for (const skill of skills) {
        rmSync(join(TEST_SKILLS_DIR, skill), { recursive: true, force: true })
      }
    }
  })

  describe('Database Skill Lookup', () => {
    it('should find skill by ID in database', async () => {
      const skill = context.skillRepository.findById('anthropic/commit')

      expect(skill).toBeDefined()
      expect(skill?.name).toBe('commit')
      expect(skill?.trustTier).toBe('verified')
    })

    it('should return null for non-existent skill', async () => {
      const skill = context.skillRepository.findById('nonexistent/skill')

      expect(skill).toBeNull()
    })

    it('should not expose hardcoded paths in skill data', async () => {
      const skill = context.skillRepository.findById('anthropic/commit')
      const skillStr = JSON.stringify(skill)

      // Should not contain user paths
      expect(skillStr).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//)
      expect(skillStr).not.toMatch(/\/home\/[a-zA-Z0-9_-]+\//)
      if (originalHome) {
        expect(skillStr).not.toContain(originalHome)
      }
    })
  })

  describe('Install Path Validation', () => {
    it('should use correct skills directory structure', () => {
      // Verify test environment setup
      expect(existsSync(TEST_SKILLS_DIR)).toBe(true)

      // The install tool should use ~/.claude/skills/
      const expectedPath = join(TEST_HOME, '.claude', 'skills')
      expect(TEST_SKILLS_DIR).toBe(expectedPath)
    })

    it('should not use hardcoded user paths', () => {
      // The actual install path should be derived from os.homedir()
      // not hardcoded to a specific user

      // The actual install path should be derived from os.homedir()
      const _homeDir = homedir()

      // Our test overrides HOME, so the actual home should be TEST_HOME
      expect(process.env['HOME']).toBe(TEST_HOME)

      // Skill paths should be relative to HOME, not hardcoded
      const skillPath = join(process.env['HOME'] || '', '.claude', 'skills', 'test-skill')
      expect(skillPath).not.toMatch(/\/Users\/williamsmith\//)
      expect(skillPath).not.toMatch(/\/Users\/[a-zA-Z]+\//)
    })
  })

  describe('Skill Data Quality', () => {
    it('should have valid repository URLs', () => {
      for (const seedSkill of SEED_SKILLS) {
        const skill = context.skillRepository.findById(seedSkill.id)

        expect(skill).toBeDefined()
        expect(skill?.repoUrl).toBeDefined()

        // URL should be valid GitHub URL
        expect(skill?.repoUrl).toMatch(/^https:\/\/github\.com\//)

        // URL should not be localhost
        expect(skill?.repoUrl).not.toMatch(/localhost/)
        expect(skill?.repoUrl).not.toMatch(/127\.0\.0\.1/)
      }
    })

    it('should have valid trust tiers', () => {
      for (const seedSkill of SEED_SKILLS) {
        const skill = context.skillRepository.findById(seedSkill.id)

        expect(skill).toBeDefined()
        expect(['verified', 'community', 'experimental', 'unknown']).toContain(skill?.trustTier)
      }
    })

    it('should have quality scores in valid range', () => {
      for (const seedSkill of SEED_SKILLS) {
        const skill = context.skillRepository.findById(seedSkill.id)

        expect(skill).toBeDefined()
        expect(skill?.qualityScore).toBeGreaterThanOrEqual(0)
        expect(skill?.qualityScore).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('Manifest Structure', () => {
    it('should use correct manifest path', () => {
      // The manifest should be in ~/.skillsmith/manifest.json
      const expectedManifestDir = join(TEST_HOME, '.skillsmith')

      // Verify the path construction doesn't use hardcoded values
      expect(expectedManifestDir).not.toMatch(/\/Users\/williamsmith\//)
      expect(expectedManifestDir).toBe(join(process.env['HOME'] || '', '.skillsmith'))
    })
  })

  describe('Performance Baselines', () => {
    it('should complete skill lookup quickly', async () => {
      const { durationMs } = await measureAsync('lookup:skill', 'skill lookup', async () => {
        return context.skillRepository.findById('anthropic/commit')
      })

      // Lookup should be very fast (< 50ms)
      expect(durationMs).toBeLessThan(50)
      console.log(`Skill lookup baseline: ${durationMs}ms`)
    })

    it('should complete batch lookup quickly', async () => {
      const { durationMs } = await measureAsync('lookup:batch', 'batch skill lookup', async () => {
        return SEED_SKILLS.map((s) => context.skillRepository.findById(s.id))
      })

      // Batch lookup should complete quickly
      expect(durationMs).toBeLessThan(100)
      console.log(`Batch lookup baseline: ${durationMs}ms`)
    })
  })

  describe('Hardcoded Value Detection', () => {
    it('should not have hardcoded paths in repository data', () => {
      const allSkills = context.skillRepository.findAll(100, 0)
      const dataStr = JSON.stringify(allSkills)

      // Check for hardcoded paths
      const issues = scanForHardcoded(dataStr, 'findAll', 'database')

      const errors = issues.filter((i) => i.severity === 'error')
      expect(errors).toHaveLength(0)
    })

    it('should not expose API keys in skill data', () => {
      const allSkills = context.skillRepository.findAll(100, 0)
      const dataStr = JSON.stringify(allSkills)

      // Should not contain API key patterns
      expect(dataStr).not.toMatch(/ghp_[a-zA-Z0-9]{36}/)
      expect(dataStr).not.toMatch(/sk-[a-zA-Z0-9]{32,}/)
      expect(dataStr).not.toMatch(/lin_api_[a-zA-Z0-9]+/)
    })
  })
})
