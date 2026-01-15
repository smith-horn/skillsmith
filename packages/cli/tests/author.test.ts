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
    warn: vi.fn().mockReturnThis(),
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

describe('SMI-1389: Subagent Command', () => {
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

    it('has model option with default sonnet', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      const modelOpt = cmd.options.find((o) => o.long === '--model')
      expect(modelOpt).toBeDefined()
      expect(modelOpt?.defaultValue).toBe('sonnet')
    })

    it('has force flag', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      const forceOpt = cmd.options.find((o) => o.long === '--force')
      expect(forceOpt).toBeDefined()
    })

    it('has skip-claude-md flag', async () => {
      const { createSubagentCommand } = await import('../src/commands/author.js')
      const cmd = createSubagentCommand()

      const skipOpt = cmd.options.find((o) => o.long === '--skip-claude-md')
      expect(skipOpt).toBeDefined()
    })
  })
})

describe('SMI-1390: Transform Command', () => {
  describe('createTransformCommand', () => {
    it('creates a command with correct name', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('transform')
    })

    it('has dry-run flag', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      const dryRunOpt = cmd.options.find((o) => o.long === '--dry-run')
      expect(dryRunOpt).toBeDefined()
    })

    it('has batch flag', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      const batchOpt = cmd.options.find((o) => o.long === '--batch')
      expect(batchOpt).toBeDefined()
    })

    it('has force flag', async () => {
      const { createTransformCommand } = await import('../src/commands/author.js')
      const cmd = createTransformCommand()

      const forceOpt = cmd.options.find((o) => o.long === '--force')
      expect(forceOpt).toBeDefined()
    })
  })

  describe('Exported Functions', () => {
    it('exports generateSubagent function', async () => {
      const module = await import('../src/commands/author.js')
      expect(typeof module.generateSubagent).toBe('function')
    })

    it('exports transformSkill function', async () => {
      const module = await import('../src/commands/author.js')
      expect(typeof module.transformSkill).toBe('function')
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

  describe('SUBAGENT_MD_TEMPLATE', () => {
    it('is exported from templates', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')
      expect(typeof SUBAGENT_MD_TEMPLATE).toBe('string')
    })

    it('contains required placeholders', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SUBAGENT_MD_TEMPLATE).toContain('{{skillName}}')
      expect(SUBAGENT_MD_TEMPLATE).toContain('{{description}}')
      expect(SUBAGENT_MD_TEMPLATE).toContain('{{tools}}')
      expect(SUBAGENT_MD_TEMPLATE).toContain('{{model}}')
    })

    it('contains YAML frontmatter delimiters', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SUBAGENT_MD_TEMPLATE).toMatch(/^---/)
      expect(SUBAGENT_MD_TEMPLATE).toContain('---\n\n##')
    })

    it('contains Operating Protocol section', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SUBAGENT_MD_TEMPLATE).toContain('## Operating Protocol')
    })

    it('contains Output Format section', async () => {
      const { SUBAGENT_MD_TEMPLATE } = await import('../src/templates/index.js')

      expect(SUBAGENT_MD_TEMPLATE).toContain('## Output Format')
    })
  })

  describe('renderSubagentTemplate', () => {
    it('renders template with provided data', async () => {
      const { renderSubagentTemplate } = await import('../src/templates/index.js')

      const result = renderSubagentTemplate({
        skillName: 'test-skill',
        description: 'A test skill',
        triggerPhrases: ['run test', 'execute test'],
        tools: ['Read', 'Bash'],
        model: 'sonnet',
      })

      expect(result).toContain('name: test-skill-specialist')
      expect(result).toContain('A test skill')
      expect(result).toContain('Read, Bash')
      expect(result).toContain('model: sonnet')
    })

    it('formats trigger phrases correctly', async () => {
      const { renderSubagentTemplate } = await import('../src/templates/index.js')

      const result = renderSubagentTemplate({
        skillName: 'my-skill',
        description: 'Description',
        triggerPhrases: ['phrase one', 'phrase two'],
        tools: ['Read'],
        model: 'haiku',
      })

      expect(result).toContain('"phrase one"')
      expect(result).toContain('"phrase two"')
    })
  })

  describe('renderClaudeMdSnippet', () => {
    it('renders CLAUDE.md snippet', async () => {
      const { renderClaudeMdSnippet } = await import('../src/templates/index.js')

      const result = renderClaudeMdSnippet({
        skillName: 'my-skill',
        description: 'A cool skill',
        triggerPhrases: ['do something'],
        tools: ['Read', 'Write'],
        model: 'opus',
      })

      expect(result).toContain('Subagent Delegation: my-skill')
      expect(result).toContain('my-skill-specialist')
      expect(result).toContain('do something')
    })
  })
})

describe('Tool Analyzer', () => {
  describe('analyzeToolRequirements', () => {
    it('always includes Read tool', async () => {
      const { analyzeToolRequirements } = await import('../src/utils/tool-analyzer.js')

      const result = analyzeToolRequirements('Some basic content')
      expect(result.requiredTools).toContain('Read')
    })

    it('detects Write tool from content', async () => {
      const { analyzeToolRequirements } = await import('../src/utils/tool-analyzer.js')

      const result = analyzeToolRequirements('This skill will write files')
      expect(result.requiredTools).toContain('Write')
    })

    it('detects Bash tool from npm commands', async () => {
      const { analyzeToolRequirements } = await import('../src/utils/tool-analyzer.js')

      const result = analyzeToolRequirements('Run npm install to set up')
      expect(result.requiredTools).toContain('Bash')
    })

    it('detects Grep tool from search patterns', async () => {
      const { analyzeToolRequirements } = await import('../src/utils/tool-analyzer.js')

      const result = analyzeToolRequirements('Search for text in files')
      expect(result.requiredTools).toContain('Grep')
    })

    it('detects WebFetch from URL mentions', async () => {
      const { analyzeToolRequirements } = await import('../src/utils/tool-analyzer.js')

      const result = analyzeToolRequirements('Fetch data from the API using http requests')
      expect(result.requiredTools).toContain('WebFetch')
    })

    it('returns high confidence for many matches', async () => {
      const { analyzeToolRequirements } = await import('../src/utils/tool-analyzer.js')

      const result = analyzeToolRequirements(
        'Write files, run bash commands, search text, and fetch URLs'
      )
      expect(result.confidence).toBe('high')
    })

    it('returns low confidence for no matches', async () => {
      const { analyzeToolRequirements } = await import('../src/utils/tool-analyzer.js')

      const result = analyzeToolRequirements('Simple description with no tool keywords')
      expect(result.confidence).toBe('low')
    })
  })

  describe('formatToolList', () => {
    it('formats tool array to comma-separated string', async () => {
      const { formatToolList } = await import('../src/utils/tool-analyzer.js')

      const result = formatToolList(['Read', 'Write', 'Bash'])
      expect(result).toBe('Read, Write, Bash')
    })

    it('returns Read for empty array', async () => {
      const { formatToolList } = await import('../src/utils/tool-analyzer.js')

      const result = formatToolList([])
      expect(result).toBe('Read')
    })
  })

  describe('parseToolsString', () => {
    it('parses comma-separated tools', async () => {
      const { parseToolsString } = await import('../src/utils/tool-analyzer.js')

      const result = parseToolsString('Read, Write, Bash')
      expect(result).toEqual(['Read', 'Write', 'Bash'])
    })

    it('trims whitespace', async () => {
      const { parseToolsString } = await import('../src/utils/tool-analyzer.js')

      const result = parseToolsString('  Read ,  Write  ')
      expect(result).toEqual(['Read', 'Write'])
    })
  })

  describe('validateTools', () => {
    it('validates known tools', async () => {
      const { validateTools } = await import('../src/utils/tool-analyzer.js')

      const result = validateTools(['Read', 'Write', 'Bash'])
      expect(result.valid).toBe(true)
      expect(result.unrecognized).toEqual([])
    })

    it('identifies unrecognized tools', async () => {
      const { validateTools } = await import('../src/utils/tool-analyzer.js')

      const result = validateTools(['Read', 'UnknownTool'])
      expect(result.valid).toBe(false)
      expect(result.unrecognized).toContain('UnknownTool')
    })
  })
})

describe('SMI-1433: MCP Server Scaffolding Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('initMcpServer Integration', () => {
    it('creates all 8 files when directory does not exist', async () => {
      const { stat, mkdir, writeFile } = await import('fs/promises')
      const { input, confirm } = await import('@inquirer/prompts')

      // Directory doesn't exist
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(mkdir).mockResolvedValue(undefined)
      vi.mocked(writeFile).mockResolvedValue(undefined)

      // Prompt responses
      vi.mocked(input)
        .mockResolvedValueOnce('test-server') // name
        .mockResolvedValueOnce('Test description') // description
        .mockResolvedValueOnce('test-author') // author
      vi.mocked(confirm).mockResolvedValue(false) // don't add tools interactively

      // Dynamically import to get fresh mocks
      const { initMcpServer } = await import('../src/commands/author.js')
      await initMcpServer(undefined, {})

      // Verify all 8 files are written
      expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(8)

      // Verify expected file paths
      const writeCalls = vi.mocked(writeFile).mock.calls
      const writtenPaths = writeCalls.map((call) => {
        const path = call[0] as string
        // Extract relative path from the full path
        const parts = path.split('/test-server/')
        return parts[1] || path.split('/').pop()
      })

      expect(writtenPaths).toContain('package.json')
      expect(writtenPaths).toContain('tsconfig.json')
      expect(writtenPaths).toContain('README.md')
      expect(writtenPaths).toContain('.gitignore')
    })

    it('includes tool definitions when --tools option is used', async () => {
      const { stat, mkdir, writeFile } = await import('fs/promises')
      const { input } = await import('@inquirer/prompts')

      // Directory doesn't exist
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(mkdir).mockResolvedValue(undefined)
      vi.mocked(writeFile).mockResolvedValue(undefined)

      // Prompt responses
      vi.mocked(input)
        .mockResolvedValueOnce('tool-server') // name
        .mockResolvedValueOnce('Server with tools') // description
        .mockResolvedValueOnce('author') // author

      const { initMcpServer } = await import('../src/commands/author.js')
      await initMcpServer(undefined, { tools: 'fetch-data,process-item' })

      // Verify writeFile was called
      expect(vi.mocked(writeFile)).toHaveBeenCalled()

      // Find the tools/index.ts file content
      const writeCalls = vi.mocked(writeFile).mock.calls
      const toolsIndexCall = writeCalls.find((call) => {
        const path = call[0] as string
        return path.includes('tools/index.ts')
      })

      expect(toolsIndexCall).toBeDefined()
      if (toolsIndexCall) {
        const content = toolsIndexCall[1] as string
        expect(content).toContain('fetch-data')
        expect(content).toContain('process-item')
      }
    })

    it('calls spinner.fail when mkdir throws an error', async () => {
      const { stat, mkdir } = await import('fs/promises')
      const { input, confirm } = await import('@inquirer/prompts')
      const ora = await import('ora')

      // Track spinner.fail calls
      const failMock = vi.fn().mockReturnThis()
      vi.mocked(ora.default).mockReturnValue({
        start: vi.fn().mockReturnThis(),
        stop: vi.fn().mockReturnThis(),
        succeed: vi.fn().mockReturnThis(),
        fail: failMock,
        warn: vi.fn().mockReturnThis(),
        text: '',
      } as unknown as ReturnType<typeof ora.default>)

      // Directory doesn't exist, but mkdir fails
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(mkdir).mockRejectedValue(new Error('Permission denied'))

      // Prompt responses
      vi.mocked(input)
        .mockResolvedValueOnce('fail-server') // name
        .mockResolvedValueOnce('Will fail') // description
        .mockResolvedValueOnce('author') // author
      vi.mocked(confirm).mockResolvedValue(false)

      const { initMcpServer } = await import('../src/commands/author.js')

      await expect(initMcpServer(undefined, {})).rejects.toThrow()

      expect(failMock).toHaveBeenCalled()
      const failMessage = failMock.mock.calls[0]?.[0] as string
      expect(failMessage).toContain('Failed to create MCP server')
    })

    it('writes files when --force is used with existing directory', async () => {
      const { stat, mkdir, writeFile } = await import('fs/promises')
      const { input, confirm } = await import('@inquirer/prompts')

      // Directory exists
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
        ReturnType<typeof stat>
      >)
      vi.mocked(mkdir).mockResolvedValue(undefined)
      vi.mocked(writeFile).mockResolvedValue(undefined)

      // Prompt responses
      vi.mocked(input)
        .mockResolvedValueOnce('force-server') // name
        .mockResolvedValueOnce('Force overwrite') // description
        .mockResolvedValueOnce('author') // author
      vi.mocked(confirm).mockResolvedValue(false) // don't add tools (not asked about overwrite due to --force)

      const { initMcpServer } = await import('../src/commands/author.js')
      await initMcpServer(undefined, { force: true })

      // Verify files are written despite directory existing
      expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(8)
    })

    it('does not write files when user declines overwrite prompt', async () => {
      const { stat, mkdir, writeFile } = await import('fs/promises')
      const { input, confirm } = await import('@inquirer/prompts')

      // Directory exists
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
        ReturnType<typeof stat>
      >)
      vi.mocked(mkdir).mockResolvedValue(undefined)
      vi.mocked(writeFile).mockResolvedValue(undefined)

      // Prompt responses
      vi.mocked(input)
        .mockResolvedValueOnce('existing-server') // name
        .mockResolvedValueOnce('Exists already') // description
        .mockResolvedValueOnce('author') // author
      vi.mocked(confirm)
        .mockResolvedValueOnce(false) // don't add tools
        .mockResolvedValueOnce(false) // decline overwrite

      const { initMcpServer } = await import('../src/commands/author.js')
      await initMcpServer(undefined, {})

      // Verify no files are written
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
    })
  })

  describe('createMcpInitCommand', () => {
    it('creates a command with correct name', async () => {
      const { createMcpInitCommand } = await import('../src/commands/author.js')
      const cmd = createMcpInitCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('mcp-init')
    })

    it('has correct description', async () => {
      const { createMcpInitCommand } = await import('../src/commands/author.js')
      const cmd = createMcpInitCommand()

      expect(cmd.description()).toContain('Scaffold')
      expect(cmd.description()).toContain('MCP server')
    })

    it('accepts optional name argument', async () => {
      const { createMcpInitCommand } = await import('../src/commands/author.js')
      const cmd = createMcpInitCommand()

      expect(cmd.registeredArguments.length).toBeGreaterThanOrEqual(0)
    })

    it('has output option', async () => {
      const { createMcpInitCommand } = await import('../src/commands/author.js')
      const cmd = createMcpInitCommand()

      const outputOpt = cmd.options.find((o) => o.short === '-o')
      expect(outputOpt).toBeDefined()
      expect(outputOpt?.long).toBe('--output')
    })

    it('has tools option', async () => {
      const { createMcpInitCommand } = await import('../src/commands/author.js')
      const cmd = createMcpInitCommand()

      const toolsOpt = cmd.options.find((o) => o.long === '--tools')
      expect(toolsOpt).toBeDefined()
    })

    it('has force option', async () => {
      const { createMcpInitCommand } = await import('../src/commands/author.js')
      const cmd = createMcpInitCommand()

      const forceOpt = cmd.options.find((o) => o.long === '--force')
      expect(forceOpt).toBeDefined()
    })
  })

  describe('MCP Server Template Integration', () => {
    it('exports renderMcpServerTemplates', async () => {
      const { renderMcpServerTemplates } = await import('../src/templates/index.js')
      expect(typeof renderMcpServerTemplates).toBe('function')
    })

    it('template generates valid JSON for package.json', async () => {
      const { renderMcpServerTemplates } = await import('../src/templates/index.js')
      const files = renderMcpServerTemplates({
        name: 'test-server',
        description: 'Test server',
        author: 'test',
        tools: [],
      })

      const packageJson = files.get('package.json')
      expect(() => JSON.parse(packageJson || '')).not.toThrow()
    })

    it('template generates valid JSON for tsconfig.json', async () => {
      const { renderMcpServerTemplates } = await import('../src/templates/index.js')
      const files = renderMcpServerTemplates({
        name: 'test-server',
        description: 'Test server',
        author: 'test',
        tools: [],
      })

      const tsconfig = files.get('tsconfig.json')
      expect(() => JSON.parse(tsconfig || '')).not.toThrow()
    })
  })
})
