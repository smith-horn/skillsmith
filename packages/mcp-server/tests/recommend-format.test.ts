/**
 * Tests for SMI-741: MCP Skill Recommend Tool — formatRecommendations output
 *
 * SMI-5991: split from recommend.test.ts (which was pushed over the 500-line
 * cap by that fix) to keep each file under 500 lines — same precedent as
 * recommend-online-path.test.ts (SMI-2755 Wave 2).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { executeRecommend, formatRecommendations } from '../src/tools/recommend.js'
import { createTestDatabase, type TestDatabaseContext } from './integration/setup.js'
import type { ToolContext } from '../src/context.js'
import * as InstalledSkillsModule from '../src/utils/installed-skills.js'

let testDbContext: TestDatabaseContext
let toolContext: ToolContext

beforeAll(async () => {
  testDbContext = await createTestDatabase()
  toolContext = {
    db: testDbContext.db,
    searchService: testDbContext.searchService,
    skillRepository: testDbContext.skillRepository,
    coInstallRepository: testDbContext.coInstallRepository,
    skillDependencyRepository: testDbContext.skillDependencyRepository,
    sessionInstalledSkillIds: [],
    apiClient: testDbContext.apiClient,
  }
})

afterAll(async () => {
  await testDbContext.cleanup()
})

// SMI-5991: see recommend.test.ts's beforeEach for the full rationale — a
// synthetic, non-fixture-colliding ID so auto-detection is deterministic
// without perturbing the installed-skill/overlap-detection filtering paths.
beforeEach(() => {
  vi.spyOn(InstalledSkillsModule, 'getInstalledSkills').mockResolvedValue([
    'local/smi-5991-autodetect-stub',
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('formatRecommendations', () => {
  it('should format recommendations for terminal display', async () => {
    const result = await executeRecommend(
      {
        installed_skills: ['anthropic/commit'],
        detect_overlap: false, // Disable overlap detection for consistent testing
        limit: 3,
      },
      toolContext
    )
    const formatted = formatRecommendations(result)

    expect(formatted).toContain('Skill Recommendations')
    expect(formatted).toContain('recommendation(s)')
    expect(formatted).toContain('Score:')
    expect(formatted).toContain('Relevance:')
    expect(formatted).toContain('ID:')
  })

  it('should display trust badges', async () => {
    const result = await executeRecommend(
      {
        installed_skills: [],
        detect_overlap: false, // Disable overlap detection for consistent testing
        limit: 5,
      },
      toolContext
    )
    const formatted = formatRecommendations(result)

    // Should contain at least one trust badge
    const hasBadge =
      formatted.includes('[VERIFIED]') ||
      formatted.includes('[COMMUNITY]') ||
      formatted.includes('[STANDARD]') ||
      formatted.includes('[UNVERIFIED]')
    expect(hasBadge).toBe(true)
  })

  it('should show candidates considered and timing', async () => {
    const result = await executeRecommend(
      {
        installed_skills: [],
        detect_overlap: false, // Disable overlap detection for consistent testing
        limit: 3,
      },
      toolContext
    )
    const formatted = formatRecommendations(result)

    expect(formatted).toContain('Candidates considered:')
    expect(formatted).toContain('ms')
  })

  // SMI-5893 (Wave 7 Step 2): auto-detected footer describes multi-harness
  // detection instead of naming one hardcoded client path.
  it('describes multi-harness auto-detection instead of a hardcoded path when auto-detected', async () => {
    const result = await executeRecommend(
      {
        installed_skills: [], // empty triggers auto-detection (autoDetected = true)
        detect_overlap: false,
        limit: 3,
      },
      toolContext
    )
    expect(result.context.auto_detected).toBe(true)

    const formatted = formatRecommendations(result)

    expect(formatted).toContain('auto-detected from your installed skills across all clients')
    expect(formatted).not.toContain('~/.claude/skills')
  })

  // SMI-1631: Role display in formatted output
  it('should show role filter in formatted output when applied', async () => {
    const result = await executeRecommend(
      {
        installed_skills: [],
        role: 'testing',
        detect_overlap: false,
        limit: 5,
      },
      toolContext
    )
    const formatted = formatRecommendations(result)

    expect(formatted).toContain('Role filter: testing')
  })

  it('should show role filtered count when skills were filtered', async () => {
    const result = await executeRecommend(
      {
        installed_skills: [],
        role: 'testing',
        detect_overlap: false,
        limit: 10,
      },
      toolContext
    )

    // SMI-5991 (code review): role_filtered counts across the whole
    // candidate pool (58-skill fixture set spanning many categories), not
    // just the returned limit — filtering to a single role deterministically
    // excludes the majority of it, so this is no longer a conditional skip.
    expect(result.role_filtered).toBeGreaterThan(0)
    const formatted = formatRecommendations(result)
    expect(formatted).toContain(`Filtered for role: ${result.role_filtered}`)
  })
})
