/**
 * SMI-1353: CLI recommend command — stack building, role-based filtering,
 * module exports.
 *
 * Sibling of recommend.test.ts and recommend.errors.test.ts; see those files
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

const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()

vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

describe('SMI-1353: CLI recommend command — stack / role filter / exports', () => {
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
  // Stack Building Tests
  // ==========================================================================

  describe('stack building from analysis', () => {
    it('should include framework names in stack (lowercase)', async () => {
      mockAnalyze.mockResolvedValue(
        createMockCodebaseContext({
          frameworks: [
            { name: 'Next.js', confidence: 0.9, source: 'dep', detectedFrom: [] },
            { name: 'TailwindCSS', confidence: 0.85, source: 'dep', detectedFrom: [] },
          ],
          dependencies: [{ name: 'next', version: '^14.0.0', isDev: false }],
        })
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: expect.arrayContaining(['next.js', 'tailwindcss']),
        })
      )
    })

    it('should include non-dev dependencies in stack', async () => {
      mockAnalyze.mockResolvedValue(
        createMockCodebaseContext({
          frameworks: [{ name: 'Express', confidence: 0.9, source: 'dep', detectedFrom: [] }],
          dependencies: [
            { name: 'express', version: '^4.0.0', isDev: false },
            { name: 'mongoose', version: '^7.0.0', isDev: false },
          ],
        })
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: expect.arrayContaining(['express', 'mongoose']),
        })
      )
    })

    it('should exclude dev dependencies from stack', async () => {
      mockAnalyze.mockResolvedValue(
        createMockCodebaseContext({
          frameworks: [{ name: 'React', confidence: 0.9, source: 'dep', detectedFrom: [] }],
          dependencies: [
            { name: 'react', version: '^18.0.0', isDev: false },
            { name: 'jest', version: '^29.0.0', isDev: true },
            { name: 'eslint', version: '^8.0.0', isDev: true },
          ],
        })
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const call = mockGetRecommendations.mock.calls[0]![0]
      expect(call.stack).not.toContain('jest')
      expect(call.stack).not.toContain('eslint')
      expect(call.stack).toContain('react')
    })

    it('should limit stack to 10 items', async () => {
      mockAnalyze.mockResolvedValue(
        createMockCodebaseContext({
          frameworks: Array.from({ length: 6 }, (_, i) => ({
            name: `Framework${i}`,
            confidence: 0.9,
            source: 'dep',
            detectedFrom: [],
          })),
          dependencies: Array.from({ length: 12 }, (_, i) => ({
            name: `dep${i}`,
            version: '^1.0.0',
            isDev: false,
          })),
        })
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const call = mockGetRecommendations.mock.calls[0]![0]
      expect(call.stack.length).toBeLessThanOrEqual(10)
    })

    it('should deduplicate stack items', async () => {
      mockAnalyze.mockResolvedValue(
        createMockCodebaseContext({
          frameworks: [{ name: 'React', confidence: 0.9, source: 'dep', detectedFrom: [] }],
          dependencies: [{ name: 'react', version: '^18.0.0', isDev: false }],
        })
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const call = mockGetRecommendations.mock.calls[0]![0]
      const reactCount = call.stack.filter((s: string) => s === 'react').length
      expect(reactCount).toBe(1)
    })
  })

  // ==========================================================================
  // SMI-1631: Role-Based Filtering Tests
  // ==========================================================================

  describe('role-based filtering', () => {
    it('should apply role filtering locally', async () => {
      mockGetRecommendations.mockResolvedValue(
        createMockApiResponse([
          {
            id: 'test/test-helper',
            name: 'Test Helper',
            description: 'Testing utilities',
            author: 'test',
            repo_url: null,
            quality_score: 0.8,
            trust_tier: 'verified',
            tags: ['testing', 'jest', 'unit-test'],
            stars: 100,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ])
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--role', 'testing', '--json'])

      const output = mockConsoleLog.mock.calls[0]![0]
      const parsed = JSON.parse(output)
      expect(parsed.meta.role_filter).toBe('testing')
    })

    it('should not set role filter for invalid role', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--role', 'invalid-role', '--json'])

      const output = mockConsoleLog.mock.calls[0]![0]
      const parsed = JSON.parse(output)
      expect(parsed.meta.role_filter).toBeNull()
    })

    it('should warn user about invalid role', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--role', 'not-a-role'])

      const errorOutput = mockConsoleError.mock.calls.map((c) => c[0]).join('\n')
      expect(errorOutput).toContain('Invalid role')
      expect(errorOutput).toContain('not-a-role')
    })

    it('should accept all valid role values', async () => {
      const validRoles = [
        'code-quality',
        'testing',
        'documentation',
        'workflow',
        'security',
        'development-partner',
      ]

      for (const role of validRoles) {
        vi.clearAllMocks()
        mockAnalyze.mockResolvedValue(createMockCodebaseContext())
        mockGetRecommendations.mockResolvedValue(createMockApiResponse())

        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        await cmd.parseAsync(['node', 'test', '.', '-r', role, '--json'])

        const output = mockConsoleLog.mock.calls[0]![0]
        const parsed = JSON.parse(output)
        expect(parsed.meta.role_filter).toBe(role)
      }
    })

    it('should include role_filter in JSON output when specified', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--role', 'security', '--json'])

      const output = mockConsoleLog.mock.calls[0]![0]
      const parsed = JSON.parse(output)
      expect(parsed.meta.role_filter).toBe('security')
    })
  })

  // ==========================================================================
  // Export Tests
  // ==========================================================================

  describe('module exports', () => {
    it('should export createRecommendCommand from commands/index', async () => {
      const indexExports = await import('../src/commands/index.js')
      expect(indexExports.createRecommendCommand).toBeDefined()
      expect(typeof indexExports.createRecommendCommand).toBe('function')
    })

    it('should export createRecommendCommand as default', async () => {
      const mod = await import('../src/commands/recommend.js')
      expect(mod.default).toBeDefined()
      expect(typeof mod.default).toBe('function')
    })
  })
})
