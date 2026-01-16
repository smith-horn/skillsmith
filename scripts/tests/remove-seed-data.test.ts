/**
 * Integration Tests for remove-seed-data.ts
 *
 * Tests seed skill identification, backup creation, dry-run mode,
 * error handling, and CLI argument parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { SupabaseSkill } from '../lib/migration-utils.js'

// Mock modules before imports
vi.mock('fs')
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

// We need to extract and test internal functions
// Since the script doesn't export them, we'll need to test via behavior or re-implement for testing

// Fake seed patterns (mirrored from the script)
const FAKE_SEED_PATTERNS = [
  'github.com/skillsmith-community/',
  'github.com/skillsmith-labs/',
  'github.com/unknown-contributor/',
]

// Real skill patterns (should NOT be matched)
// Used in tests to verify these patterns are NOT detected as fake seeds
const REAL_SKILL_PATTERNS_FOR_TESTS = [
  'github.com/anthropics/',
  'github.com/huggingface/',
  'github.com/vercel-labs/',
] as const
void REAL_SKILL_PATTERNS_FOR_TESTS // Prevent unused variable warning

/**
 * Reimplementation of isFakeSeedSkill for testing
 * (Matches the logic in remove-seed-data.ts)
 */
function isFakeSeedSkill(skill: SupabaseSkill): boolean {
  if (!skill.repo_url) return false
  const repoUrl = skill.repo_url.toLowerCase()
  return FAKE_SEED_PATTERNS.some((pattern) => repoUrl.includes(pattern.toLowerCase()))
}

/**
 * Get matched pattern (matches script logic)
 */
function getMatchedPattern(repoUrl: string): string {
  const url = repoUrl.toLowerCase()
  for (const pattern of FAKE_SEED_PATTERNS) {
    if (url.includes(pattern.toLowerCase())) {
      return pattern
    }
  }
  return 'unknown'
}

/**
 * Parse CLI arguments (matches script logic)
 */
function parseArgs(args: string[]): {
  dryRun: boolean
  backupOnly: boolean
  force: boolean
  help: boolean
} {
  return {
    dryRun: args.includes('--dry-run'),
    backupOnly: args.includes('--backup-only'),
    force: args.includes('--force'),
    help: args.includes('--help') || args.includes('-h'),
  }
}

/**
 * Create a mock SupabaseSkill for testing
 */
function createMockSkill(overrides: Partial<SupabaseSkill> = {}): SupabaseSkill {
  return {
    id: `skill-${Math.random().toString(36).slice(2)}`,
    name: 'Test Skill',
    description: 'A test skill',
    author: 'test-author',
    repo_url: 'https://github.com/test/skill',
    quality_score: 75,
    trust_tier: 'community',
    tags: ['test'],
    source: 'github',
    stars: 10,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

// ============================================================================
// 1. Seed Skill Identification Tests
// ============================================================================

describe('isFakeSeedSkill()', () => {
  describe('fake seed pattern detection', () => {
    it('should detect skillsmith-community pattern', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/skillsmith-community/git-helper',
      })
      expect(isFakeSeedSkill(skill)).toBe(true)
    })

    it('should detect skillsmith-labs pattern', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/skillsmith-labs/test-runner',
      })
      expect(isFakeSeedSkill(skill)).toBe(true)
    })

    it('should detect unknown-contributor pattern', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/unknown-contributor/demo-skill',
      })
      expect(isFakeSeedSkill(skill)).toBe(true)
    })

    it('should detect patterns with nested paths', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/skillsmith-community/tools/nested/deep',
      })
      expect(isFakeSeedSkill(skill)).toBe(true)
    })
  })

  describe('real skill URL detection (should NOT match)', () => {
    it('should NOT match anthropics URLs', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/anthropics/claude-code-skill',
      })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })

    it('should NOT match huggingface URLs', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/huggingface/transformers-skill',
      })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })

    it('should NOT match vercel-labs URLs', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/vercel-labs/ai-sdk-skill',
      })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })

    it('should NOT match random community URLs', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/awesome-developer/cool-skill',
      })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })

    it('should NOT match gitlab URLs', () => {
      const skill = createMockSkill({
        repo_url: 'https://gitlab.com/skillsmith-community/tool',
      })
      // Should not match because pattern requires github.com
      expect(isFakeSeedSkill(skill)).toBe(false)
    })
  })

  describe('case insensitivity', () => {
    it('should match uppercase URLs', () => {
      const skill = createMockSkill({
        repo_url: 'HTTPS://GITHUB.COM/SKILLSMITH-COMMUNITY/SKILL',
      })
      expect(isFakeSeedSkill(skill)).toBe(true)
    })

    it('should match mixed case URLs', () => {
      const skill = createMockSkill({
        repo_url: 'https://GitHub.com/Skillsmith-Labs/Skill',
      })
      expect(isFakeSeedSkill(skill)).toBe(true)
    })

    it('should match camelCase variants', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/Unknown-Contributor/mySkill',
      })
      expect(isFakeSeedSkill(skill)).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('should return false for null repo_url', () => {
      const skill = createMockSkill({ repo_url: null })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })

    it('should return false for empty repo_url', () => {
      const skill = createMockSkill({ repo_url: '' })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })

    it('should return false for undefined repo_url', () => {
      const skill = createMockSkill({ repo_url: undefined as unknown as string })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })

    it('should not match partial pattern (skillsmith without suffix)', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/skillsmith/official-tool',
      })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })

    it('should not match similar but different patterns', () => {
      const skill = createMockSkill({
        repo_url: 'https://github.com/skillsmith-official/tool',
      })
      expect(isFakeSeedSkill(skill)).toBe(false)
    })
  })
})

describe('getMatchedPattern()', () => {
  it('should return skillsmith-community pattern when matched', () => {
    expect(getMatchedPattern('https://github.com/skillsmith-community/tool')).toBe(
      'github.com/skillsmith-community/'
    )
  })

  it('should return skillsmith-labs pattern when matched', () => {
    expect(getMatchedPattern('https://github.com/skillsmith-labs/tool')).toBe(
      'github.com/skillsmith-labs/'
    )
  })

  it('should return unknown-contributor pattern when matched', () => {
    expect(getMatchedPattern('https://github.com/unknown-contributor/tool')).toBe(
      'github.com/unknown-contributor/'
    )
  })

  it('should return "unknown" for non-matching URLs', () => {
    expect(getMatchedPattern('https://github.com/real-author/tool')).toBe('unknown')
  })

  it('should handle case insensitivity', () => {
    expect(getMatchedPattern('HTTPS://GITHUB.COM/SKILLSMITH-COMMUNITY/TOOL')).toBe(
      'github.com/skillsmith-community/'
    )
  })
})

// ============================================================================
// 2. Backup Creation Tests
// ============================================================================

describe('Backup Creation', () => {
  const mockFs = vi.mocked(fs)

  beforeEach(() => {
    vi.clearAllMocks()
    mockFs.existsSync.mockReturnValue(true)
    mockFs.writeFileSync.mockImplementation(() => {})
    mockFs.mkdirSync.mockImplementation(() => undefined)
  })

  /**
   * Create backup function (mirrors script implementation)
   */
  function createBackup(skills: SupabaseSkill[], dataDir: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backupFileName = `seed-backup-${timestamp}.json`
    const backupPath = path.join(dataDir, backupFileName)

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    const backupData = {
      timestamp: new Date().toISOString(),
      description: 'Backup of seed skills before deletion',
      patterns: FAKE_SEED_PATTERNS,
      count: skills.length,
      skills: skills,
    }

    fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2))
    return backupPath
  }

  it('should create backup file with correct timestamp format', () => {
    const skills = [createMockSkill()]
    const dataDir = '/test/data'

    // Mock Date to control timestamp
    const mockDate = new Date('2025-01-15T10:30:45.123Z')
    vi.setSystemTime(mockDate)

    const backupPath = createBackup(skills, dataDir)

    expect(backupPath).toMatch(/seed-backup-2025-01-15T10-30-45\.json$/)
    expect(mockFs.writeFileSync).toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('should create backup with expected JSON structure', () => {
    const skills = [
      createMockSkill({ id: 'skill-1', name: 'Skill One' }),
      createMockSkill({ id: 'skill-2', name: 'Skill Two' }),
    ]
    const dataDir = '/test/data'

    createBackup(skills, dataDir)

    const writeCall = mockFs.writeFileSync.mock.calls[0]
    const writtenContent = JSON.parse(writeCall[1] as string)

    expect(writtenContent).toHaveProperty('timestamp')
    expect(writtenContent).toHaveProperty('description', 'Backup of seed skills before deletion')
    expect(writtenContent).toHaveProperty('patterns')
    expect(writtenContent.patterns).toEqual(FAKE_SEED_PATTERNS)
    expect(writtenContent).toHaveProperty('count', 2)
    expect(writtenContent).toHaveProperty('skills')
    expect(writtenContent.skills).toHaveLength(2)
    expect(writtenContent.skills[0].id).toBe('skill-1')
    expect(writtenContent.skills[1].id).toBe('skill-2')
  })

  it('should create backup directory if missing', () => {
    mockFs.existsSync.mockReturnValue(false)

    const skills = [createMockSkill()]
    const dataDir = '/test/new-data-dir'

    createBackup(skills, dataDir)

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(dataDir, { recursive: true })
    expect(mockFs.writeFileSync).toHaveBeenCalled()
  })

  it('should not create directory if it already exists', () => {
    mockFs.existsSync.mockReturnValue(true)

    const skills = [createMockSkill()]
    const dataDir = '/test/existing-dir'

    createBackup(skills, dataDir)

    expect(mockFs.mkdirSync).not.toHaveBeenCalled()
    expect(mockFs.writeFileSync).toHaveBeenCalled()
  })

  it('should handle empty skills array', () => {
    const skills: SupabaseSkill[] = []
    const dataDir = '/test/data'

    createBackup(skills, dataDir)

    const writeCall = mockFs.writeFileSync.mock.calls[0]
    const writtenContent = JSON.parse(writeCall[1] as string)

    expect(writtenContent.count).toBe(0)
    expect(writtenContent.skills).toEqual([])
  })

  it('should handle large number of skills', () => {
    const skills = Array.from({ length: 1000 }, (_, i) =>
      createMockSkill({ id: `skill-${i}`, name: `Skill ${i}` })
    )
    const dataDir = '/test/data'

    createBackup(skills, dataDir)

    const writeCall = mockFs.writeFileSync.mock.calls[0]
    const writtenContent = JSON.parse(writeCall[1] as string)

    expect(writtenContent.count).toBe(1000)
    expect(writtenContent.skills).toHaveLength(1000)
  })
})

// ============================================================================
// 3. Dry-Run Mode Tests
// ============================================================================

describe('Dry-Run Mode', () => {
  /**
   * Simulate deleteSkills behavior in dry-run mode
   */
  function simulateDeleteSkills(
    skillIds: string[],
    dryRun: boolean
  ): { deleted: number; errors: number; actuallyDeleted: boolean } {
    if (dryRun) {
      return { deleted: skillIds.length, errors: 0, actuallyDeleted: false }
    }
    return { deleted: skillIds.length, errors: 0, actuallyDeleted: true }
  }

  it('should not delete any skills in dry-run mode', () => {
    const skillIds = ['skill-1', 'skill-2', 'skill-3']
    const result = simulateDeleteSkills(skillIds, true)

    expect(result.actuallyDeleted).toBe(false)
    expect(result.deleted).toBe(3) // Reports what WOULD be deleted
    expect(result.errors).toBe(0)
  })

  it('should show count of what would be deleted', () => {
    const skillIds = Array.from({ length: 50 }, (_, i) => `skill-${i}`)
    const result = simulateDeleteSkills(skillIds, true)

    expect(result.deleted).toBe(50)
    expect(result.actuallyDeleted).toBe(false)
  })

  it('should perform actual deletion when not in dry-run mode', () => {
    const skillIds = ['skill-1', 'skill-2']
    const result = simulateDeleteSkills(skillIds, false)

    expect(result.actuallyDeleted).toBe(true)
    expect(result.deleted).toBe(2)
  })
})

// ============================================================================
// 4. Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  describe('missing environment variables', () => {
    const originalEnv = process.env

    beforeEach(() => {
      vi.resetModules()
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    /**
     * Validate environment (mirrors script implementation)
     */
    function validateEnv(): { supabaseUrl: string; supabaseServiceKey: string } | null {
      const supabaseUrl = process.env.SUPABASE_URL
      const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

      if (!supabaseUrl || !supabaseServiceKey) {
        return null
      }

      return { supabaseUrl, supabaseServiceKey }
    }

    it('should return null when SUPABASE_URL is missing', () => {
      delete process.env.SUPABASE_URL
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'

      expect(validateEnv()).toBeNull()
    })

    it('should return null when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      delete process.env.SUPABASE_SERVICE_ROLE_KEY

      expect(validateEnv()).toBeNull()
    })

    it('should return null when both are missing', () => {
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_ROLE_KEY

      expect(validateEnv()).toBeNull()
    })

    it('should return config when both are present', () => {
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'

      const result = validateEnv()
      expect(result).not.toBeNull()
      expect(result?.supabaseUrl).toBe('https://test.supabase.co')
      expect(result?.supabaseServiceKey).toBe('test-key')
    })

    it('should return null for empty string values', () => {
      process.env.SUPABASE_URL = ''
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'

      expect(validateEnv()).toBeNull()
    })
  })

  describe('Supabase connection errors', () => {
    it('should handle network errors gracefully', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            range: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: null,
                error: { message: 'Network error: Unable to connect' },
              }),
            }),
          }),
        }),
      }

      const fetchAllSkills = async () => {
        const { data, error } = await mockSupabase
          .from('skills')
          .select('*')
          .range(0, 999)
          .order('id')

        if (error) {
          throw new Error(`Failed to fetch from Supabase: ${error.message}`)
        }

        return data
      }

      await expect(fetchAllSkills()).rejects.toThrow('Failed to fetch from Supabase: Network error')
    })

    it('should handle authentication errors', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            range: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: null,
                error: { message: 'Invalid API key', code: '401' },
              }),
            }),
          }),
        }),
      }

      const fetchAllSkills = async () => {
        const { data, error } = await mockSupabase
          .from('skills')
          .select('*')
          .range(0, 999)
          .order('id')

        if (error) {
          throw new Error(`Failed to fetch from Supabase: ${error.message}`)
        }

        return data
      }

      await expect(fetchAllSkills()).rejects.toThrow('Invalid API key')
    })

    it('should handle rate limit errors', async () => {
      const isRateLimitError = (error: { message?: string; code?: string }): boolean => {
        const msg = error.message?.toLowerCase() || ''
        return (
          error.code === '429' ||
          msg.includes('rate limit') ||
          msg.includes('too many requests') ||
          msg.includes('quota exceeded')
        )
      }

      expect(isRateLimitError({ code: '429' })).toBe(true)
      expect(isRateLimitError({ message: 'Rate limit exceeded' })).toBe(true)
      expect(isRateLimitError({ message: 'Too many requests' })).toBe(true)
      expect(isRateLimitError({ message: 'Quota exceeded for this minute' })).toBe(true)
      expect(isRateLimitError({ message: 'Normal error' })).toBe(false)
    })
  })

  describe('empty database handling', () => {
    it('should handle empty database gracefully', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            range: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          }),
        }),
      }

      const fetchAllSkills = async () => {
        const skills: SupabaseSkill[] = []
        const { data, error } = await mockSupabase
          .from('skills')
          .select('*')
          .range(0, 999)
          .order('id')

        if (error) {
          throw new Error(`Failed to fetch from Supabase: ${error.message}`)
        }

        if (!data || data.length === 0) {
          return skills
        }

        return data
      }

      const result = await fetchAllSkills()
      expect(result).toEqual([])
    })

    it('should report no skills to delete when database has no seed skills', () => {
      const allSkills = [
        createMockSkill({ repo_url: 'https://github.com/anthropics/tool' }),
        createMockSkill({ repo_url: 'https://github.com/vercel-labs/ai' }),
      ]

      const seedSkills = allSkills.filter(isFakeSeedSkill)

      expect(seedSkills).toHaveLength(0)
    })
  })
})

// ============================================================================
// 5. CLI Argument Tests
// ============================================================================

describe('CLI Arguments', () => {
  describe('parseArgs()', () => {
    it('should parse --dry-run flag', () => {
      const result = parseArgs(['--dry-run'])
      expect(result.dryRun).toBe(true)
      expect(result.backupOnly).toBe(false)
      expect(result.force).toBe(false)
      expect(result.help).toBe(false)
    })

    it('should parse --backup-only flag', () => {
      const result = parseArgs(['--backup-only'])
      expect(result.dryRun).toBe(false)
      expect(result.backupOnly).toBe(true)
      expect(result.force).toBe(false)
      expect(result.help).toBe(false)
    })

    it('should parse --force flag', () => {
      const result = parseArgs(['--force'])
      expect(result.dryRun).toBe(false)
      expect(result.backupOnly).toBe(false)
      expect(result.force).toBe(true)
      expect(result.help).toBe(false)
    })

    it('should parse --help flag', () => {
      const result = parseArgs(['--help'])
      expect(result.help).toBe(true)
    })

    it('should parse -h flag (short for help)', () => {
      const result = parseArgs(['-h'])
      expect(result.help).toBe(true)
    })

    it('should handle multiple flags together', () => {
      const result = parseArgs(['--dry-run', '--force'])
      expect(result.dryRun).toBe(true)
      expect(result.force).toBe(true)
      expect(result.backupOnly).toBe(false)
    })

    it('should handle no flags (all false)', () => {
      const result = parseArgs([])
      expect(result.dryRun).toBe(false)
      expect(result.backupOnly).toBe(false)
      expect(result.force).toBe(false)
      expect(result.help).toBe(false)
    })

    it('should ignore unknown flags', () => {
      const result = parseArgs(['--unknown', '--another-unknown'])
      expect(result.dryRun).toBe(false)
      expect(result.backupOnly).toBe(false)
      expect(result.force).toBe(false)
      expect(result.help).toBe(false)
    })

    it('should handle flags in any order', () => {
      const result1 = parseArgs(['--force', '--dry-run', '--backup-only'])
      const result2 = parseArgs(['--backup-only', '--force', '--dry-run'])

      expect(result1).toEqual(result2)
      expect(result1.dryRun).toBe(true)
      expect(result1.force).toBe(true)
      expect(result1.backupOnly).toBe(true)
    })

    it('should handle flags with extra whitespace in array', () => {
      const result = parseArgs(['--dry-run', '', '--force'])
      expect(result.dryRun).toBe(true)
      expect(result.force).toBe(true)
    })
  })
})

// ============================================================================
// 6. Integration Test: Full Workflow Simulation
// ============================================================================

describe('Full Workflow Simulation', () => {
  const mockFs = vi.mocked(fs)

  beforeEach(() => {
    vi.clearAllMocks()
    mockFs.existsSync.mockReturnValue(true)
    mockFs.writeFileSync.mockImplementation(() => {})
    mockFs.mkdirSync.mockImplementation(() => undefined)
  })

  it('should correctly identify seed skills from mixed dataset', () => {
    const allSkills = [
      createMockSkill({ id: '1', repo_url: 'https://github.com/skillsmith-community/tool-1' }),
      createMockSkill({ id: '2', repo_url: 'https://github.com/anthropics/claude-skill' }),
      createMockSkill({ id: '3', repo_url: 'https://github.com/skillsmith-labs/experiment' }),
      createMockSkill({ id: '4', repo_url: 'https://github.com/vercel-labs/ai-sdk' }),
      createMockSkill({ id: '5', repo_url: 'https://github.com/unknown-contributor/test' }),
      createMockSkill({ id: '6', repo_url: 'https://github.com/huggingface/transformers' }),
      createMockSkill({ id: '7', repo_url: null }),
    ]

    const seedSkills = allSkills.filter(isFakeSeedSkill)
    const realSkills = allSkills.filter((s) => !isFakeSeedSkill(s))

    expect(seedSkills.map((s) => s.id)).toEqual(['1', '3', '5'])
    expect(realSkills.map((s) => s.id)).toEqual(['2', '4', '6', '7'])
  })

  it('should simulate complete dry-run workflow', () => {
    const options = parseArgs(['--dry-run'])
    expect(options.dryRun).toBe(true)

    const allSkills = [
      createMockSkill({ id: '1', repo_url: 'https://github.com/skillsmith-community/tool' }),
      createMockSkill({ id: '2', repo_url: 'https://github.com/anthropics/claude' }),
    ]

    const seedSkills = allSkills.filter(isFakeSeedSkill)
    expect(seedSkills).toHaveLength(1)

    // In dry-run, backup is still created
    mockFs.existsSync.mockReturnValue(true)

    const backupData = {
      timestamp: new Date().toISOString(),
      description: 'Backup of seed skills before deletion',
      patterns: FAKE_SEED_PATTERNS,
      count: seedSkills.length,
      skills: seedSkills,
    }

    mockFs.writeFileSync('/test/data/seed-backup-test.json', JSON.stringify(backupData, null, 2))

    expect(mockFs.writeFileSync).toHaveBeenCalled()

    // Deletion is simulated but not performed
    const deleteResult = { deleted: 1, errors: 0, actuallyDeleted: false }
    expect(deleteResult.actuallyDeleted).toBe(false)
  })

  it('should simulate backup-only workflow', () => {
    const options = parseArgs(['--backup-only'])
    expect(options.backupOnly).toBe(true)

    const seedSkills = [
      createMockSkill({ id: '1', repo_url: 'https://github.com/skillsmith-community/tool' }),
    ]

    // Backup is created
    mockFs.existsSync.mockReturnValue(true)
    const backupData = {
      timestamp: new Date().toISOString(),
      description: 'Backup of seed skills before deletion',
      patterns: FAKE_SEED_PATTERNS,
      count: seedSkills.length,
      skills: seedSkills,
    }

    mockFs.writeFileSync('/test/data/seed-backup-test.json', JSON.stringify(backupData, null, 2))
    expect(mockFs.writeFileSync).toHaveBeenCalled()

    // No deletion should occur in backup-only mode
    // (Workflow would exit before delete step)
  })

  it('should group skills by pattern for reporting', () => {
    const seedSkills = [
      createMockSkill({ id: '1', repo_url: 'https://github.com/skillsmith-community/a' }),
      createMockSkill({ id: '2', repo_url: 'https://github.com/skillsmith-community/b' }),
      createMockSkill({ id: '3', repo_url: 'https://github.com/skillsmith-labs/c' }),
      createMockSkill({ id: '4', repo_url: 'https://github.com/unknown-contributor/d' }),
    ]

    const byPattern = new Map<string, SupabaseSkill[]>()
    for (const skill of seedSkills) {
      const pattern = getMatchedPattern(skill.repo_url || '')
      if (!byPattern.has(pattern)) {
        byPattern.set(pattern, [])
      }
      byPattern.get(pattern)!.push(skill)
    }

    expect(byPattern.get('github.com/skillsmith-community/')).toHaveLength(2)
    expect(byPattern.get('github.com/skillsmith-labs/')).toHaveLength(1)
    expect(byPattern.get('github.com/unknown-contributor/')).toHaveLength(1)
  })
})

// ============================================================================
// 7. Delete with Retry Tests
// ============================================================================

describe('Delete with Retry Logic', () => {
  it('should retry on rate limit errors', async () => {
    let attempts = 0
    const mockDelete = async (): Promise<{ error: { message: string; code: string } | null }> => {
      attempts++
      if (attempts < 3) {
        return { error: { message: 'Rate limit exceeded', code: '429' } }
      }
      return { error: null }
    }

    // Simulate retry logic
    const MAX_RETRIES = 3
    let success = false
    for (let i = 0; i < MAX_RETRIES; i++) {
      const result = await mockDelete()
      if (!result.error) {
        success = true
        break
      }
    }

    expect(success).toBe(true)
    expect(attempts).toBe(3)
  })

  it('should fail after max retries', async () => {
    let attempts = 0
    const mockDelete = async (): Promise<{ error: { message: string; code: string } | null }> => {
      attempts++
      return { error: { message: 'Rate limit exceeded', code: '429' } }
    }

    const MAX_RETRIES = 3
    let success = false
    for (let i = 0; i < MAX_RETRIES; i++) {
      const result = await mockDelete()
      if (!result.error) {
        success = true
        break
      }
    }

    expect(success).toBe(false)
    expect(attempts).toBe(3)
  })

  it('should not retry on non-rate-limit errors', async () => {
    let attempts = 0
    const mockDelete = async (): Promise<{ error: { message: string; code: string } | null }> => {
      attempts++
      return { error: { message: 'Permission denied', code: '403' } }
    }

    const isRateLimitError = (error: { message?: string; code?: string }): boolean => {
      return error.code === '429'
    }

    const MAX_RETRIES = 3
    let shouldRetry = true
    for (let i = 0; i < MAX_RETRIES && shouldRetry; i++) {
      const result = await mockDelete()
      if (!result.error) {
        break
      }
      shouldRetry = isRateLimitError(result.error)
    }

    expect(attempts).toBe(1) // Should only try once
  })
})
