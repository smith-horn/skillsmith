/**
 * SMI-616: Install Skill Tool Integration Tests
 * Tests the install_skill tool with mocked GitHub and real filesystem
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import {
  createTestFilesystem,
  createMockManifest,
  createMockGitHubFetch,
  fileExists,
  readJsonFile,
  type TestFilesystemContext,
} from './setup.js'

// SMI-2722/2732: Mock install.helpers module for UUID install path tests.
// Uses importActual to preserve all real helpers; only lookupSkillFromRegistry and
// fetchFromGitHub are replaced so per-test vi.mocked() calls can control their behavior.
vi.mock('../../src/tools/install.helpers.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/tools/install.helpers.js')>()
  return {
    ...actual,
    lookupSkillFromRegistry: vi.fn(),
    fetchFromGitHub: vi.fn(),
  }
})

// We need to mock the paths used by the install module
// Since the install.ts uses os.homedir(), we'll test the core logic

describe('Install Skill Tool Integration Tests', () => {
  let fsContext: TestFilesystemContext

  beforeEach(async () => {
    fsContext = await createTestFilesystem()
  })

  afterEach(async () => {
    await fsContext.cleanup()
    vi.restoreAllMocks()
  })

  describe('Skill ID Parsing', () => {
    it('should parse owner/repo format correctly', () => {
      const parseSkillId = (input: string) => {
        if (input.startsWith('https://github.com/')) {
          const url = new URL(input)
          const parts = url.pathname.split('/').filter(Boolean)
          return {
            owner: parts[0],
            repo: parts[1],
            path: parts.slice(2).join('/') || '',
          }
        }

        if (input.includes('/')) {
          const [owner, ...rest] = input.split('/')
          const repo = rest[0]
          const skillPath = rest.slice(1).join('/')
          return { owner, repo, path: skillPath }
        }

        throw new Error('Invalid skill ID format')
      }

      const result1 = parseSkillId('anthropic/claude-skills/commit')
      expect(result1).toEqual({
        owner: 'anthropic',
        repo: 'claude-skills',
        path: 'commit',
      })

      const result2 = parseSkillId('owner/repo')
      expect(result2).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
      })
    })

    it('should parse GitHub URL correctly', () => {
      const parseSkillId = (input: string) => {
        if (input.startsWith('https://github.com/')) {
          const url = new URL(input)
          const parts = url.pathname.split('/').filter(Boolean)
          return {
            owner: parts[0],
            repo: parts[1],
            path: parts.slice(2).join('/') || '',
          }
        }
        throw new Error('Invalid URL')
      }

      const result = parseSkillId('https://github.com/anthropic/claude-skills/tree/main/commit')
      expect(result.owner).toBe('anthropic')
      expect(result.repo).toBe('claude-skills')
    })
  })

  describe('SKILL.md Validation', () => {
    it('should accept valid SKILL.md content', () => {
      const validateSkillMd = (content: string) => {
        const errors: string[] = []
        if (!content.includes('# ')) {
          errors.push('Missing title (# heading)')
        }
        if (content.length < 100) {
          errors.push('SKILL.md is too short (minimum 100 characters)')
        }
        return { valid: errors.length === 0, errors }
      }

      const validContent = `# My Amazing Skill

This is a comprehensive skill that helps developers with their daily tasks.
It provides utilities for code generation, refactoring, and more.

## Usage

Use this skill by mentioning it in Claude Code.
`

      const result = validateSkillMd(validContent)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('should reject SKILL.md without title', () => {
      const validateSkillMd = (content: string) => {
        const errors: string[] = []
        if (!content.includes('# ')) {
          errors.push('Missing title')
        }
        if (content.length < 100) {
          errors.push('Too short')
        }
        return { valid: errors.length === 0, errors }
      }

      const invalidContent =
        'This content has no title heading and is long enough but still invalid.'.repeat(3)
      const result = validateSkillMd(invalidContent)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing title')
    })

    it('should reject SKILL.md that is too short', () => {
      const validateSkillMd = (content: string) => {
        const errors: string[] = []
        if (!content.includes('# ')) {
          errors.push('Missing title')
        }
        if (content.length < 100) {
          errors.push('Too short')
        }
        return { valid: errors.length === 0, errors }
      }

      const shortContent = '# Short\n\nToo short.'
      const result = validateSkillMd(shortContent)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Too short')
    })
  })

  describe('Filesystem Operations', () => {
    it('should create skill directory', async () => {
      const skillPath = path.join(fsContext.skillsDir, 'test-skill')
      await fs.mkdir(skillPath, { recursive: true })

      const exists = await fileExists(skillPath)
      expect(exists).toBe(true)
    })

    it('should write SKILL.md file', async () => {
      const skillPath = path.join(fsContext.skillsDir, 'test-skill')
      await fs.mkdir(skillPath, { recursive: true })

      const content =
        '# Test Skill\n\nThis is test content with enough characters to pass validation requirements.'
      await fs.writeFile(path.join(skillPath, 'SKILL.md'), content)

      const exists = await fileExists(path.join(skillPath, 'SKILL.md'))
      expect(exists).toBe(true)

      const readContent = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8')
      expect(readContent).toBe(content)
    })

    it('should create and update manifest', async () => {
      await createMockManifest(fsContext.manifestDir, {})

      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json')
      const manifest = await readJsonFile<{
        version: string
        installedSkills: Record<string, unknown>
      }>(manifestPath)

      expect(manifest.version).toBe('1.0.0')
      expect(manifest.installedSkills).toEqual({})

      // Add a skill to manifest
      manifest.installedSkills['test-skill'] = {
        id: 'owner/test-skill',
        name: 'test-skill',
        version: '1.0.0',
        source: 'github:owner/test-skill',
        installPath: path.join(fsContext.skillsDir, 'test-skill'),
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      }

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

      const updatedManifest = await readJsonFile<typeof manifest>(manifestPath)
      expect(updatedManifest.installedSkills['test-skill']).toBeDefined()
    })
  })

  describe('Duplicate Installation Detection', () => {
    it('should detect already installed skill', async () => {
      // Create manifest with existing skill
      await createMockManifest(fsContext.manifestDir, {
        'existing-skill': {
          id: 'owner/existing-skill',
          name: 'existing-skill',
          version: '1.0.0',
          source: 'github:owner/existing-skill',
          installPath: path.join(fsContext.skillsDir, 'existing-skill'),
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      })

      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json')
      const manifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(
        manifestPath
      )

      expect(manifest.installedSkills['existing-skill']).toBeDefined()
    })
  })

  describe('GitHub Fetch Mocking', () => {
    it('should mock successful GitHub fetch', async () => {
      const mockFetch = createMockGitHubFetch({
        'raw.githubusercontent.com/owner/repo/main/SKILL.md': {
          status: 200,
          body: '# Mock Skill\n\nThis is a mock skill with sufficient content for validation testing purposes.',
        },
      })

      const response = await mockFetch('https://raw.githubusercontent.com/owner/repo/main/SKILL.md')
      expect(response.status).toBe(200)

      const body = await response.text()
      expect(body).toContain('# Mock Skill')
    })

    it('should mock 404 for non-existent files', async () => {
      const mockFetch = createMockGitHubFetch({})

      const response = await mockFetch(
        'https://raw.githubusercontent.com/owner/repo/main/NONEXISTENT.md'
      )
      expect(response.status).toBe(404)
    })

    it('should try master branch if main fails', async () => {
      const mockFetch = createMockGitHubFetch({
        'raw.githubusercontent.com/owner/repo/master/SKILL.md': {
          status: 200,
          body: '# Master Branch Skill\n\nContent from master branch with enough text for validation.',
        },
      })

      // Simulate the logic of trying main then master
      let response = await mockFetch('https://raw.githubusercontent.com/owner/repo/main/SKILL.md')
      if (response.status === 404) {
        response = await mockFetch('https://raw.githubusercontent.com/owner/repo/master/SKILL.md')
      }

      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('Master Branch')
    })
  })

  describe('Post-Install Tips', () => {
    it('should generate correct tips', () => {
      const generateTips = (skillName: string) => [
        `Skill "${skillName}" installed successfully!`,
        `To use this skill, mention it in Claude Code: "Use the ${skillName} skill to..."`,
        'View installed skills: ls ~/.claude/skills/',
        'To uninstall: use the uninstall_skill tool',
      ]

      const tips = generateTips('my-skill')
      expect(tips[0]).toContain('my-skill')
      expect(tips[1]).toContain('my-skill')
      expect(tips.length).toBe(4)
    })
  })

  describe('Full Installation Flow Simulation', () => {
    it('should complete full installation flow', async () => {
      const skillName = 'complete-skill'
      const skillPath = path.join(fsContext.skillsDir, skillName)

      // 1. Create skill directory
      await fs.mkdir(skillPath, { recursive: true })

      // 2. Write SKILL.md
      const skillContent = `# Complete Skill

A comprehensive skill for testing the full installation flow.
This content is long enough to pass the validation requirements.

## Features

- Feature 1
- Feature 2

## Usage

Use this skill by mentioning it in Claude Code.
`
      await fs.writeFile(path.join(skillPath, 'SKILL.md'), skillContent)

      // 3. Write optional README.md
      await fs.writeFile(
        path.join(skillPath, 'README.md'),
        '# Complete Skill\n\nAdditional documentation.'
      )

      // 4. Update manifest
      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json')
      await createMockManifest(fsContext.manifestDir, {
        [skillName]: {
          id: 'owner/complete-skill',
          name: skillName,
          version: '1.0.0',
          source: 'github:owner/complete-skill',
          installPath: skillPath,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      })

      // Verify installation
      expect(await fileExists(skillPath)).toBe(true)
      expect(await fileExists(path.join(skillPath, 'SKILL.md'))).toBe(true)
      expect(await fileExists(path.join(skillPath, 'README.md'))).toBe(true)
      expect(await fileExists(manifestPath)).toBe(true)

      const manifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(
        manifestPath
      )
      expect(manifest.installedSkills[skillName]).toBeDefined()
    })
  })

  /**
   * SMI-1491: Tests for parseRepoUrl function
   * Tests parsing of various repo_url formats from registry
   */
  describe('SMI-1491: parseRepoUrl', () => {
    // Local implementation matching install.ts
    const parseRepoUrl = (
      repoUrl: string
    ): {
      owner: string
      repo: string
      path: string
      branch: string
    } => {
      const url = new URL(repoUrl)
      const parts = url.pathname.split('/').filter(Boolean)
      const owner = parts[0]
      const repo = parts[1]

      if (parts.length === 2) {
        return { owner, repo, path: '', branch: 'main' }
      }

      if (parts[2] === 'tree' || parts[2] === 'blob') {
        return {
          owner,
          repo,
          branch: parts[3],
          path: parts.slice(4).join('/'),
        }
      }

      return { owner, repo, path: parts.slice(2).join('/'), branch: 'main' }
    }

    it('should parse repo root URL', () => {
      const result = parseRepoUrl('https://github.com/owner/repo')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
        branch: 'main',
      })
    })

    it('should parse tree URL with main branch', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/tree/main/skills/commit')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'skills/commit',
        branch: 'main',
      })
    })

    it('should parse tree URL with custom branch', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/tree/develop/path/to/skill')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'path/to/skill',
        branch: 'develop',
      })
    })

    it('should parse blob URL', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/blob/main/SKILL.md')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'SKILL.md',
        branch: 'main',
      })
    })

    it('should handle deep nested paths', () => {
      const result = parseRepoUrl(
        'https://github.com/org/monorepo/tree/main/packages/skills/helper'
      )
      expect(result).toEqual({
        owner: 'org',
        repo: 'monorepo',
        path: 'packages/skills/helper',
        branch: 'main',
      })
    })
  })

  /**
   * SMI-1491: Tests for updated parseSkillId with isRegistryId flag
   */
  describe('SMI-1491: parseSkillId with isRegistryId', () => {
    // Local implementation matching install.ts
    const parseSkillId = (
      input: string
    ): {
      owner: string
      repo: string
      path: string
      isRegistryId: boolean
    } => {
      if (input.startsWith('https://github.com/')) {
        const url = new URL(input)
        const parts = url.pathname.split('/').filter(Boolean)
        return {
          owner: parts[0],
          repo: parts[1],
          path: parts.slice(2).join('/') || '',
          isRegistryId: false,
        }
      }

      if (input.includes('/')) {
        const parts = input.split('/')
        if (parts.length === 2) {
          return {
            owner: parts[0],
            repo: parts[1],
            path: '',
            isRegistryId: true,
          }
        }
        return {
          owner: parts[0],
          repo: parts[1],
          path: parts.slice(2).join('/'),
          isRegistryId: false,
        }
      }

      throw new Error('Invalid skill ID format')
    }

    it('should mark 2-part ID as registry ID', () => {
      const result = parseSkillId('anthropic/commit')
      expect(result.isRegistryId).toBe(true)
      expect(result.owner).toBe('anthropic')
      expect(result.repo).toBe('commit')
    })

    it('should mark 3-part ID as direct path (not registry)', () => {
      const result = parseSkillId('owner/repo/skill-path')
      expect(result.isRegistryId).toBe(false)
      expect(result.owner).toBe('owner')
      expect(result.repo).toBe('repo')
      expect(result.path).toBe('skill-path')
    })

    it('should mark full URL as not registry ID', () => {
      const result = parseSkillId('https://github.com/owner/repo/tree/main/skill')
      expect(result.isRegistryId).toBe(false)
      expect(result.owner).toBe('owner')
      expect(result.repo).toBe('repo')
    })
  })

  /**
   * SMI-1533: Trust-Tier Security Scanning Tests
   * Tests for trust-tier sensitive security scanning in install flow
   */
  describe('SMI-1533: Trust-Tier Security Scanning', () => {
    // Import the actual validateTrustTier function from install.types.ts
    // SMI-1718: Import from types file after re-export trimming
    // SMI-1809: Added 'local' tier to return type
    let validateTrustTier: (
      value: string | null | undefined
    ) => 'verified' | 'curated' | 'community' | 'experimental' | 'unknown' | 'local'

    beforeAll(async () => {
      const installTypesModule = await import('../../src/tools/install.types.js')
      validateTrustTier = installTypesModule.validateTrustTier
    })

    // Type alias for trust tier (used in tests below)
    // SMI-1809: Added 'local' tier for local skills
    type TrustTier = 'verified' | 'curated' | 'community' | 'experimental' | 'unknown' | 'local'

    // Scanner options per trust tier (matching install.ts)
    // SMI-1809: Added 'local' tier options
    // SMI-2381: Added 'curated' tier options
    const TRUST_TIER_SCANNER_OPTIONS: Record<
      TrustTier,
      { riskThreshold: number; maxContentLength: number }
    > = {
      verified: { riskThreshold: 70, maxContentLength: 2_000_000 },
      curated: { riskThreshold: 55, maxContentLength: 1_500_000 },
      community: { riskThreshold: 40, maxContentLength: 1_000_000 },
      local: { riskThreshold: 100, maxContentLength: 10_000_000 },
      experimental: { riskThreshold: 25, maxContentLength: 500_000 },
      unknown: { riskThreshold: 20, maxContentLength: 250_000 },
    }

    describe('validateTrustTier', () => {
      it('should return "unknown" for null input', () => {
        expect(validateTrustTier(null)).toBe('unknown')
      })

      it('should return "unknown" for undefined input', () => {
        expect(validateTrustTier(undefined)).toBe('unknown')
      })

      it('should return "unknown" for empty string', () => {
        expect(validateTrustTier('')).toBe('unknown')
      })

      it('should validate "verified" tier', () => {
        expect(validateTrustTier('verified')).toBe('verified')
        expect(validateTrustTier('VERIFIED')).toBe('verified')
        expect(validateTrustTier('Verified')).toBe('verified')
      })

      it('should validate "curated" tier', () => {
        expect(validateTrustTier('curated')).toBe('curated')
        expect(validateTrustTier('CURATED')).toBe('curated')
      })

      it('should validate "community" tier', () => {
        expect(validateTrustTier('community')).toBe('community')
        expect(validateTrustTier('COMMUNITY')).toBe('community')
      })

      it('should validate "experimental" tier', () => {
        expect(validateTrustTier('experimental')).toBe('experimental')
        expect(validateTrustTier('EXPERIMENTAL')).toBe('experimental')
      })

      it('should return "unknown" for invalid tier values', () => {
        expect(validateTrustTier('invalid')).toBe('unknown')
        expect(validateTrustTier('premium')).toBe('unknown')
        expect(validateTrustTier('trusted')).toBe('unknown')
        expect(validateTrustTier('official')).toBe('unknown')
      })
    })

    describe('Scanner Options per Trust Tier', () => {
      it('should have highest threshold for verified tier', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.verified.riskThreshold).toBe(70)
        expect(TRUST_TIER_SCANNER_OPTIONS.verified.maxContentLength).toBe(2_000_000)
      })

      it('should have standard threshold for community tier', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.community.riskThreshold).toBe(40)
        expect(TRUST_TIER_SCANNER_OPTIONS.community.maxContentLength).toBe(1_000_000)
      })

      it('should have lower threshold for experimental tier', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.experimental.riskThreshold).toBe(25)
        expect(TRUST_TIER_SCANNER_OPTIONS.experimental.maxContentLength).toBe(500_000)
      })

      it('should have strictest threshold for unknown tier', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.unknown.riskThreshold).toBe(20)
        expect(TRUST_TIER_SCANNER_OPTIONS.unknown.maxContentLength).toBe(250_000)
      })

      it('should have progressively stricter thresholds', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.verified.riskThreshold).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.community.riskThreshold
        )
        expect(TRUST_TIER_SCANNER_OPTIONS.community.riskThreshold).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.experimental.riskThreshold
        )
        expect(TRUST_TIER_SCANNER_OPTIONS.experimental.riskThreshold).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.unknown.riskThreshold
        )
      })

      it('should have progressively smaller content limits', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.verified.maxContentLength).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.community.maxContentLength
        )
        expect(TRUST_TIER_SCANNER_OPTIONS.community.maxContentLength).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.experimental.maxContentLength
        )
        expect(TRUST_TIER_SCANNER_OPTIONS.experimental.maxContentLength).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.unknown.maxContentLength
        )
      })
    })

    describe('Trust Tier Selection Logic', () => {
      it('should use unknown tier for direct GitHub URLs', () => {
        // Direct GitHub URLs bypass registry lookup, so no trust tier available
        const input = 'https://github.com/random/untrusted-skill'
        const isDirectUrl = input.startsWith('https://github.com/')
        const trustTier = isDirectUrl ? 'unknown' : 'community'

        expect(trustTier).toBe('unknown')
        expect(TRUST_TIER_SCANNER_OPTIONS[trustTier].riskThreshold).toBe(20)
      })

      it('should use registry trust tier when available', () => {
        // Simulating registry lookup returning a trust tier
        const registryResponse = {
          trust_tier: 'verified',
          repo_url: 'https://github.com/anthropic/official-skill',
        }

        const trustTier = validateTrustTier(registryResponse.trust_tier)
        expect(trustTier).toBe('verified')
        expect(TRUST_TIER_SCANNER_OPTIONS[trustTier].riskThreshold).toBe(70)
      })

      it('should fall back to unknown for missing registry trust tier', () => {
        const registryResponse = {
          trust_tier: null,
          repo_url: 'https://github.com/user/skill',
        }

        const trustTier = validateTrustTier(registryResponse.trust_tier)
        expect(trustTier).toBe('unknown')
      })
    })

    describe('Security Scan Behavior by Trust Tier', () => {
      it('should pass more content for verified skills', () => {
        const largeContent = 'x'.repeat(1_500_000) // 1.5MB
        const verifiedLimit = TRUST_TIER_SCANNER_OPTIONS.verified.maxContentLength
        const communityLimit = TRUST_TIER_SCANNER_OPTIONS.community.maxContentLength

        // Content exceeds community limit but not verified limit
        expect(largeContent.length).toBeLessThan(verifiedLimit)
        expect(largeContent.length).toBeGreaterThan(communityLimit)
      })

      it('should apply strictest scanning for unknown sources', () => {
        const unknownOptions = TRUST_TIER_SCANNER_OPTIONS.unknown

        // Verify strictest settings
        expect(unknownOptions.riskThreshold).toBe(20)
        expect(unknownOptions.maxContentLength).toBe(250_000)

        // These are the strictest values
        Object.values(TRUST_TIER_SCANNER_OPTIONS).forEach((options) => {
          expect(unknownOptions.riskThreshold).toBeLessThanOrEqual(options.riskThreshold)
          expect(unknownOptions.maxContentLength).toBeLessThanOrEqual(options.maxContentLength)
        })
      })
    })

    describe('Error Message Context', () => {
      // Helper function to generate tier context string
      const getTierContext = (tier: TrustTier): string =>
        tier === 'unknown'
          ? ' (Direct GitHub install - strictest scanning applied)'
          : tier === 'experimental'
            ? ' (Experimental skill - aggressive scanning applied)'
            : ''

      it('should include trust tier in error context for unknown tier', () => {
        const tierContext = getTierContext('unknown')
        expect(tierContext).toContain('strictest scanning')
      })

      it('should include trust tier in error context for experimental tier', () => {
        const tierContext = getTierContext('experimental')
        expect(tierContext).toContain('aggressive scanning')
      })

      it('should have no extra context for verified/community tiers', () => {
        expect(getTierContext('verified')).toBe('')
        expect(getTierContext('community')).toBe('')
      })
    })
  })

  /**
   * SMI-2722/2732: UUID install path integration tests
   * Verifies the full installSkill() flow for UUID skillIds:
   *  - registry hit with valid repo_url → install succeeds
   *  - registry returns null (no repo_url) → discovery-only error
   *  - registry returns quarantined skill → quarantine error
   *  - UUID not found in registry → discovery-only error
   *  - SKILL.md fetch throws for registry-sourced skill → data quality error
   */
  describe('SMI-2722/2732: UUID install path', () => {
    const TEST_UUID = 'a129e127-a82c-47e5-8bc5-09d7ba2e8734'
    const VALID_SKILL_MD = [
      '---',
      'name: test-skill',
      'description: A test skill for integration testing UUID install path',
      '---',
      '# Test Skill',
      '',
      'This is a test skill with sufficient content to pass all validation checks.',
      'It has YAML frontmatter, a markdown heading, and enough body text.',
    ].join('\n')

    let installSkill: (typeof import('../../src/tools/install.js'))['installSkill']
    let installInputSchema: (typeof import('../../src/tools/install.types.js'))['installInputSchema']
    let lookupSkillFromRegistry: ReturnType<typeof vi.fn>
    let fetchFromGitHub: ReturnType<typeof vi.fn>

    beforeAll(async () => {
      // Dynamic import after vi.mock() has been hoisted — module is already mocked
      const installModule = await import('../../src/tools/install.js')
      installSkill = installModule.installSkill

      const typesModule = await import('../../src/tools/install.types.js')
      installInputSchema = typesModule.installInputSchema

      const helpersModule = await import('../../src/tools/install.helpers.js')
      lookupSkillFromRegistry = vi.mocked(helpersModule.lookupSkillFromRegistry)
      fetchFromGitHub = vi.mocked(helpersModule.fetchFromGitHub)
    })

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('UUID with valid repo_url resolves and installs the skill', async () => {
      // Registry returns a routable skill entry
      lookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/owner/test-skill',
        name: 'test-skill',
        trustTier: 'community',
        quarantined: false,
      })
      // SKILL.md fetch succeeds
      fetchFromGitHub.mockResolvedValue(VALID_SKILL_MD)

      const result = await installSkill(
        installInputSchema.parse({ skillId: TEST_UUID, skipScan: true, force: true })
      )

      expect(result.success).toBe(true)
      expect(result.skillId).toBe(TEST_UUID)
      expect(lookupSkillFromRegistry).toHaveBeenCalledWith(TEST_UUID, expect.anything())
    })

    it('UUID with null registry result returns "indexed for discovery only" error', async () => {
      // Registry found the skill but it has no repo_url (seed / metadata-only)
      lookupSkillFromRegistry.mockResolvedValue(null)

      const result = await installSkill(installInputSchema.parse({ skillId: TEST_UUID }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('indexed for discovery only')
      expect(lookupSkillFromRegistry).toHaveBeenCalledWith(TEST_UUID, expect.anything())
    })

    it('UUID for a quarantined skill returns "quarantined" error', async () => {
      // Registry flags the skill as quarantined
      lookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/owner/bad-skill',
        name: 'bad-skill',
        trustTier: 'community',
        quarantined: true,
      })

      const result = await installSkill(installInputSchema.parse({ skillId: TEST_UUID }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('quarantined')
      expect(lookupSkillFromRegistry).toHaveBeenCalledWith(TEST_UUID, expect.anything())
    })

    it('UUID not found in registry (lookupSkillFromRegistry returns null) surfaces discovery-only error', async () => {
      // lookupSkillFromRegistry returns null — no row in registry for this UUID
      // This is semantically distinct from test #2: there the API returned a row with null repo_url.
      // Here lookupSkillFromRegistry itself returns null (API 404 + DB miss).
      // Both paths hit the same !registrySkill branch in installSkill(); this test confirms
      // the UUID routing guard works end-to-end when the registry has no record at all.
      lookupSkillFromRegistry.mockResolvedValue(null)

      const result = await installSkill(installInputSchema.parse({ skillId: TEST_UUID }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('indexed for discovery only')
    })

    it('registry-sourced UUID with SKILL.md fetch failure surfaces "registry data quality issue" error', async () => {
      // Registry has a valid entry, but the SKILL.md fetch throws (broken repo_url)
      lookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/owner/broken-skill',
        name: 'broken-skill',
        trustTier: 'community',
        quarantined: false,
      })
      fetchFromGitHub.mockRejectedValue(new Error('Failed to fetch SKILL.md: 404'))

      const result = await installSkill(installInputSchema.parse({ skillId: TEST_UUID }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('registry data quality issue')
    })
  })
})
