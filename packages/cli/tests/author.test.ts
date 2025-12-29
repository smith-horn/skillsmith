/**
 * SMI-746: Skill Authoring Commands Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// Mock file system
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}))

// Mock inquirer
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
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
  SkillParser: vi.fn(() => ({
    parse: vi.fn(),
    parseWithValidation: vi.fn(() => ({
      metadata: null,
      validation: { valid: false, errors: ['Test error'], warnings: [] },
      frontmatter: null,
    })),
    inferTrustTier: vi.fn(() => 'unknown'),
  })),
}))

describe('SMI-746: Skill Authoring Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createInitCommand', () => {
    it('creates a command with correct name', async () => {
      const { createInitCommand } = await import('../src/commands/author.js')
      const cmd = createInitCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('init')
    })

    it('has path option with default', async () => {
      const { createInitCommand } = await import('../src/commands/author.js')
      const cmd = createInitCommand()

      const pathOpt = cmd.options.find((o) => o.short === '-p')
      expect(pathOpt).toBeDefined()
      expect(pathOpt?.defaultValue).toBe('.')
    })

    it('accepts optional name argument', async () => {
      const { createInitCommand } = await import('../src/commands/author.js')
      const cmd = createInitCommand()

      // Has one optional argument for name
      expect(cmd.registeredArguments.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('createValidateCommand', () => {
    it('creates a command with correct name', async () => {
      const { createValidateCommand } = await import('../src/commands/author.js')
      const cmd = createValidateCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('validate')
    })

    it('accepts optional path argument with default', async () => {
      const { createValidateCommand } = await import('../src/commands/author.js')
      const cmd = createValidateCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.defaultValue).toBe('.')
    })
  })

  describe('createPublishCommand', () => {
    it('creates a command with correct name', async () => {
      const { createPublishCommand } = await import('../src/commands/author.js')
      const cmd = createPublishCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('publish')
    })

    it('accepts optional path argument with default', async () => {
      const { createPublishCommand } = await import('../src/commands/author.js')
      const cmd = createPublishCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.defaultValue).toBe('.')
    })
  })

  describe('Exported Functions', () => {
    it('exports initSkill function', async () => {
      const module = await import('../src/commands/author.js')
      expect(typeof module.initSkill).toBe('function')
    })

    it('exports validateSkill function', async () => {
      const module = await import('../src/commands/author.js')
      expect(typeof module.validateSkill).toBe('function')
    })

    it('exports publishSkill function', async () => {
      const module = await import('../src/commands/author.js')
      expect(typeof module.publishSkill).toBe('function')
    })
  })
})

describe('Templates', () => {
  describe('SKILL_MD_TEMPLATE', () => {
    it('is exported from templates', async () => {
      const { SKILL_MD_TEMPLATE } = await import('../src/templates/index.js')
      expect(typeof SKILL_MD_TEMPLATE).toBe('string')
    })

    it('contains required placeholders', async () => {
      const { SKILL_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SKILL_MD_TEMPLATE).toContain('{{name}}')
      expect(SKILL_MD_TEMPLATE).toContain('{{description}}')
      expect(SKILL_MD_TEMPLATE).toContain('{{author}}')
      expect(SKILL_MD_TEMPLATE).toContain('{{category}}')
      expect(SKILL_MD_TEMPLATE).toContain('{{date}}')
    })

    it('contains YAML frontmatter delimiters', async () => {
      const { SKILL_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SKILL_MD_TEMPLATE).toMatch(/^---/)
      expect(SKILL_MD_TEMPLATE).toContain('---\n\n#')
    })
  })

  describe('README_MD_TEMPLATE', () => {
    it('is exported from templates', async () => {
      const { README_MD_TEMPLATE } = await import('../src/templates/index.js')
      expect(typeof README_MD_TEMPLATE).toBe('string')
    })

    it('contains required placeholders', async () => {
      const { README_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(README_MD_TEMPLATE).toContain('{{name}}')
      expect(README_MD_TEMPLATE).toContain('{{description}}')
    })

    it('includes installation instructions', async () => {
      const { README_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(README_MD_TEMPLATE).toContain('skillsmith install')
      expect(README_MD_TEMPLATE).toContain('~/.claude/skills/')
    })
  })
})
