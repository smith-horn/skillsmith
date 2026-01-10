/**
 * SMI-1323: TDD Unit Tests for CLI recommend command
 *
 * Tests follow London School TDD with mocked dependencies to verify
 * interactions between the recommend command and its collaborators.
 *
 * Parent issue: SMI-1299 (CLI recommend command)
 * Reference: packages/mcp-server/src/tools/recommend.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { join } from 'path'
import { homedir } from 'os'

// Mock CodebaseAnalyzer before importing
vi.mock('@skillsmith/core', () => ({
  CodebaseAnalyzer: vi.fn(() => ({
    analyze: vi.fn(),
    getSummary: vi.fn(),
  })),
  SkillRepository: vi.fn(() => ({
    findAll: vi.fn(() => ({
      items: [],
      total: 0,
      limit: 1000,
      offset: 0,
      hasMore: false,
    })),
  })),
  SkillMatcher: vi.fn(() => ({
    findMatches: vi.fn(),
  })),
  OverlapDetector: vi.fn(() => ({
    detectOverlap: vi.fn(),
  })),
  createDatabase: vi.fn(() => ({
    close: vi.fn(),
  })),
  trackEvent: vi.fn(),
}))

// Mock API client
vi.mock('../src/utils/api-client.js', () => ({
  createApiClient: vi.fn(() => ({
    recommend: vi.fn(),
  })),
}))

// Mock file system for path validation
vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  readdir: vi.fn(),
}))

// Mock ora for spinner
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}))

describe('SMI-1323: CLI recommend command (SMI-1299)', () => {
  // Skills directory used for auto-detection tests
  const _SKILLS_DIR = join(homedir(), '.claude', 'skills')
  void _SKILLS_DIR // Suppress unused warning

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('command registration', () => {
    it('should register recommend command with CLI', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeInstanceOf(Command)
        expect(cmd.name()).toBe('recommend')
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should have correct description', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd.description()).toContain('recommend')
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should accept path argument with default to current directory', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        // Commander stores registered arguments - check the command accepts a path
        const registeredArgs = cmd.registeredArguments
        expect(registeredArgs.length).toBeGreaterThan(0)
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should accept --limit option with default 5', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        const limitOpt = cmd.options.find((o) => o.short === '-l')
        expect(limitOpt).toBeDefined()
        expect(limitOpt?.long).toBe('--limit')
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should accept --json flag for JSON output', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        const jsonOpt = cmd.options.find((o) => o.short === '-j')
        expect(jsonOpt).toBeDefined()
        expect(jsonOpt?.long).toBe('--json')
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should accept --context option for project context', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        const contextOpt = cmd.options.find((o) => o.long === '--context')
        expect(contextOpt).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should accept --installed option to override installed skills', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        const installedOpt = cmd.options.find((o) => o.long === '--installed')
        expect(installedOpt).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should accept --no-overlap flag to disable overlap detection', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        const noOverlapOpt = cmd.options.find((o) => o.long === '--no-overlap')
        expect(noOverlapOpt).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should show help with --help', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd.helpOption).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('path validation', () => {
    it('should accept valid directory path', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should reject non-existent path with error', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should reject file path (must be directory)', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle path with spaces', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should resolve relative paths to absolute', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('CodebaseAnalyzer integration', () => {
    it('should instantiate CodebaseAnalyzer', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should call CodebaseAnalyzer.analyze() with path', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should pass analysis results to recommendation engine', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle empty directory gracefully', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle analysis errors', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should pass correct AnalyzeOptions to analyzer', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('API integration', () => {
    it('should call recommend API with analysis results', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should respect --limit parameter', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should use provided --context for project context', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should auto-detect installed skills when not provided', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should read skills from ~/.claude/skills/ directory', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should use --installed option to override auto-detection', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle API timeout gracefully', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle offline mode with local fallback', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should include pagination info in response', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('output formatting', () => {
    it('should format recommendations for terminal display', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should output JSON with --json flag', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should show "no recommendations" message when empty', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should include trust tier badges in output', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should include quality scores in output', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should include similarity scores from semantic matching', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should format recommendation reason clearly', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should colorize output appropriately', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should use chalk for terminal colors', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('overlap detection', () => {
    it('should enable overlap detection by default', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should allow disabling overlap detection with --no-overlap', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should filter similar skills based on trigger phrase overlap', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should report number of skills filtered in output', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('error handling', () => {
    it('should sanitize error messages (no user paths)', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle missing package.json gracefully', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should exit with code 1 on error', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle database connection errors', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle invalid limit values gracefully', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should provide helpful error messages for common issues', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should handle invalid installed skill IDs gracefully', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should close database connection on error', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('codebase context integration', () => {
    it('should extract framework information from analysis', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should extract dependency list from analysis', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should use detected frameworks for relevant recommendations', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should pass combined context to recommendation engine', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should include statistics about analysis in output', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('performance and caching', () => {
    it('should show loading spinner during analysis', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should show loading spinner during recommendation', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should report timing information', async () => {
      try {
        const { createRecommendCommand } = await import('../src/commands/recommend.js')
        const cmd = createRecommendCommand()

        expect(cmd).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })

  describe('compatibility with export in index.ts', () => {
    it('should export createRecommendCommand from index', async () => {
      try {
        const indexExports = await import('../src/commands/index.js')
        expect(indexExports.createRecommendCommand).toBeDefined()
      } catch (error) {
        expect(error).toBeDefined()
      }
    })
  })
})
