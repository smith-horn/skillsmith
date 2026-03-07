/**
 * SMI-3083: skillsmith create command tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// Mock file system
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
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
    warn: vi.fn().mockReturnThis(),
    text: '',
  })),
}))

// ---------------------------------------------------------------------------
// validateSkillName (re-exported from utils/skill-name via create.ts)
// ---------------------------------------------------------------------------

describe('SMI-3083: validateSkillName', () => {
  it('accepts valid lowercase-hyphen names', async () => {
    const { validateSkillName } = await import('../src/commands/create.js')
    expect(validateSkillName('my-skill')).toBe(true)
    expect(validateSkillName('skill')).toBe(true)
    expect(validateSkillName('a1b2-c3')).toBe(true)
  })

  it('rejects names with uppercase letters', async () => {
    const { validateSkillName } = await import('../src/commands/create.js')
    const result = validateSkillName('My-Skill')
    expect(result).not.toBe(true)
    expect(typeof result).toBe('string')
  })

  it('rejects names with spaces', async () => {
    const { validateSkillName } = await import('../src/commands/create.js')
    expect(validateSkillName('my skill')).not.toBe(true)
  })

  it('rejects names starting with a digit', async () => {
    const { validateSkillName } = await import('../src/commands/create.js')
    expect(validateSkillName('1skill')).not.toBe(true)
  })

  it('rejects empty string', async () => {
    const { validateSkillName } = await import('../src/commands/create.js')
    expect(validateSkillName('')).not.toBe(true)
  })

  it('rejects names with underscores', async () => {
    const { validateSkillName } = await import('../src/commands/create.js')
    expect(validateSkillName('my_skill')).not.toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createCreateCommand structure
// ---------------------------------------------------------------------------

describe('SMI-3083: createCreateCommand', () => {
  it('creates a command with name "create"', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd).toBeInstanceOf(Command)
    expect(cmd.name()).toBe('create')
  })

  it('has --output option with no baked-in default', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    const opt = cmd.options.find((o) => o.long === '--output')
    expect(opt).toBeDefined()
    // default must be undefined — resolved lazily inside createSkill()
    expect(opt?.defaultValue).toBeUndefined()
  })

  it('has --type option', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.options.find((o) => o.long === '--type')).toBeDefined()
  })

  it('has --behavior option', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.options.find((o) => o.long === '--behavior')).toBeDefined()
  })

  it('has --description option', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.options.find((o) => o.long === '--description')).toBeDefined()
  })

  it('has --author option', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.options.find((o) => o.long === '--author')).toBeDefined()
  })

  it('has --category option', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.options.find((o) => o.long === '--category')).toBeDefined()
  })

  it('has --scripts flag', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.options.find((o) => o.long === '--scripts')).toBeDefined()
  })

  it('has --yes flag', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.options.find((o) => o.long === '--yes')).toBeDefined()
  })

  it('has --dry-run flag', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.options.find((o) => o.long === '--dry-run')).toBeDefined()
  })

  it('has description mentioning ~/.claude/skills', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.description()).toContain('~/.claude/skills')
  })

  it('has description mentioning skillsmith author init', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.description()).toContain('author init')
  })
})

// ---------------------------------------------------------------------------
// createSkill scaffold behaviour
// ---------------------------------------------------------------------------

describe('SMI-3083: createSkill scaffold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Set up prompt mocks for tests that provide type/behavior/scripts via options.
   * Prompt order (when those options are not provided via flags):
   *   input:  description, author
   *   select: category, [type, behavior if not in options]
   *   confirm: [scripts if not in options], [overwrite if dir exists and !yes]
   */
  async function setupMocks(
    overrides: {
      statRejects?: boolean
      confirmResponses?: boolean[]
      selectResponses?: string[]
      inputResponses?: string[]
    } = {}
  ) {
    const { mkdir, writeFile, stat } = await import('fs/promises')
    const { input, confirm, select } = await import('@inquirer/prompts')

    if (overrides.statRejects !== false) {
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
    } else {
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
        ReturnType<typeof stat>
      >)
    }

    vi.mocked(mkdir).mockResolvedValue(undefined)
    vi.mocked(writeFile).mockResolvedValue(undefined)

    // Defaults assume type/behavior/scripts are passed via options (skips those prompts).
    // Only description (input), author (input), and category (select) are prompted.
    const selectResponses = overrides.selectResponses ?? ['development']
    const confirmResponses = overrides.confirmResponses ?? []
    const inputResponses = overrides.inputResponses ?? ['A test skill', 'testuser']

    for (const val of selectResponses) {
      vi.mocked(select).mockResolvedValueOnce(val as unknown as never)
    }
    for (const val of confirmResponses) {
      vi.mocked(confirm).mockResolvedValueOnce(val as unknown as never)
    }
    for (const val of inputResponses) {
      vi.mocked(input).mockResolvedValueOnce(val as unknown as never)
    }

    return { mkdir, writeFile, stat }
  }

  it('scaffolds exactly 4 files when scripts=false (SKILL.md, README.md, CHANGELOG.md, .gitignore)', async () => {
    const { writeFile } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
    })

    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(4)
  })

  it('scaffolds exactly 5 files when scripts=true (+ scripts/example.js)', async () => {
    const { writeFile } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: true,
    })

    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(5)
  })

  it('creates resources/ directory', async () => {
    const { mkdir } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
    })

    const mkdirCalls = vi.mocked(mkdir).mock.calls.map((c) => c[0] as string)
    expect(mkdirCalls.some((p) => p.endsWith('resources'))).toBe(true)
  })

  it('CHANGELOG.md content contains [1.0.0]', async () => {
    const { writeFile } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
    })

    const call = vi
      .mocked(writeFile)
      .mock.calls.find((c) => (c[0] as string).endsWith('CHANGELOG.md'))
    expect(call).toBeDefined()
    expect(call![1] as string).toContain('[1.0.0]')
  })

  it('SKILL.md content contains Behavioral Classification section', async () => {
    const { writeFile } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'advanced',
      behavior: 'guided',
      scripts: false,
    })

    const call = vi.mocked(writeFile).mock.calls.find((c) => (c[0] as string).endsWith('SKILL.md'))
    expect(call).toBeDefined()
    expect(call![1] as string).toContain('Behavioral Classification')
  })

  it('.gitignore is written with node_modules entry', async () => {
    const { writeFile } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
    })

    const call = vi
      .mocked(writeFile)
      .mock.calls.find((c) => (c[0] as string).endsWith('.gitignore'))
    expect(call).toBeDefined()
    expect(call![1] as string).toContain('node_modules/')
  })

  it('scripts/example.js uses JSON.stringify (safe for skill names with quotes)', async () => {
    const { writeFile } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: true,
    })

    const call = vi
      .mocked(writeFile)
      .mock.calls.find((c) => (c[0] as string).endsWith('example.js'))
    expect(call).toBeDefined()
    // JSON.stringify wraps the string in double quotes — no raw single-quote interpolation
    expect(call![1] as string).toContain('"test-skill script executed"')
  })

  it('does not write files when user declines overwrite', async () => {
    // stat resolves (dir exists); confirm returns false (decline)
    const { writeFile, stat } = await setupMocks({
      statRejects: false,
      confirmResponses: [false],
    })
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
      ReturnType<typeof stat>
    >)

    const { createSkill } = await import('../src/commands/create.js')
    await createSkill('existing-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
    })

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
  })

  it('--yes always overwrites without prompting even if directory exists', async () => {
    const { writeFile, stat, mkdir } = await setupMocks()
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
      ReturnType<typeof stat>
    >)
    vi.mocked(mkdir).mockResolvedValue(undefined)
    vi.mocked(writeFile).mockResolvedValue(undefined)

    const { createSkill } = await import('../src/commands/create.js')
    const { confirm } = await import('@inquirer/prompts')

    await createSkill('existing-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
      yes: true,
    })

    expect(vi.mocked(confirm)).not.toHaveBeenCalled()
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(4)
  })

  it('--dry-run prints preview without writing any files', async () => {
    await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')
    const { writeFile, mkdir } = await import('fs/promises')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
      dryRun: true,
    })

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
    expect(vi.mocked(mkdir)).not.toHaveBeenCalled()
  })

  it('supports fully non-interactive mode via --description, --author, --category, --type, --behavior, --scripts', async () => {
    const { mkdir, writeFile, stat } = await import('fs/promises')
    const { input, confirm, select } = await import('@inquirer/prompts')
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(mkdir).mockResolvedValue(undefined)
    vi.mocked(writeFile).mockResolvedValue(undefined)

    const { createSkill } = await import('../src/commands/create.js')
    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      description: 'A test skill',
      author: 'testuser',
      category: 'development',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
    })

    // No prompts should have been called
    expect(vi.mocked(input)).not.toHaveBeenCalled()
    expect(vi.mocked(select)).not.toHaveBeenCalled()
    expect(vi.mocked(confirm)).not.toHaveBeenCalled()
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(4)
  })

  it('calls spinner.fail and rethrows when mkdir fails', async () => {
    const { mkdir, writeFile, stat } = await import('fs/promises')
    const { input, select } = await import('@inquirer/prompts')
    const ora = await import('ora')

    const failMock = vi.fn().mockReturnThis()
    vi.mocked(ora.default).mockReturnValue({
      start: vi.fn().mockReturnThis(),
      stop: vi.fn().mockReturnThis(),
      succeed: vi.fn().mockReturnThis(),
      fail: failMock,
      warn: vi.fn().mockReturnThis(),
      text: '',
    } as unknown as ReturnType<typeof ora.default>)

    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(mkdir).mockRejectedValue(new Error('Permission denied'))
    vi.mocked(writeFile).mockResolvedValue(undefined)

    // All input prompts return a valid value; all select prompts return a valid category
    vi.mocked(input).mockResolvedValue('desc' as unknown as never)
    vi.mocked(select).mockResolvedValue('development' as unknown as never)

    const { createSkill } = await import('../src/commands/create.js')

    await expect(
      createSkill('fail-skill', {
        output: '/tmp/test-skills',
        type: 'basic',
        behavior: 'autonomous',
        scripts: false,
      })
    ).rejects.toThrow()

    expect(failMock).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Validation — CLI flag guards
// ---------------------------------------------------------------------------

describe('SMI-3083: createSkill validation guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects invalid --type value and exits', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    const { createSkill } = await import('../src/commands/create.js')
    await expect(
      createSkill('test-skill', {
        output: '/tmp/test-skills',
        type: 'invalid-type',
        behavior: 'autonomous',
        description: 'desc',
        author: 'testuser',
        category: 'development',
        scripts: false,
      })
    ).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('rejects invalid --behavior value and exits', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    const { createSkill } = await import('../src/commands/create.js')
    await expect(
      createSkill('test-skill', {
        output: '/tmp/test-skills',
        type: 'basic',
        behavior: 'invalid-behavior',
        description: 'desc',
        author: 'testuser',
        category: 'development',
        scripts: false,
      })
    ).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('rejects invalid --category value and exits', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    const { createSkill } = await import('../src/commands/create.js')
    await expect(
      createSkill('test-skill', {
        output: '/tmp/test-skills',
        type: 'basic',
        behavior: 'autonomous',
        description: 'desc',
        author: 'testuser',
        category: 'invalid-category',
        scripts: false,
      })
    ).rejects.toThrow()

    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Template exports
// ---------------------------------------------------------------------------

describe('SMI-3083: CHANGELOG_MD_TEMPLATE', () => {
  it('is exported from templates/index', async () => {
    const { CHANGELOG_MD_TEMPLATE } = await import('../src/templates/index.js')
    expect(typeof CHANGELOG_MD_TEMPLATE).toBe('string')
  })

  it('contains [1.0.0] placeholder pattern', async () => {
    const { CHANGELOG_MD_TEMPLATE } = await import('../src/templates/index.js')
    expect(CHANGELOG_MD_TEMPLATE).toContain('[1.0.0]')
  })

  it('contains {{name}} and {{date}} placeholders', async () => {
    const { CHANGELOG_MD_TEMPLATE } = await import('../src/templates/index.js')
    expect(CHANGELOG_MD_TEMPLATE).toContain('{{name}}')
    expect(CHANGELOG_MD_TEMPLATE).toContain('{{date}}')
  })
})

describe('SMI-3083: SKILL_MD_TEMPLATE has {{behavioralClassification}} placeholder', () => {
  it('contains {{behavioralClassification}} for create/init branching', async () => {
    const { SKILL_MD_TEMPLATE } = await import('../src/templates/index.js')
    expect(SKILL_MD_TEMPLATE).toContain('{{behavioralClassification}}')
  })
})
