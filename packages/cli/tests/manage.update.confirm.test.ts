/**
 * SMI-7056: `skillsmith update --yes` answers core's CONFIRMATION_REQUIRED gate.
 *
 * Updating an `unverified` skill force-installs it, so core's gate applies. This
 * suite stubs the diff/identity layers (covered by manage.update.test.ts) so it
 * pins only what `update` sends to install() and how it reacts to the result.
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
  guardFn: vi.fn(),
}))

vi.mock('ora', () => ({ default: () => mocks.spinner }))
vi.mock('@inquirer/prompts', () => ({
  confirm: (...args: unknown[]) => mocks.confirmFn(...args),
}))
vi.mock('../src/utils/open-database.js', () => ({
  openCliDatabase: vi.fn(async () => ({ close: vi.fn() })),
}))
vi.mock('../src/config.js', () => ({
  DEFAULT_MANIFEST_PATH: '/mock/manifest.json',
  DEFAULT_DB_PATH: '/mock/skills.db',
}))
vi.mock('@skillsmith/core/install', () => ({
  CANONICAL_CLIENT: 'claude-code',
  getInstallPath: () => '/mock/skills',
  removeLinks: vi.fn(),
  parseInstallScope: () => undefined,
  resolveClientId: () => 'claude-code',
  resolveScopedSkillsDir: () => ({
    scope: 'global',
    client: 'claude-code',
    dir: '/mock/skills',
    manifestPath: '/mock/manifest.json',
  }),
}))
vi.mock('@skillsmith/core', () => ({
  // SMI-6531: the install wrappers and the update prompt call this on entry;
  // no lock is held here unless a test makes it throw.
  assertSkillWriteLockNotHeld: (label: string) => mocks.guardFn(label),
  SkillRepository: vi.fn().mockImplementation(function () {
    return {}
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return {}
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return { install: mocks.installFn }
  }),
}))
vi.mock('../src/commands/install.js', () => ({
  createApiBackedRegistryLookup: vi.fn(async () => ({ lookup: vi.fn() })),
  VALID_CLIENT_HINT: 'Valid IDs: mock',
}))
vi.mock('../src/utils/skills-directory.js', () => ({
  getInstalledSkillsForClient: vi.fn(async () => []),
}))
vi.mock('../src/commands/manage.update.identity.js', () => ({
  classifyManifestEntryForUpdate: vi.fn(async () => ({ kind: 'safe' })),
  buildUpdateSkipReason: vi.fn(() => 'unsafe'),
  isUnsafeToForceInstall: vi.fn(() => false),
}))
vi.mock('../src/commands/manage.update.helpers.js', () => ({
  installedViaFor: vi.fn(() => 'claude-code'),
  getSkillDiff: vi.fn(async () => ({
    skillId: 'someone/low-star-skill',
    changes: ['Version: 1.0.0 -> 2.0.0'],
    installedPath: '/mock/skills/low-star-skill',
    currentEntry: {},
    resolvedRegistryRecord: {},
  })),
}))

const CONFIRMATION_REQUIRED = {
  success: false,
  skillId: 'someone/low-star-skill',
  installPath: '/mock/skills/low-star-skill',
  errorCode: 'CONFIRMATION_REQUIRED',
  trustTier: 'unverified',
  requiresConfirmation: true,
  confirmationReason:
    'This skill is in the "unverified" trust tier. Skills in this tier have not been reviewed. ' +
    'Re-run with confirmed=true to proceed.',
}

const UPDATED = { success: true, skillId: 'someone/low-star-skill', installPath: '/mock/x' }

const ttyDescriptors = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
}

function setTty(isTty: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTty, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true })
}

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

describe('SMI-7056: update confirmation path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.installFn.mockResolvedValue(UPDATED)
    // The pre-existing "Update <skill>?" prompt answers yes by default.
    mocks.confirmFn.mockResolvedValue(true)
    setTty(false)
  })

  afterEach(() => {
    mocks.guardFn.mockReset() // a throwing guard must not leak into later tests
    for (const [stream, key] of [
      [process.stdin, 'stdin'],
      [process.stdout, 'stdout'],
    ] as const) {
      const original = ttyDescriptors[key]
      if (original) Object.defineProperty(stream, 'isTTY', original)
      else delete (stream as { isTTY?: boolean }).isTTY
    }
  })

  it('--yes (yes=true) passes confirmed: true alongside force and expectedInstallPath', async () => {
    const { updateSkillWithOutcome } = await import('../src/commands/manage.update.js')

    const result = await updateSkillWithOutcome(
      'low-star-skill',
      '/fake/db',
      false,
      undefined,
      undefined,
      true
    )

    expect(result.outcome).toBe('updated')
    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    expect(mocks.installFn).toHaveBeenCalledWith('someone/low-star-skill', {
      force: true,
      expectedInstallPath: '/mock/skills/low-star-skill',
      confirmed: true,
    })
  })

  it('--yes with no terminal never prompts, including the "Update <skill>?" prompt', async () => {
    // Off a TTY a real prompt throws; make any call fail loudly.
    mocks.confirmFn.mockRejectedValue(
      Object.assign(new Error('prompt needs a TTY'), { name: 'ExitPromptError' })
    )
    const { updateSkillWithOutcome } = await import('../src/commands/manage.update.js')

    const result = await updateSkillWithOutcome(
      'low-star-skill',
      '/fake/db',
      false,
      undefined,
      undefined,
      true
    )

    expect(mocks.confirmFn).not.toHaveBeenCalled()
    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('updated')
  })

  it('without --yes the options carry no confirmed key (existing shape preserved)', async () => {
    const { updateSkillWithOutcome } = await import('../src/commands/manage.update.js')

    await updateSkillWithOutcome('low-star-skill', '/fake/db')

    expect(mocks.installFn).toHaveBeenCalledWith('someone/low-star-skill', {
      force: true,
      expectedInstallPath: '/mock/skills/low-star-skill',
    })
  })

  it('non-TTY without --yes fails the update with a message naming --yes', async () => {
    mocks.installFn.mockResolvedValue(CONFIRMATION_REQUIRED)
    const { updateSkillWithOutcome } = await import('../src/commands/manage.update.js')

    const result = await updateSkillWithOutcome('low-star-skill', '/fake/db')

    expect(result.outcome).toBe('failed')
    expect(result.reason).toContain('--yes')
    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    // Only the pre-existing "Update <skill>?" prompt ran; no trust-tier prompt.
    expect(mocks.confirmFn).toHaveBeenCalledTimes(1)
  })

  it('TTY answering yes to the trust-tier prompt retries with confirmed: true', async () => {
    setTty(true)
    mocks.installFn.mockResolvedValueOnce(CONFIRMATION_REQUIRED).mockResolvedValueOnce(UPDATED)
    const { updateSkillWithOutcome } = await import('../src/commands/manage.update.js')

    const result = await updateSkillWithOutcome('low-star-skill', '/fake/db')

    expect(result.outcome).toBe('updated')
    expect(mocks.confirmFn).toHaveBeenCalledTimes(2)
    expect(mocks.installFn).toHaveBeenCalledTimes(2)
    expect(mocks.installFn.mock.calls[1]?.[1]).toEqual({
      force: true,
      expectedInstallPath: '/mock/skills/low-star-skill',
      confirmed: true,
    })
  })

  it('TTY answering no to the trust-tier prompt cancels the update (not a failure)', async () => {
    setTty(true)
    mocks.installFn.mockResolvedValue(CONFIRMATION_REQUIRED)
    mocks.confirmFn.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { updateSkillWithOutcome } = await import('../src/commands/manage.update.js')

    const result = await updateSkillWithOutcome('low-star-skill', '/fake/db')

    expect(mocks.installFn).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('cancelled')
    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(printed).toContain('Update cancelled: unverified-tier skill was not confirmed.')
    expect(printed).not.toContain('Install cancelled')
  })

  it('updateSkills threads yes into every per-skill install', async () => {
    const { updateSkills } = await import('../src/commands/manage.update.js')

    await updateSkills(['low-star-skill'], '/fake/db', false, undefined, undefined, true)

    expect(mocks.installFn).toHaveBeenCalledWith(
      'someone/low-star-skill',
      expect.objectContaining({ confirmed: true })
    )
  })

  it('SMI-6531 T-L10: the "Update <skill>?" prompt is guarded, and a held lock stops it before any prompt or install', async () => {
    const { updateSkillWithOutcome } = await import('../src/commands/manage.update.js')

    await updateSkillWithOutcome('low-star-skill', '/fake/db')
    expect(mocks.guardFn).toHaveBeenCalledWith('prompt: update confirmation')

    vi.clearAllMocks()
    mocks.installFn.mockResolvedValue(UPDATED)
    mocks.confirmFn.mockResolvedValue(true)
    mocks.guardFn.mockImplementation((label: string) => {
      if (label === 'prompt: update confirmation') throw new Error('skills-root lock held')
    })

    const outcome = await updateSkillWithOutcome('low-star-skill', '/fake/db').catch(
      (e: unknown) => e
    )

    expect(mocks.confirmFn).not.toHaveBeenCalled()
    expect(mocks.installFn).not.toHaveBeenCalled()
    expect(outcome).not.toEqual(expect.objectContaining({ outcome: 'updated' }))
  })

  it('the update command registers --yes / -y', async () => {
    const { createUpdateCommand } = await import('../src/commands/manage.js')
    const opt = createUpdateCommand().options.find((o) => o.long === '--yes')
    expect(opt?.short).toBe('-y')
  })

  it('`update <skill> --yes` reaches install() as confirmed: true via the commander action', async () => {
    const { createUpdateCommand } = await import('../src/commands/manage.js')

    await createUpdateCommand().parseAsync(['node', 'test', 'low-star-skill', '--yes'])

    expect(mocks.installFn).toHaveBeenCalledWith(
      'someone/low-star-skill',
      expect.objectContaining({ confirmed: true })
    )
  })
})
