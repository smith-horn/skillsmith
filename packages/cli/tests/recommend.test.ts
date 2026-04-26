/**
 * SMI-1353: CLI recommend command — registration + analyzer + API + output.
 *
 * Split from the original 1012-line file into three sibling files (this one,
 * recommend.errors.test.ts, recommend.filters.test.ts) so each stays under
 * the 500-line standard. Shared mocks/fixtures live in recommend.test-helpers.
 *
 * Parent issue: SMI-1299 (CLI recommend command)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
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
  // SMI-4474: command imports loadStoredAccessToken for JWT auto-load. Tests
  // don't exercise the JWT path, so a stub returning null is sufficient — the
  // command falls through to the createApiClient mock above.
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

vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

describe('SMI-1353: CLI recommend command', () => {
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
  // Command Registration Tests
  // ==========================================================================

  describe('command registration', () => {
    it('should create a Command instance named "recommend"', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('recommend')
    })

    it('should have a description mentioning codebase analysis', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const description = cmd.description()
      expect(description.toLowerCase()).toContain('analyze')
      expect(description.toLowerCase()).toContain('recommend')
    })

    it('should accept optional path argument with default "."', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const args = cmd.registeredArguments
      expect(args.length).toBeGreaterThan(0)
      expect(args[0]!.name()).toBe('path')
      expect(args[0]!.defaultValue).toBe('.')
    })

    it('should have --limit option with short flag -l', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const limitOpt = cmd.options.find((o) => o.short === '-l')
      expect(limitOpt).toBeDefined()
      expect(limitOpt?.long).toBe('--limit')
    })

    it('should have --json option with short flag -j', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const jsonOpt = cmd.options.find((o) => o.short === '-j')
      expect(jsonOpt).toBeDefined()
      expect(jsonOpt?.long).toBe('--json')
    })

    it('should have --context option with short flag -c', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const contextOpt = cmd.options.find((o) => o.short === '-c')
      expect(contextOpt).toBeDefined()
      expect(contextOpt?.long).toBe('--context')
    })

    it('should have --installed option with short flag -i', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const installedOpt = cmd.options.find((o) => o.short === '-i')
      expect(installedOpt).toBeDefined()
      expect(installedOpt?.long).toBe('--installed')
    })

    it('should have --no-overlap option for disabling overlap detection', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const noOverlapOpt = cmd.options.find((o) => o.long === '--no-overlap')
      expect(noOverlapOpt).toBeDefined()
    })

    it('should have --max-files option with short flag -m', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const maxFilesOpt = cmd.options.find((o) => o.short === '-m')
      expect(maxFilesOpt).toBeDefined()
      expect(maxFilesOpt?.long).toBe('--max-files')
    })

    // SMI-1631: Role option tests
    it('should have --role option with short flag -r', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      const roleOpt = cmd.options.find((o) => o.short === '-r')
      expect(roleOpt).toBeDefined()
      expect(roleOpt?.long).toBe('--role')
    })
  })

  // ==========================================================================
  // CodebaseAnalyzer Integration Tests
  // ==========================================================================

  describe('CodebaseAnalyzer integration', () => {
    it('should call CodebaseAnalyzer.analyze() with provided path', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '/my/project'])

      expect(mockAnalyze).toHaveBeenCalledTimes(1)
      expect(mockAnalyze).toHaveBeenCalledWith('/my/project', expect.any(Object))
    })

    it('should use current directory when no path provided', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test'])

      expect(mockAnalyze).toHaveBeenCalledWith('.', expect.any(Object))
    })

    it('should pass maxFiles option to analyzer', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '-m', '500'])

      expect(mockAnalyze).toHaveBeenCalledWith(
        '.',
        expect.objectContaining({
          includeDevDeps: true,
        })
      )
    })

    it('should pass includeDevDeps: true to analyzer', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockAnalyze).toHaveBeenCalledWith(
        '.',
        expect.objectContaining({
          includeDevDeps: true,
        })
      )
    })

    it('should show spinner during analysis', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockSpinner.start).toHaveBeenCalledWith('Analyzing codebase...')
    })

    it('should show success message after analysis with file count', async () => {
      mockAnalyze.mockResolvedValue(
        createMockCodebaseContext({
          stats: { totalFiles: 100, filesByExtension: {}, totalLines: 10000 },
          frameworks: [{ name: 'React', confidence: 0.9, source: 'dep', detectedFrom: [] }],
        })
      )

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockSpinner.succeed).toHaveBeenCalledWith(
        expect.stringMatching(/Analyzed 100 files.*1 framework/)
      )
    })
  })

  // ==========================================================================
  // API Integration Tests
  // ==========================================================================

  describe('API integration', () => {
    it('should call getRecommendations with stack from analysis', async () => {
      const context = createMockCodebaseContext({
        frameworks: [{ name: 'React', confidence: 0.95, source: 'dep', detectedFrom: [] }],
        dependencies: [{ name: 'lodash', version: '^4.0.0', isDev: false }],
      })
      mockAnalyze.mockResolvedValue(context)

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockGetRecommendations).toHaveBeenCalledTimes(1)
      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: expect.arrayContaining(['react', 'lodash']),
        })
      )
    })

    it('should respect --limit option in API call', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--limit', '10'])

      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
        })
      )
    })

    it('should include --context text in stack', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--context', 'testing utilities'])

      expect(mockGetRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: expect.arrayContaining(['testing', 'utilities']),
        })
      )
    })

    it('should filter context words shorter than 4 characters', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--context', 'a be api testing'])

      const call = mockGetRecommendations.mock.calls[0]![0]
      expect(call.stack).not.toContain('a')
      expect(call.stack).not.toContain('be')
      expect(call.stack).toContain('testing')
    })

    it('should show spinner during recommendation fetch', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockSpinner.start).toHaveBeenCalledWith('Finding skill recommendations...')
    })

    it('should show success message with recommendation count', async () => {
      mockGetRecommendations.mockResolvedValue(createMockApiResponse())

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockSpinner.succeed).toHaveBeenCalledWith('Found 2 recommendations')
    })
  })

  // ==========================================================================
  // Output Formatting Tests
  // ==========================================================================

  describe('output formatting', () => {
    it('should output terminal format by default', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      expect(mockConsoleLog).toHaveBeenCalled()
      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Skill Recommendations')
    })

    it('should include skill names in terminal output', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Jest Helper')
      expect(output).toContain('React Tools')
    })

    it('should output valid JSON with --json flag', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--json'])

      const output = mockConsoleLog.mock.calls[0]![0]
      const parsed = JSON.parse(output)
      expect(parsed).toHaveProperty('recommendations')
      expect(parsed).toHaveProperty('meta')
    })

    it('should include analysis info in JSON output', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.', '--json'])

      const output = mockConsoleLog.mock.calls[0]![0]
      const parsed = JSON.parse(output)
      expect(parsed.analysis).toHaveProperty('frameworks')
      expect(parsed.analysis).toHaveProperty('dependencies')
      expect(parsed.analysis).toHaveProperty('stats')
    })

    it('should show "no recommendations" message when empty', async () => {
      mockGetRecommendations.mockResolvedValue({ data: [], meta: {} })

      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output.toLowerCase()).toContain('no recommendations')
    })

    it('should include detected frameworks in terminal output', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('React')
    })

    it('should show timing information in terminal output', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toMatch(/\d+ms/)
    })

    it('should include skill IDs in terminal output', async () => {
      const { createRecommendCommand } = await import('../src/commands/recommend.js')
      const cmd = createRecommendCommand()

      await cmd.parseAsync(['node', 'test', '.'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('anthropic/jest-helper')
    })
  })
})
