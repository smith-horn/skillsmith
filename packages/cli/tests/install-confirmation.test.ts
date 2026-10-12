/**
 * SMI-7056: `skillsmith install` answers core's CONFIRMATION_REQUIRED gate.
 *
 * Core now refuses a registry skill whose trust tier is not a reviewed tier
 * unless `confirmed` is true. The CLI has three ways to answer: `--yes`, an
 * interactive y/N prompt on a TTY, or a non-zero exit naming `--yes`. `--yes`
 * must never loosen `skipScan`.
 *
 * Mock setup mirrors tests/unit/commands/install.test.ts (hoisted state; the
 * SkillInstallationService is mocked, so these tests pin what the CLI sends and
 * how it reacts to the result, not core's own gate).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  confirmFn: vi.fn(),
  createDatabaseAsync: vi.fn(),
  initializeSchema: vi.fn(),
  dbClose: vi.fn(),
}))

vi.mock('ora', () => ({ default: () => mocks.spinner }))

vi.mock('@inquirer/prompts', () => ({
  confirm: (...args: unknown[]) => mocks.confirmFn(...args),
}))

vi.mock('@skillsmith/core', () => ({
  createDatabaseAsync: (...args: unknown[]) => mocks.createDatabaseAsync(...args),
  initializeSchema: (...args: unknown[]) => mocks.initializeSchema(...args),
  SkillRepository: vi.fn().mockImplementation(function () {
    return { findById: vi.fn(() => null) }
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return { clearAll: vi.fn() }
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return { install: mocks.installFn }
  }),
  QuarantineRepository: vi.fn().mockImplementation(function () {
    return { isQuarantined: vi.fn(() => false) }
  }),
  SkillsmithApiClient: Object.assign(vi.fn(), {
    toSkill: (r: { trust_tier?: string }) => ({ trustTier: r.trust_tier ?? 'community' }),
  }),
  loadStoredAccessToken: vi.fn().mockResolvedValue(null),
  createApiClient: vi.fn(() => ({ isOffline: () => true, getSkill: vi.fn() })),
  isGitHubUrl: vi.fn(() => false),
  emitInstallEvent: vi.fn(async () => undefined),
  isQuietModeEnabled: () => false,
}))

const SKILL_ID = 'someone/low-star-skill'

const CONFIRMATION_REQUIRED = {
  success: false,
  skillId: SKILL_ID,
  installPath: '/tmp/.claude/skills/low-star-skill',
  errorCode: 'CONFIRMATION_REQUIRED',
  trustTier: 'unverified',
  requiresConfirmation: true,
  confirmationReason:
    'This is an unverified tier skill. unverified tier skills have not been reviewed. ' +
    'Re-run with confirmed=true to proceed.',
  tips: ['Trust tier: unverified', 'Use confirmed=true to proceed with installation'],
}

const INSTALLED = {
  success: true,
  skillId: SKILL_ID,
  installPath: '/tmp/.claude/skills/low-star-skill',
  trustTier: 'unverified',
}

const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

const ttyDescriptors = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
}

function setTty(isTty: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTty, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true })
}

function restoreTty(): void {
  for (const [stream, key] of [
    [process.stdin, 'stdin'],
    [process.stdout, 'stdout'],
  ] as const) {
    const original = ttyDescriptors[key]
    if (original) Object.defineProperty(stream, 'isTTY', original)
    else delete (stream as { isTTY?: boolean }).isTTY
  }
}

async function run(...args: string[]): Promise<void> {
  const { createInstallCommand } = await import('../src/commands/install.js')
  await createInstallCommand().parseAsync(['node', 'test', SKILL_ID, ...args])
}

function errorOutput(): string {
  return mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
}

describe('SMI-7056: install confirmation path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    console.error = mockConsoleError
    mocks.createDatabaseAsync.mockResolvedValue({ close: mocks.dbClose })
    mocks.installFn.mockResolvedValue(INSTALLED)
    setTty(false)
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
    restoreTty()
  })

  it('--yes passes confirmed: true to install() on the first call', async () => {
    await run('--yes')

    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    expect(mocks.installFn).toHaveBeenCalledWith(
      SKILL_ID,
      expect.objectContaining({ confirmed: true })
    )
    expect(mocks.confirmFn).not.toHaveBeenCalled()
    expect(mocks.spinner.succeed).toHaveBeenCalledWith('Skill installed')
  })

  it('-y is an alias for --yes', async () => {
    await run('-y')

    expect(mocks.installFn).toHaveBeenCalledWith(
      SKILL_ID,
      expect.objectContaining({ confirmed: true })
    )
  })

  it('without --yes, never sends a confirmed key on the first call', async () => {
    await run()

    const options = mocks.installFn.mock.calls[0]?.[1] as Record<string, unknown>
    expect('confirmed' in options).toBe(false)
  })

  it('non-TTY without --yes exits non-zero with a message naming --yes, and never prompts', async () => {
    mocks.installFn.mockResolvedValue(CONFIRMATION_REQUIRED)

    await run()

    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    expect(mocks.confirmFn).not.toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(1)
    expect(mocks.spinner.succeed).not.toHaveBeenCalled()
    const out = errorOutput()
    expect(out).toContain('--yes')
    expect(out).toContain('unverified')
    // core's API-flavoured wording is not shown to a CLI user
    expect(out).not.toContain('confirmed=true')
  })

  it('TTY answering yes retries once with confirmed: true', async () => {
    setTty(true)
    mocks.installFn.mockResolvedValueOnce(CONFIRMATION_REQUIRED).mockResolvedValueOnce(INSTALLED)
    mocks.confirmFn.mockResolvedValue(true)

    await run()

    expect(mocks.confirmFn).toHaveBeenCalledTimes(1)
    expect(mocks.confirmFn).toHaveBeenCalledWith(expect.objectContaining({ default: false }))
    expect(mocks.installFn).toHaveBeenCalledTimes(2)
    const first = mocks.installFn.mock.calls[0]?.[1] as Record<string, unknown>
    const second = mocks.installFn.mock.calls[1]?.[1] as Record<string, unknown>
    expect('confirmed' in first).toBe(false)
    expect(second['confirmed']).toBe(true)
    expect(mocks.spinner.succeed).toHaveBeenCalledWith('Skill installed')
    expect(mockExit).not.toHaveBeenCalled()
  })

  it('TTY answering no does not install and exits non-zero', async () => {
    setTty(true)
    mocks.installFn.mockResolvedValue(CONFIRMATION_REQUIRED)
    mocks.confirmFn.mockResolvedValue(false)

    await run()

    expect(mocks.confirmFn).toHaveBeenCalledTimes(1)
    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    expect(mocks.spinner.succeed).not.toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(1)
    expect(errorOutput()).toContain('cancelled')
  })

  it('--json never prompts, even on a TTY, and names --yes in the JSON error', async () => {
    setTty(true)
    mocks.installFn.mockResolvedValue(CONFIRMATION_REQUIRED)

    await run('--json')

    expect(mocks.confirmFn).not.toHaveBeenCalled()
    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    expect(mockExit).toHaveBeenCalledWith(1)
    const printed = mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(printed).toContain('--yes')
  })

  it('--yes with --skip-scan sends both flags and still reports core refusing the skip', async () => {
    mocks.installFn.mockResolvedValue({
      success: false,
      skillId: SKILL_ID,
      installPath: '/tmp/.claude/skills/low-star-skill',
      errorCode: 'SKIP_SCAN_FORBIDDEN',
      trustTier: 'unverified',
      error: 'skipScan is not allowed for unverified tier skills.',
    })

    await run('--yes', '--skip-scan')

    // --yes did not drop, rewrite, or imply skipScan: core sees both, decides itself.
    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    expect(mocks.installFn).toHaveBeenCalledWith(
      SKILL_ID,
      expect.objectContaining({ skipScan: true, confirmed: true })
    )
    expect(mocks.confirmFn).not.toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(1)
    expect(errorOutput()).toContain('skipScan is not allowed')
    expect(mocks.spinner.succeed).not.toHaveBeenCalled()
  })

  it('--skip-scan alone does not add confirmed', async () => {
    await run('--skip-scan')

    const options = mocks.installFn.mock.calls[0]?.[1] as Record<string, unknown>
    expect(options['skipScan']).toBe(true)
    expect('confirmed' in options).toBe(false)
  })
})
