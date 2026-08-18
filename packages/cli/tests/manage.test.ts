/**
 * SMI-745: Skill Management Commands Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { join } from 'path'
import { homedir } from 'os'

// Mock file system
vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}))

// Mock inquirer
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}))

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}))

// Hoisted mock state for SkillInstallationService
const mocks = vi.hoisted(() => ({
  uninstallFn: vi.fn(),
  dbClose: vi.fn(),
  createDatabaseAsync: vi.fn(),
  initializeSchema: vi.fn(),
}))

// Mock core - use class implementations to avoid vitest warning
vi.mock('@skillsmith/core', () => ({
  createDatabase: vi.fn(() => ({
    close: vi.fn(),
  })),
  createDatabaseAsync: (...args: unknown[]) => mocks.createDatabaseAsync(...args),
  initializeSchema: (...args: unknown[]) => mocks.initializeSchema(...args),
  SkillRepository: vi.fn().mockImplementation(function () {
    return {
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
      uninstall: mocks.uninstallFn,
    }
  }),
  SkillParser: vi.fn().mockImplementation(function () {
    return {
      parse: vi.fn(),
      inferTrustTier: vi.fn(() => 'unknown'),
    }
  }),
}))

describe('SMI-745: Skill Management Commands', () => {
  const EXPECTED_SKILLS_DIR = join(homedir(), '.claude', 'skills')

  beforeEach(() => {
    vi.clearAllMocks()

    // Default: database opens and closes successfully
    const mockDb = { close: mocks.dbClose }
    mocks.createDatabaseAsync.mockResolvedValue(mockDb)

    // Default: uninstall succeeds
    mocks.uninstallFn.mockResolvedValue({
      success: true,
      skillName: 'test-skill',
      message: 'Skill "test-skill" has been uninstalled successfully.',
      removedPath: join(homedir(), '.claude', 'skills', 'test-skill'),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createListCommand', () => {
    it('creates a command with correct name', async () => {
      const { createListCommand } = await import('../src/commands/manage.js')
      const cmd = createListCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('list')
    })

    it('has ls alias', async () => {
      const { createListCommand } = await import('../src/commands/manage.js')
      const cmd = createListCommand()

      expect(cmd.aliases()).toContain('ls')
    })
  })

  describe('createUpdateCommand', () => {
    it('creates a command with correct name', async () => {
      const { createUpdateCommand } = await import('../src/commands/manage.js')
      const cmd = createUpdateCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('update')
    })

    it('has database path option', async () => {
      const { createUpdateCommand } = await import('../src/commands/manage.js')
      const cmd = createUpdateCommand()

      const dbOpt = cmd.options.find((o) => o.short === '-d')
      expect(dbOpt).toBeDefined()
    })

    it('has --all option for updating all skills', async () => {
      const { createUpdateCommand } = await import('../src/commands/manage.js')
      const cmd = createUpdateCommand()

      const allOpt = cmd.options.find((o) => o.short === '-a')
      expect(allOpt).toBeDefined()
      expect(allOpt?.long).toBe('--all')
    })

    it('accepts a variadic, optional skills argument (SMI-5593: one/set/all)', async () => {
      const { createUpdateCommand } = await import('../src/commands/manage.js')
      const cmd = createUpdateCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.required).toBe(false)
      expect(cmd.registeredArguments[0]?.variadic).toBe(true)
    })

    it('has --dry-run option (SMI-5593)', async () => {
      const { createUpdateCommand } = await import('../src/commands/manage.js')
      const cmd = createUpdateCommand()

      const dryRunOpt = cmd.options.find((o) => o.long === '--dry-run')
      expect(dryRunOpt).toBeDefined()
      expect(dryRunOpt?.short).toBe('-n')
    })
  })

  // SMI-5593: skillsmith update's real-implementation tests (registry
  // fallback, one/set/all selector, --dry-run, edge cases) live in the
  // sibling manage.update.test.ts — split out to stay under the 500-line
  // pre-commit file-length gate.

  describe('createRemoveCommand', () => {
    it('creates a command with correct name', async () => {
      const { createRemoveCommand } = await import('../src/commands/manage.js')
      const cmd = createRemoveCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('remove')
    })

    it('has rm and uninstall aliases', async () => {
      const { createRemoveCommand } = await import('../src/commands/manage.js')
      const cmd = createRemoveCommand()

      expect(cmd.aliases()).toContain('rm')
      expect(cmd.aliases()).toContain('uninstall')
    })

    it('has force option to skip confirmation', async () => {
      const { createRemoveCommand } = await import('../src/commands/manage.js')
      const cmd = createRemoveCommand()

      const forceOpt = cmd.options.find((o) => o.short === '-f')
      expect(forceOpt).toBeDefined()
      expect(forceOpt?.long).toBe('--force')
    })

    it('requires skill name argument', async () => {
      const { createRemoveCommand } = await import('../src/commands/manage.js')
      const cmd = createRemoveCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.required).toBe(true)
    })
  })

  describe('Skills Directory', () => {
    it('uses correct skills directory path', () => {
      expect(EXPECTED_SKILLS_DIR).toBe(join(homedir(), '.claude', 'skills'))
    })
  })

  describe('getInstalledSkills', () => {
    it('is exported from module', async () => {
      const module = await import('../src/commands/manage.js')
      expect(typeof module.getInstalledSkills).toBe('function')
    })
  })

  /**
   * SMI-1630: Search both global and local skill directories
   *
   * The CLI should search both:
   * - Global: ~/.claude/skills/
   * - Local: ${process.cwd()}/.claude/skills/
   *
   * Local skills should take precedence over global skills with the same name.
   */
  // SMI-1630 directory-scanning tests (unrelated to SMI-5593) live in the
  // sibling manage.skills-directory.test.ts — split out because this file
  // was already over the 500-line pre-commit gate before this change.

  describe('displaySkillsTable', () => {
    it('is exported from module', async () => {
      const module = await import('../src/commands/manage.js')
      expect(typeof module.displaySkillsTable).toBe('function')
    })
  })

  describe('SMI-3485: Remove command uses SkillInstallationService', () => {
    it('has --db option for database path', async () => {
      const { createRemoveCommand } = await import('../src/commands/manage.js')
      const cmd = createRemoveCommand()

      const dbOpt = cmd.options.find((o) => o.short === '-d')
      expect(dbOpt).toBeDefined()
      expect(dbOpt?.long).toBe('--db')
    })

    it('delegates to SkillInstallationService.uninstall()', async () => {
      // This test verifies the service is imported and wired correctly.
      // The actual uninstall logic is tested in core's service tests.
      const { SkillInstallationService } = await import('@skillsmith/core')
      expect(SkillInstallationService).toBeDefined()
      expect(mocks.uninstallFn).not.toHaveBeenCalled()
    })

    it('uninstall returns warning for orphan skills', async () => {
      mocks.uninstallFn.mockResolvedValue({
        success: true,
        skillName: 'orphan-skill',
        message: 'Skill "orphan-skill" removed from disk (was not in manifest).',
        removedPath: join(homedir(), '.claude', 'skills', 'orphan-skill'),
        warning:
          'Skill was not in the manifest. Use "skillsmith install" to register skills properly.',
      })

      const result = await mocks.uninstallFn('orphan-skill', { force: true })
      expect(result.success).toBe(true)
      expect(result.warning).toContain('not in the manifest')
    })

    it('uninstall returns modification warning when not forced', async () => {
      mocks.uninstallFn.mockResolvedValue({
        success: false,
        skillName: 'modified-skill',
        message:
          'Skill "modified-skill" has been modified since installation. Use force=true to remove anyway.',
        warning: 'Local modifications will be lost if you force uninstall.',
      })

      const result = await mocks.uninstallFn('modified-skill', {})
      expect(result.success).toBe(false)
      expect(result.warning).toContain('Local modifications')
    })

    it('displays no-skills hint with author/name format', async () => {
      const { readdir } = await import('fs/promises')
      const readdirMock = vi.mocked(readdir)

      // No skills installed — readdir returns empty
      readdirMock.mockImplementation(async () => {
        return [] as unknown as ReturnType<typeof readdir>
      })

      // Import and capture what displaySkillsTable outputs
      const { displaySkillsTable } = await import('../src/commands/manage.js')
      const consoleSpy = vi.spyOn(console, 'log')

      displaySkillsTable([])

      // Verify the hint uses author/skill-name format
      const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(allOutput).toContain('skillsmith install <author/skill-name>')

      consoleSpy.mockRestore()
    })

    it("SMI-6060: footer's local: segment prints the relative display path, not an absolute one", async () => {
      // Regression guard: the footer used to hand-type the literal
      // './.claude/skills' independently of getLocalSkillsDir()'s own path
      // segments — asserting the actual printed text here (not an
      // internal-call spy on getLocalSkillsDirDisplay) is what would have
      // caught a drift between the two.
      const { displaySkillsTable } = await import('../src/commands/manage.js')
      const consoleSpy = vi.spyOn(console, 'log')

      displaySkillsTable([
        {
          name: 'test-skill',
          path: '/some/path/test-skill',
          version: '1.0.0',
          trustTier: 'verified',
          installDate: '2026-01-01',
          hasUpdates: false,
          installedVia: 'claude-code',
        },
      ])

      const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(allOutput).toContain('local: ./.claude/skills')
      // The relative form only — never process.cwd()'s absolute prefix.
      expect(allOutput).not.toContain(process.cwd() + '/.claude/skills')

      consoleSpy.mockRestore()
    })
  })
})
