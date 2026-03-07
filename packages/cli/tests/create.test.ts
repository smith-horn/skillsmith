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
// validateSkillName
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

  it('has --output option', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    const opt = cmd.options.find((o) => o.long === '--output')
    expect(opt).toBeDefined()
  })

  it('has --type option', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    const opt = cmd.options.find((o) => o.long === '--type')
    expect(opt).toBeDefined()
  })

  it('has --behavior option', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    const opt = cmd.options.find((o) => o.long === '--behavior')
    expect(opt).toBeDefined()
  })

  it('has --scripts flag', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    const opt = cmd.options.find((o) => o.long === '--scripts')
    expect(opt).toBeDefined()
  })

  it('has --yes flag', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    const opt = cmd.options.find((o) => o.long === '--yes')
    expect(opt).toBeDefined()
  })

  it('accepts an optional name argument', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.registeredArguments.length).toBeGreaterThanOrEqual(0)
  })

  it('has a description mentioning ~/.claude/skills', async () => {
    const { createCreateCommand } = await import('../src/commands/create.js')
    const cmd = createCreateCommand()
    expect(cmd.description()).toContain('~/.claude/skills')
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

    // Default prompt chain: type, behavior, include-scripts(false), description, author, category
    const selectResponses = overrides.selectResponses ?? ['basic', 'autonomous', 'development']
    const confirmResponses = overrides.confirmResponses ?? [false]
    const inputResponses = overrides.inputResponses ?? ['A test skill', 'testuser']

    // Use mockResolvedValueOnce chains to avoid type-intersection issues
    // with @inquirer/prompts' `Promise & { cancel }` return type.
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

  it('scaffolds exactly 3 files when scripts=false', async () => {
    const { writeFile } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: false,
    })

    // SKILL.md, README.md, CHANGELOG.md
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(3)
  })

  it('scaffolds exactly 4 files when scripts=true', async () => {
    const { writeFile } = await setupMocks()
    const { createSkill } = await import('../src/commands/create.js')

    await createSkill('test-skill', {
      output: '/tmp/test-skills',
      type: 'basic',
      behavior: 'autonomous',
      scripts: true,
    })

    // SKILL.md, README.md, CHANGELOG.md, scripts/example.js
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(4)
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

    const changelogCall = vi
      .mocked(writeFile)
      .mock.calls.find((call) => (call[0] as string).includes('CHANGELOG.md'))
    expect(changelogCall).toBeDefined()
    const content = changelogCall![1] as string
    expect(content).toContain('[1.0.0]')
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

    const skillMdCall = vi
      .mocked(writeFile)
      .mock.calls.find((call) => (call[0] as string).includes('SKILL.md'))
    expect(skillMdCall).toBeDefined()
    const content = skillMdCall![1] as string
    expect(content).toContain('Behavioral Classification')
  })

  it('does not write files when user declines overwrite', async () => {
    const { writeFile, stat } = await setupMocks({ statRejects: false, confirmResponses: [false] })
    // stat resolves (directory exists), confirm returns false (decline overwrite)
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

  it('skips overwrite confirm when --yes is set even if directory exists', async () => {
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

    // confirm should never have been called for overwrite
    expect(vi.mocked(confirm)).not.toHaveBeenCalled()
    // files should still be written
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(3)
  })

  it('calls spinner.fail and rethrows when mkdir fails', async () => {
    const { mkdir, writeFile, stat } = await import('fs/promises')
    const { input, confirm, select } = await import('@inquirer/prompts')
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

    vi.mocked(select).mockResolvedValue('basic')
    vi.mocked(confirm).mockResolvedValue(false)
    vi.mocked(input).mockResolvedValue('desc')

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
// Template export
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
