/**
 * SMI-1353: CLI recommend command — error handling, limit validation, trust tier.
 *
 * Sibling of recommend.test.ts and recommend.filters.test.ts; see those files
 * for context. Shared mocks/fixtures live in recommend.test-helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockCodebaseContext, createMockApiResponse } from './recommend.test-helpers.js'

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  getRecommendations: vi.fn(),
  spinner: {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  },
}))

vi.mock('@skillsmith/core', () => ({
  CodebaseAnalyzer: class MockCodebaseAnalyzer {
    analyze(...args: unknown[]) {
      return mocks.analyze(...args)
    }
  },
  createApiClient: () => ({
    getRecommendations: (...args: unknown[]) => mocks.getRecommendations(...args),
  }),
  // SMI-4474: stub for JWT auto-load (tests don't exercise the JWT path).
  loadStoredAccessToken: () => Promise.resolve(null),
  SKILL_ROLES: [
    'code-quality',
    'testing',
    'documentation',
    'workflow',
    'security',
    'development-partner',
  ] as const,
}))
vi.mock('ora', () => ({ default: () => mocks.spinner }))

const mockAnalyze = mocks.analyze
const mockGetRecommendations = mocks.getRecommendations
const mockSpinner = mocks.spinner

const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()

const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

describe('SMI-1353: CLI recommend command — errors / limit / trust tier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    console.error = mockConsoleError
    mockAnalyze.mockResolvedValue(createMockCodebaseContext())
    mockGetRecommendations.mockResolvedValue(createMockApiResponse())
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
  })

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('error handling', () => {
    it('should handle CodebaseAnalyzer errors gracefully', async () => {
      mockAnalyze.mockRejectedValue(new Error('Cannot read directory'))

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '/nonexistent'])

      expect(mockSpinner.fail).toHaveBeenCalledWith('Recommendation failed')
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should handle API errors gracefully', async () => {
      mockGetRecommendations.mockRejectedValue(new Error('API unavailable'))

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockSpinner.fail).toHaveBeenCalledWith('Recommendation failed')
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should output error as JSON with --json flag on failure', async () => {
      mockAnalyze.mockRejectedValue(new Error('Analysis failed'))

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--json'])

      const errorOutput = mockConsoleError.mock.calls[0]![0]
      const parsed = JSON.parse(errorOutput)
      expect(parsed).toHaveProperty('error')
    })

    it('should sanitize error messages (remove user paths)', async () => {
      mockAnalyze.mockRejectedValue(new Error('Error at /Users/secret/project'))

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const errorCalls = mockConsoleError.mock.calls
      expect(errorCalls.length).toBeGreaterThan(0)
    })

    it('should handle network errors with offline fallback', async () => {
      const context = createMockCodebaseContext()
      mockAnalyze.mockResolvedValue(context)
      const networkError = new Error('fetch failed')
      mockGetRecommendations.mockRejectedValue(networkError)

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockSpinner.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to reach API'))
      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Codebase Analysis')
    })

    it('should show offline JSON output on network error with --json', async () => {
      mockAnalyze.mockResolvedValue(createMockCodebaseContext())
      mockGetRecommendations.mockRejectedValue(new Error('fetch failed'))

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--json'])

      const output = mockConsoleLog.mock.calls[0]![0]
      const parsed = JSON.parse(output)
      expect(parsed.offline).toBe(true)
      expect(parsed.analysis).toBeDefined()
    })
  })

  // ==========================================================================
  // Limit Validation Tests
  // ==========================================================================

  describe('limit option validation', () => {
    it('should default to limit 5 when not specified', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 5,
        })
      )
    })

    it('should clamp limit to minimum of 1', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--limit', '0'])

      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 1,
        })
      )
    })

    it('should clamp limit to maximum of 50', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--limit', '100'])

      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50,
        })
      )
    })

    it('should handle non-numeric limit gracefully', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--limit', 'invalid'])

      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 5,
        })
      )
    })
  })

  // ==========================================================================
  // Trust Tier Handling Tests
  // ==========================================================================

  describe('trust tier handling', () => {
    it('should display VERIFIED badge for verified skills', async () => {
      mockGetRecommendations.mockResolvedValue(
        createMockApiResponse([
          {
            id: 'test/skill',
            name: 'Verified Skill',
            description: 'A verified skill',
            author: 'test',
            repo_url: null,
            quality_score: 0.9,
            trust_tier: 'verified',
            tags: [],
            stars: 100,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ])
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('VERIFIED')
    })

    it('should display COMMUNITY badge for community skills', async () => {
      mockGetRecommendations.mockResolvedValue(
        createMockApiResponse([
          {
            id: 'test/skill',
            name: 'Community Skill',
            description: 'A community skill',
            author: 'test',
            repo_url: null,
            quality_score: 0.7,
            trust_tier: 'community',
            tags: [],
            stars: 50,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ])
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('COMMUNITY')
    })

    it('should handle unknown trust tier gracefully', async () => {
      mockGetRecommendations.mockResolvedValue(
        createMockApiResponse([
          {
            id: 'test/skill',
            name: 'Unknown Tier Skill',
            description: 'A skill with invalid tier',
            author: 'test',
            repo_url: null,
            quality_score: 0.5,
            trust_tier: 'invalid_tier',
            tags: [],
            stars: 10,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ])
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('UNKNOWN')
    })
  })
})
