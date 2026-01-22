/**
 * SMI-824: Install Skillsmith Skill Command Tests
 *
 * Tests for the install-skill command that copies bundled skillsmith skill
 * assets to ~/.claude/skills/skillsmith/ for /skillsmith slash command support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { join } from 'path'
import { homedir } from 'os'

// ============================================================================
// Mock Setup - Must be before imports
// ============================================================================

// Create a mocks container that survives hoisting
const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  spinner: {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  },
}))

vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mocks.mkdir(...args),
  copyFile: (...args: unknown[]) => mocks.copyFile(...args),
  stat: (...args: unknown[]) => mocks.stat(...args),
  readdir: (...args: unknown[]) => mocks.readdir(...args),
}))

vi.mock('ora', () => ({
  default: () => mocks.spinner,
}))

// Convenience aliases
const mockMkdir = mocks.mkdir
const mockCopyFile = mocks.copyFile
const mockStat = mocks.stat
const mockReaddir = mocks.readdir
const mockSpinner = mocks.spinner

// Mock console.log/error for output verification
const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()

// Mock process.exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

// ============================================================================
// Test Fixtures
// ============================================================================

// Target path used in assertions
const EXPECTED_TARGET_PATH = join(homedir(), '.claude', 'skills', 'skillsmith')
void EXPECTED_TARGET_PATH // Used in tests below via mockMkdir assertions

/**
 * Create a mock directory entry for readdir
 */
function createDirEntry(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  }
}

/**
 * Set up mocks for a successful installation scenario
 */
function setupSuccessfulInstall() {
  // Assets directory exists
  mockStat.mockImplementation(async (path: string) => {
    if (path.includes('assets/skillsmith-skill') || path.includes('assets\\skillsmith-skill')) {
      return { isDirectory: () => true }
    }
    // Target directory does not exist
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })

  // Assets directory has files
  mockReaddir.mockResolvedValue([createDirEntry('SKILL.md', false)])

  // mkdir and copyFile succeed
  mockMkdir.mockResolvedValue(undefined)
  mockCopyFile.mockResolvedValue(undefined)
}

/**
 * Set up mocks for existing installation scenario
 */
function setupExistingInstall() {
  mockStat.mockImplementation(async (_path: string) => {
    // Both assets and target exist
    return { isDirectory: () => true }
  })

  mockReaddir.mockResolvedValue([createDirEntry('SKILL.md', false)])

  mockMkdir.mockResolvedValue(undefined)
  mockCopyFile.mockResolvedValue(undefined)
}

// ============================================================================
// Tests
// ============================================================================

describe('SMI-824: Install Skillsmith Skill Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    console.error = mockConsoleError
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
  })

  // ==========================================================================
  // Command Registration Tests
  // ==========================================================================

  describe('command registration', () => {
    it('should create a Command instance named "install-skill"', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('install-skill')
    })

    it('should have a description mentioning skillsmith skill', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      const description = cmd.description()
      expect(description.toLowerCase()).toContain('skillsmith')
      expect(description.toLowerCase()).toContain('skill')
    })

    it('should have --force option with short flag -f', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      const forceOpt = cmd.options.find((o) => o.short === '-f')
      expect(forceOpt).toBeDefined()
      expect(forceOpt?.long).toBe('--force')
    })

    it('should export as default', async () => {
      const mod = await import('../src/commands/install-skill.js')
      expect(mod.default).toBeDefined()
      expect(typeof mod.default).toBe('function')
    })
  })

  // ==========================================================================
  // Successful Installation Tests
  // ==========================================================================

  describe('successful installation', () => {
    beforeEach(() => {
      setupSuccessfulInstall()
    })

    it('should create target directory with recursive option', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      // Should create parent directories
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('.claude'),
        expect.objectContaining({ recursive: true })
      )
    })

    it('should copy files from assets to target directory', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      expect(mockCopyFile).toHaveBeenCalled()
    })

    it('should show spinner during installation', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      // ora() is called with text, then .start() is called without args
      expect(mockSpinner.start).toHaveBeenCalled()
    })

    it('should show success message after installation', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      expect(mockSpinner.succeed).toHaveBeenCalledWith(
        expect.stringContaining('installed successfully')
      )
    })

    it('should display available commands after installation', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Available Commands')
      expect(output).toContain('/skillsmith search')
      expect(output).toContain('/skillsmith install')
      expect(output).toContain('/skillsmith recommend')
    })

    it('should display installation location', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Location')
    })

    it('should display files copied count', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Files copied')
    })
  })

  // ==========================================================================
  // Existing Installation Tests
  // ==========================================================================

  describe('existing installation', () => {
    beforeEach(() => {
      setupExistingInstall()
    })

    it('should show already installed message without --force', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('already installed')
    })

    it('should suggest using --force when already installed', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('--force')
    })

    it('should not copy files when already installed without --force', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      // Spinner should not have been started for already installed case
      expect(mockSpinner.start).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Force Flag Tests
  // ==========================================================================

  describe('--force flag', () => {
    beforeEach(() => {
      setupExistingInstall()
    })

    it('should reinstall when --force is provided', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test', '--force'])

      // ora() is called with text, then .start() is called without args
      expect(mockSpinner.start).toHaveBeenCalled()
      expect(mockCopyFile).toHaveBeenCalled()
    })

    it('should show success message when reinstalling with --force', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test', '-f'])

      expect(mockSpinner.succeed).toHaveBeenCalledWith(
        expect.stringContaining('installed successfully')
      )
    })

    it('should accept -f short flag', async () => {
      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test', '-f'])

      expect(mockSpinner.start).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('error handling', () => {
    it('should fail when assets directory not found', async () => {
      mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      expect(mockConsoleError).toHaveBeenCalled()
      const errorOutput = mockConsoleError.mock.calls
        .map((c) => String(c[0] || '') + String(c[1] || ''))
        .join(' ')
      expect(errorOutput.toLowerCase()).toContain('error')
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should fail spinner when copy fails', async () => {
      setupSuccessfulInstall()
      mockCopyFile.mockRejectedValue(new Error('Permission denied'))

      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      expect(mockSpinner.fail).toHaveBeenCalledWith('Failed to install skillsmith skill')
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should fail spinner when mkdir fails', async () => {
      setupSuccessfulInstall()
      mockMkdir.mockRejectedValue(new Error('Cannot create directory'))

      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      expect(mockSpinner.fail).toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should sanitize error messages containing user paths', async () => {
      setupSuccessfulInstall()
      mockCopyFile.mockRejectedValue(new Error(`Error at ${homedir()}/secret/path`))

      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      // Error should be logged but with sanitized paths
      expect(mockConsoleError).toHaveBeenCalled()
      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join(' ')
      // The sanitizeError function replaces home paths with ~
      expect(errorOutput).not.toContain(homedir())
    })
  })

  // ==========================================================================
  // Recursive Directory Copy Tests
  // ==========================================================================

  describe('recursive directory copy', () => {
    it('should copy nested directories recursively', async () => {
      // Assets directory exists
      mockStat.mockImplementation(async (path: string) => {
        if (path.includes('assets/skillsmith-skill') || path.includes('assets\\skillsmith-skill')) {
          return { isDirectory: () => true }
        }
        // Target directory does not exist
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      // Assets have nested structure
      mockReaddir.mockImplementation(async (path: string) => {
        if (path.includes('subdir')) {
          return [createDirEntry('nested-file.md', false)]
        }
        return [createDirEntry('SKILL.md', false), createDirEntry('subdir', true)]
      })

      mockMkdir.mockResolvedValue(undefined)
      mockCopyFile.mockResolvedValue(undefined)

      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      // Should have copied multiple files
      expect(mockCopyFile).toHaveBeenCalledTimes(2) // SKILL.md and nested-file.md
      // Should have created subdirectory
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('subdir'),
        expect.objectContaining({ recursive: true })
      )
    })

    it('should count all copied files correctly', async () => {
      // Assets directory exists
      mockStat.mockImplementation(async (path: string) => {
        if (path.includes('assets/skillsmith-skill') || path.includes('assets\\skillsmith-skill')) {
          return { isDirectory: () => true }
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      // Multiple files in assets
      mockReaddir.mockResolvedValue([
        createDirEntry('SKILL.md', false),
        createDirEntry('README.md', false),
        createDirEntry('config.json', false),
      ])

      mockMkdir.mockResolvedValue(undefined)
      mockCopyFile.mockResolvedValue(undefined)

      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Files copied: 3')
    })
  })

  // ==========================================================================
  // Target Path Tests
  // ==========================================================================

  describe('target path', () => {
    it('should install to ~/.claude/skills/skillsmith/', async () => {
      setupSuccessfulInstall()

      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      // mkdir should be called with the correct target path
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining(join('.claude', 'skills', 'skillsmith')),
        expect.any(Object)
      )
    })

    it('should display correct target path in output', async () => {
      setupSuccessfulInstall()

      const { createInstallSkillCommand } = await import('../src/commands/install-skill.js')
      const cmd = createInstallSkillCommand()

      await cmd.parseAsync(['node', 'test'])

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('.claude')
      expect(output).toContain('skills')
      expect(output).toContain('skillsmith')
    })
  })
})
