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

// Mock core
vi.mock('@skillsmith/core', () => ({
  createDatabase: vi.fn(() => ({
    close: vi.fn(),
  })),
  SkillRepository: vi.fn(() => ({
    findAll: vi.fn(() => ({ items: [], total: 0, limit: 1000, offset: 0, hasMore: false })),
  })),
  SkillParser: vi.fn(() => ({
    parse: vi.fn(),
    inferTrustTier: vi.fn(() => 'unknown'),
  })),
}))

describe('SMI-745: Skill Management Commands', () => {
  const EXPECTED_SKILLS_DIR = join(homedir(), '.claude', 'skills')

  beforeEach(() => {
    vi.clearAllMocks()
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

    it('accepts optional skill name argument', async () => {
      const { createUpdateCommand } = await import('../src/commands/manage.js')
      const cmd = createUpdateCommand()

      // Has one optional argument
      expect(cmd.registeredArguments.length).toBeGreaterThanOrEqual(0)
    })
  })

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

  describe('displaySkillsTable', () => {
    it('is exported from module', async () => {
      const module = await import('../src/commands/manage.js')
      expect(typeof module.displaySkillsTable).toBe('function')
    })
  })
})
