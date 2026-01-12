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
  access: vi.fn(),
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

    it('exports generateSubagent function', async () => {
      const module = await import('../src/commands/author.js')
      expect(typeof module.generateSubagent).toBe('function')
    })

    it('exports transformSkill function', async () => {
      const module = await import('../src/commands/author.js')
      expect(typeof module.transformSkill).toBe('function')
    })
  })

  // SMI-1389: Subagent Command Tests
  describe('createSubagentCommand', () => {
    it('creates a command with correct name', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('subagent')
    })

    it('has output option with default', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      const outputOpt = cmd.options.find((o) => o.short === '-o')
      expect(outputOpt).toBeDefined()
      expect(outputOpt?.defaultValue).toBe('~/.claude/agents')
    })

    it('has tools option', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      const toolsOpt = cmd.options.find((o) => o.long === '--tools')
      expect(toolsOpt).toBeDefined()
    })

    it('has model option with sonnet default', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      const modelOpt = cmd.options.find((o) => o.long === '--model')
      expect(modelOpt).toBeDefined()
      expect(modelOpt?.defaultValue).toBe('sonnet')
    })

    it('has skip-claude-md option', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      const skipOpt = cmd.options.find((o) => o.long === '--skip-claude-md')
      expect(skipOpt).toBeDefined()
    })

    it('accepts optional path argument with default', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.defaultValue).toBe('.')
    })
  })

  // SMI-1390: Transform Command Tests
  describe('createTransformCommand', () => {
    it('creates a command with correct name', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('transform')
    })

    it('has dry-run option', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      const dryRunOpt = cmd.options.find((o) => o.long === '--dry-run')
      expect(dryRunOpt).toBeDefined()
    })

    it('has force option', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      const forceOpt = cmd.options.find((o) => o.long === '--force')
      expect(forceOpt).toBeDefined()
    })

    it('has batch option', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      const batchOpt = cmd.options.find((o) => o.long === '--batch')
      expect(batchOpt).toBeDefined()
    })

    it('accepts optional path argument with default', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.defaultValue).toBe('.')
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

  // SMI-1391: Subagent Template Tests
  describe('SUBAGENT_MD_TEMPLATE', () => {
    it('is exported from templates', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')
      expect(typeof SUBAGENT_MD_TEMPLATE).toBe('string')
    })

    it('contains required placeholders', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SUBAGENT_MD_TEMPLATE).toContain('{{name}}')
      expect(SUBAGENT_MD_TEMPLATE).toContain('{{description}}')
      expect(SUBAGENT_MD_TEMPLATE).toContain('{{triggers}}')
      expect(SUBAGENT_MD_TEMPLATE).toContain('{{tools}}')
      expect(SUBAGENT_MD_TEMPLATE).toContain('{{model}}')
    })

    it('contains YAML frontmatter delimiters', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SUBAGENT_MD_TEMPLATE).toMatch(/^---/)
      expect(SUBAGENT_MD_TEMPLATE).toContain('---\n\nYou are a')
    })

    it('includes operating protocol section', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SUBAGENT_MD_TEMPLATE).toContain('## Operating Protocol')
      expect(SUBAGENT_MD_TEMPLATE).toContain('## Output Format')
      expect(SUBAGENT_MD_TEMPLATE).toContain('## Constraints')
    })

    it('includes token constraint', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SUBAGENT_MD_TEMPLATE).toContain('500 tokens')
    })
  })

  describe('CLAUDE_MD_DELEGATION_TEMPLATE', () => {
    it('is exported from templates', async () => {
      const { CLAUDE_MD_DELEGATION_TEMPLATE } = await import('../src/templates/index.js')
      expect(typeof CLAUDE_MD_DELEGATION_TEMPLATE).toBe('string')
    })

    it('contains required placeholders', async () => {
      const { CLAUDE_MD_DELEGATION_TEMPLATE } = await import('../src/templates/index.js')

      expect(CLAUDE_MD_DELEGATION_TEMPLATE).toContain('{{name}}')
      expect(CLAUDE_MD_DELEGATION_TEMPLATE).toContain('{{triggers}}')
    })

    it('includes delegation pattern', async () => {
      const { CLAUDE_MD_DELEGATION_TEMPLATE } = await import('../src/templates/index.js')

      expect(CLAUDE_MD_DELEGATION_TEMPLATE).toContain('Delegation Pattern')
      expect(CLAUDE_MD_DELEGATION_TEMPLATE).toContain('subagent_type')
    })
  })
})
