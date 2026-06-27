/**
 * Tests for SMI-582: MCP Get Skill Tool
 * Updated for SMI-790: Wire to SkillRepository
 * Updated for SMI-1614: Coverage gaps
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { executeGetSkill, formatSkillDetails } from '../tools/get-skill.js'
import { SkillsmithError, ErrorCodes, QuarantineRepository } from '@skillsmith/core'
import { createSeededTestContext, disposeTestContext, type ToolContext } from './test-utils.js'

let context: ToolContext

beforeAll(async () => {
  context = await createSeededTestContext()
})

afterAll(async () => {
  await disposeTestContext(context)
})

describe('Get Skill Tool', () => {
  describe('executeGetSkill', () => {
    it('should return skill details for valid ID', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)

      expect(result.skill).toBeDefined()
      expect(result.skill.id).toBe('anthropic/commit')
      expect(result.skill.name).toBe('commit')
      expect(result.skill.author).toBe('anthropic')
      expect(result.skill.description).toBeDefined()
      expect(result.skill.trustTier).toBe('verified')
      expect(result.skill.score).toBeGreaterThan(0)
      expect(result.installCommand).toBeDefined()
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should include repository URL', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)

      expect(result.skill.repository).toBeDefined()
      expect(result.skill.repository).toContain('github.com')
    })

    it('should set installable=true for a seeded skill with a repo_url (SMI-4954)', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)

      // The seeded skill carries a repo_url, so it is installable.
      expect(result.skill.installable).toBe(true)
    })

    it('should throw SKILL_NOT_FOUND for invalid skill', async () => {
      try {
        await executeGetSkill({ id: 'nonexistent/skill' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_NOT_FOUND)
      }
    })

    it('should throw SKILL_INVALID_ID for malformed ID', async () => {
      try {
        await executeGetSkill({ id: 'not-valid-format' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_INVALID_ID)
      }
    })

    it('should throw VALIDATION_REQUIRED_FIELD for empty ID', async () => {
      try {
        await executeGetSkill({ id: '' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.VALIDATION_REQUIRED_FIELD)
      }
    })
  })

  describe('formatSkillDetails', () => {
    it('should format skill details for terminal display', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('commit')
      expect(formatted).toContain('Author:')
      expect(formatted).toContain('Trust Tier:')
      expect(formatted).toContain('Overall Score:')
      expect(formatted).toContain('Installation')
    })

    it('should include trust tier explanation', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('VERIFIED')
    })

    it('should show installation command', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('claude skill add')
    })

    it('should format community trust tier', async () => {
      const result = await executeGetSkill({ id: 'community/jest-helper' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('COMMUNITY')
    })

    it('should format experimental trust tier', async () => {
      const result = await executeGetSkill({ id: 'community/api-docs' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('EXPERIMENTAL')
    })

    it('should display tags when present', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('Tags:')
      expect(formatted).toContain('git')
    })

    it('should display N/A for missing version', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('Version: N/A')
    })

    it('should display timing information', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('Retrieved in')
      expect(formatted).toContain('ms')
    })

    it('should display repository URL', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('Repository:')
      expect(formatted).toContain('github.com')
    })
  })

  describe('edge cases', () => {
    it('should handle whitespace in skill ID', async () => {
      const result = await executeGetSkill({ id: '  anthropic/commit  ' }, context)
      expect(result.skill.id).toBe('anthropic/commit')
    })

    it('should throw for whitespace-only ID', async () => {
      try {
        await executeGetSkill({ id: '   ' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.VALIDATION_REQUIRED_FIELD)
      }
    })

    it('should provide suggestion for not found skill', async () => {
      try {
        await executeGetSkill({ id: 'nonexistent/skill' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).suggestion).toBeDefined()
        expect((error as SkillsmithError).suggestion).toContain('search')
      }
    })

    it('should provide suggestion for invalid ID format', async () => {
      try {
        await executeGetSkill({ id: 'invalid-format' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).suggestion).toBeDefined()
        expect((error as SkillsmithError).suggestion).toContain('author/skill-name')
      }
    })
  })

  describe('score conversion', () => {
    it('should convert quality score from decimal to percentage', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      // Quality score in seed data is 0.95, should convert to 95
      expect(result.skill.score).toBe(95)
    })

    it('should handle lower quality scores', async () => {
      const result = await executeGetSkill({ id: 'community/api-docs' }, context)
      // Quality score in seed data is 0.78, should convert to 78
      expect(result.skill.score).toBe(78)
    })
  })
})

/**
 * SMI-1785: Tests for formatSkillDetails with various skill configurations
 * Covers scoreBreakdown display, security status display, and trust tier formatting
 */
describe('formatSkillDetails branch coverage', () => {
  it('should format skill with scoreBreakdown', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        version: '1.0.0',
        category: 'development' as const,
        trustTier: 'verified' as const,
        score: 90,
        scoreBreakdown: {
          quality: 95,
          popularity: 80,
          maintenance: 92,
          security: 88,
          documentation: 85,
        },
        tags: ['test'],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Score Breakdown:')
    expect(formatted).toContain('Quality:')
    expect(formatted).toContain('Popularity:')
    expect(formatted).toContain('Maintenance:')
    expect(formatted).toContain('Security:')
    expect(formatted).toContain('Documentation:')
    expect(formatted).toContain('[')
    expect(formatted).toContain(']')
  })

  it('should format skill with security passed=null (not scanned)', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        security: {
          passed: null,
          riskScore: null,
          findingsCount: 0,
          scannedAt: null,
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Status: Not scanned')
  })

  it('should format skill with security passed=true', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        security: {
          passed: true,
          riskScore: 15,
          findingsCount: 0,
          scannedAt: '2024-01-15T12:00:00.000Z',
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Status: PASSED')
    expect(formatted).toContain('Risk Score: 15/100')
    expect(formatted).toContain('Findings: 0')
    expect(formatted).toContain('Scanned:')
  })

  it('should format skill with security passed=false', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'experimental' as const,
        score: 60,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        security: {
          passed: false,
          riskScore: 75,
          findingsCount: 5,
          scannedAt: '2024-01-15T12:00:00.000Z',
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Status: FAILED')
    expect(formatted).toContain('Risk Score: 75/100 (HIGH)')
    expect(formatted).toContain('Findings: 5')
    expect(formatted).toContain('WARNING')
    expect(formatted).toContain('Scanned:')
  })

  it('should format skill without security info', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'unknown' as const,
        score: 50,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Status: Not scanned')
    expect(formatted).toContain('UNKNOWN')
  })

  it('should format skill without repository', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        repository: undefined,
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).not.toContain('Repository:')
  })

  it('should format skill without tags', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).not.toContain('Tags:')
  })
})

/**
 * SMI-5327: formatSkillDetails license display
 * Null license must render as "unknown", not imply any permissive conclusion.
 */
describe('formatSkillDetails — license display (SMI-5327)', () => {
  const baseSkill = {
    id: 'test/skill',
    name: 'test-skill',
    description: 'A test skill',
    author: 'test',
    category: 'development' as const,
    trustTier: 'community' as const,
    score: 80,
    tags: [] as string[],
    installCommand: 'claude skill add test/skill',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
  const baseResponse = (license?: string | null) => ({
    skill: { ...baseSkill, license },
    installCommand: 'claude skill add test/skill',
    timing: { totalMs: 10 },
  })

  it('renders "License: MIT" verbatim for an MIT-licensed skill', () => {
    const formatted = formatSkillDetails(baseResponse('MIT'))
    expect(formatted).toContain('License: MIT')
    expect(formatted).not.toContain('License: Unknown')
  })

  it('renders "License: Apache-2.0" verbatim', () => {
    const formatted = formatSkillDetails(baseResponse('Apache-2.0'))
    expect(formatted).toContain('License: Apache-2.0')
  })

  it('renders "License: Unknown" when license is null', () => {
    const formatted = formatSkillDetails(baseResponse(null))
    expect(formatted).toContain('License: Unknown')
    // Must not imply any permissive conclusion for a null license
    expect(formatted).not.toContain('no license')
    expect(formatted).not.toContain('unrestricted')
    expect(formatted).not.toContain('freely usable')
    expect(formatted).not.toContain('public domain')
  })

  it('renders "License: Unknown" when license field is absent', () => {
    const formatted = formatSkillDetails(baseResponse(undefined))
    expect(formatted).toContain('License: Unknown')
  })

  it('renders "License: Unknown" when license is an empty string', () => {
    const formatted = formatSkillDetails(baseResponse(''))
    expect(formatted).toContain('License: Unknown')
  })

  it('renders "License: Unknown" when license is whitespace-only', () => {
    const formatted = formatSkillDetails(baseResponse('   '))
    expect(formatted).toContain('License: Unknown')
  })
})

/**
 * SMI-5360: formatSkillDetails installability line. A skill that carries a
 * repository but is not installable is blocked (quarantined / failed scan), NOT
 * discovery-only — the reason text must distinguish the two.
 */
describe('formatSkillDetails — installability (SMI-5360)', () => {
  const baseSkill = {
    id: 'test/skill',
    name: 'test-skill',
    description: 'A test skill',
    author: 'test',
    category: 'development' as const,
    trustTier: 'community' as const,
    score: 80,
    tags: [] as string[],
    installCommand: 'claude skill add test/skill',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
  const responseWith = (overrides: { installable?: boolean; repository?: string }) => ({
    skill: { ...baseSkill, ...overrides },
    installCommand: 'claude skill add test/skill',
    timing: { totalMs: 10 },
  })

  it('prints "Installable: yes" when installable', () => {
    const formatted = formatSkillDetails(
      responseWith({ installable: true, repository: 'https://github.com/test/skill' })
    )
    expect(formatted).toContain('Installable: yes')
  })

  it('labels a non-installable skill that has a repository as blocked, not discovery-only', () => {
    const formatted = formatSkillDetails(
      responseWith({ installable: false, repository: 'https://github.com/test/skill' })
    )
    expect(formatted).toContain('Installable: NO')
    expect(formatted).toContain('blocked')
    expect(formatted).not.toContain('discovery-only')
  })

  it('labels a non-installable skill with no repository as discovery-only', () => {
    const formatted = formatSkillDetails(responseWith({ installable: false }))
    expect(formatted).toContain('Installable: NO')
    expect(formatted).toContain('discovery-only')
    expect(formatted).not.toContain('blocked')
  })
})

/**
 * SMI-5360: end-to-end local-DB path. Local quarantine lives in
 * QuarantineRepository (a separate table), not on the skill row, so the offline
 * get_skill fallback must consult it before reporting installability.
 */
describe('Get Skill Tool — local-DB quarantine gate (SMI-5360)', () => {
  it('reports installable=false and labels it blocked for a quarantined seeded skill', async () => {
    const ctx = await createSeededTestContext()
    try {
      const quarantineRepo = new QuarantineRepository(ctx.db)
      quarantineRepo.create({
        skillId: 'anthropic/commit',
        source: 'security-scanner',
        quarantineReason: 'test: simulated malicious finding',
        severity: 'MALICIOUS',
      })

      const result = await executeGetSkill({ id: 'anthropic/commit' }, ctx)
      expect(result.skill.installable).toBe(false)

      const formatted = formatSkillDetails(result)
      expect(formatted).toContain('Installable: NO')
      expect(formatted).toContain('blocked')
    } finally {
      await disposeTestContext(ctx)
    }
  })

  it('keeps installable=true for a non-quarantined seeded skill (regression guard)', async () => {
    const ctx = await createSeededTestContext()
    try {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, ctx)
      expect(result.skill.installable).toBe(true)
      expect(formatSkillDetails(result)).toContain('Installable: yes')
    } finally {
      await disposeTestContext(ctx)
    }
  })
})
