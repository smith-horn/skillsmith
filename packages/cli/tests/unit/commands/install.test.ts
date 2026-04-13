/**
 * SMI-3484: CLI Install Command Tests (Wave 1)
 *
 * Tests for the install command that installs skills from registry/GitHub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ============================================================================
// Mock Setup - Must be before imports
// ============================================================================

const mocks = vi.hoisted(() => ({
  spinner: {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  },
  installFn: vi.fn(),
  createDatabaseAsync: vi.fn(),
  initializeSchema: vi.fn(),
  dbClose: vi.fn(),
}))

vi.mock('ora', () => ({
  default: () => mocks.spinner,
}))

vi.mock('@skillsmith/core', () => ({
  createDatabaseAsync: (...args: unknown[]) => mocks.createDatabaseAsync(...args),
  initializeSchema: (...args: unknown[]) => mocks.initializeSchema(...args),
  SkillRepository: vi.fn().mockImplementation(function () {
    return {
      findById: vi.fn(() => null),
      findAll: vi.fn(() => ({ items: [], total: 0, limit: 1000, offset: 0, hasMore: false })),
    }
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return {
      clearAll: vi.fn(),
    }
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return {
      install: mocks.installFn,
    }
  }),
  isGitHubUrl: vi.fn((url: string) => url.startsWith('https://github.com/')),
  emitInstallEvent: vi.fn(async () => undefined),
}))

// Mock console and process.exit
const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

// ============================================================================
// Tests
// ============================================================================

describe('SMI-3484: CLI Install Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    console.error = mockConsoleError

    // Default: database opens and closes successfully
    const mockDb = { close: mocks.dbClose }
    mocks.createDatabaseAsync.mockResolvedValue(mockDb)

    // Default: install succeeds
    mocks.installFn.mockResolvedValue({
      success: true,
      skillId: 'community/jest-helper',
      installPath: '/tmp/.claude/skills/jest-helper',
      trustTier: 'community',
    })
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
  })

  // ==========================================================================
  // Command Registration
  // ==========================================================================

  describe('command registration', () => {
    it('should create a Command instance named "install"', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('install')
    })

    it('should have a description mentioning install', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      expect(cmd.description().toLowerCase()).toContain('install')
    })

    it('should have --force option with short flag -f', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const forceOpt = cmd.options.find((o) => o.short === '-f')
      expect(forceOpt).toBeDefined()
      expect(forceOpt?.long).toBe('--force')
    })

    it('should have --skip-scan option', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.long === '--skip-scan')
      expect(opt).toBeDefined()
    })

    it('should have --skip-optimize option', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.long === '--skip-optimize')
      expect(opt).toBeDefined()
    })

    it('should have --quiet option with short flag -q', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.short === '-q')
      expect(opt).toBeDefined()
      expect(opt?.long).toBe('--quiet')
    })

    it('should have --json option', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.long === '--json')
      expect(opt).toBeDefined()
    })

    it('should have --db option with short flag -d', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.short === '-d')
      expect(opt).toBeDefined()
      expect(opt?.long).toBe('--db')
    })

    it('should require a skillId argument', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.required).toBe(true)
    })
  })

  // ==========================================================================
  // Argument Parsing
  // ==========================================================================

  describe('argument parsing', () => {
    it('should accept valid author/name format', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.installFn).toHaveBeenCalledWith('community/jest-helper', expect.any(Object))
    })

    it('should accept GitHub URL', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const url = 'https://github.com/owner/repo'
      await cmd.parseAsync(['node', 'test', url])

      expect(mocks.installFn).toHaveBeenCalledWith(url, expect.any(Object))
    })

    it('should reject bare name without author prefix', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'jest-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('should reject invalid format with multiple slashes', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'a/b/c'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('should reject empty author segment', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', '/name'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.installFn).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Happy Path
  // ==========================================================================

  describe('happy path', () => {
    it('should install a skill and show success', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.spinner.succeed).toHaveBeenCalledWith('Skill installed')
      expect(mocks.dbClose).toHaveBeenCalled()
    })

    it('should pass --force option to install service', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--force'])

      expect(mocks.installFn).toHaveBeenCalledWith(
        'community/jest-helper',
        expect.objectContaining({ force: true })
      )
    })

    it('should pass --skip-scan option to install service', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--skip-scan'])

      expect(mocks.installFn).toHaveBeenCalledWith(
        'community/jest-helper',
        expect.objectContaining({ skipScan: true })
      )
    })

    it('should pass --skip-optimize option to install service', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--skip-optimize'])

      expect(mocks.installFn).toHaveBeenCalledWith(
        'community/jest-helper',
        expect.objectContaining({ skipOptimize: true })
      )
    })

    it('should close database after successful install', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.dbClose).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Already Installed
  // ==========================================================================

  describe('already installed', () => {
    it('should fail when skill is already installed', async () => {
      mocks.installFn.mockResolvedValue({
        success: false,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
        error: 'Skill "jest-helper" is already installed. Use force=true to reinstall.',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.spinner.fail).toHaveBeenCalledWith('Installation failed')
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should succeed with --force when already installed', async () => {
      mocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--force'])

      expect(mocks.installFn).toHaveBeenCalledWith(
        'community/jest-helper',
        expect.objectContaining({ force: true })
      )
      expect(mocks.spinner.succeed).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // --quiet Flag
  // ==========================================================================

  describe('--quiet flag', () => {
    it('should suppress advisory output when --quiet is set', async () => {
      mocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
        tips: ['Tip: Use the skill by invoking /jest-helper'],
        optimization: {
          optimized: true,
          tokenReductionPercent: 30,
          subSkills: ['sub1.md'],
        },
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--quiet'])

      // Tips and optimization info should be suppressed
      const allOutput = mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allOutput).not.toContain('Tip:')
      expect(allOutput).not.toContain('reduction')
    })

    it('should still show security-critical errors when --quiet is set', async () => {
      mocks.installFn.mockResolvedValue({
        success: false,
        skillId: 'community/dangerous-skill',
        installPath: '',
        error: 'Security scan failed with 2 critical/high findings',
        securityReport: {
          passed: false,
          riskScore: 85,
          findings: [{ severity: 'critical', message: 'Dangerous command execution detected' }],
        },
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/dangerous-skill', '--quiet'])

      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(errorOutput).toContain('Security scan failed')
    })
  })

  // ==========================================================================
  // --json Flag
  // ==========================================================================

  describe('--json flag', () => {
    it('should output structured JSON on success', async () => {
      mocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
        trustTier: 'community',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--json'])

      // Find the JSON output call
      const jsonCalls = mockConsoleLog.mock.calls.filter((c) => {
        try {
          JSON.parse(c[0])
          return true
        } catch {
          return false
        }
      })

      expect(jsonCalls.length).toBeGreaterThan(0)
      const parsed = JSON.parse(jsonCalls[0]![0])
      expect(parsed.success).toBe(true)
      expect(parsed.skillId).toBe('community/jest-helper')
      expect(parsed.installPath).toBe('/tmp/.claude/skills/jest-helper')
    })

    it('should output structured JSON on failure', async () => {
      mocks.installFn.mockResolvedValue({
        success: false,
        skillId: 'community/missing',
        installPath: '',
        error: 'Skill not found',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/missing', '--json'])

      const jsonCalls = mockConsoleLog.mock.calls.filter((c) => {
        try {
          JSON.parse(c[0])
          return true
        } catch {
          return false
        }
      })

      expect(jsonCalls.length).toBeGreaterThan(0)
      const parsed = JSON.parse(jsonCalls[0]![0])
      expect(parsed.success).toBe(false)
      expect(parsed.error).toBe('Skill not found')
    })

    it('should output JSON for invalid format errors', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'invalid', '--json'])

      const jsonCalls = mockConsoleLog.mock.calls.filter((c) => {
        try {
          JSON.parse(c[0])
          return true
        } catch {
          return false
        }
      })

      expect(jsonCalls.length).toBeGreaterThan(0)
      const parsed = JSON.parse(jsonCalls[0]![0])
      expect(parsed.success).toBe(false)
      expect(parsed.error).toContain('Invalid skill ID format')
    })

    it('should not show spinner when --json is set', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--json'])

      // Spinner should not be started in JSON mode
      expect(mocks.spinner.start).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('error handling', () => {
    it('should exit with code 1 on install failure', async () => {
      mocks.installFn.mockResolvedValue({
        success: false,
        skillId: 'community/missing',
        installPath: '',
        error: 'Skill not found',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/missing'])

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should handle database connection errors', async () => {
      mocks.createDatabaseAsync.mockRejectedValue(new Error('Database locked'))

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should sanitize error messages', async () => {
      mocks.createDatabaseAsync.mockRejectedValue(new Error('Error at /Users/testuser/secret/path'))

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join(' ')
      expect(errorOutput).not.toContain('/Users/testuser/')
    })

    it('should close database even on error', async () => {
      mocks.installFn.mockRejectedValue(new Error('Unexpected error'))

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.dbClose).toHaveBeenCalled()
    })
  })
})
