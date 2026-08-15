/**
 * @fileoverview Tests for `skillsmith registry install <skillId>` — registration, argument
 * validation, not-logged-in, happy path, and --version. Client-targeting, Edge Function error
 * mapping, content-leak, and DB-lifecycle coverage live in the sibling
 * `registry-install.action.leak-and-errors.test.ts` (split to stay under the repo's 500-line file
 * cap; both files duplicate this shared mock/fixture setup rather than sharing `vi.mock()`
 * declarations across files, since Vitest's mock hoisting is per-file).
 * @module @skillsmith/cli/commands/registry-install.action.test
 * @see SMI-5905 Wave 4
 *
 * Mocking strategy mirrors packages/cli/src/commands/inventory.action.test.ts
 * (telemetry passthrough, @skillsmith/core mocked with vi.hoisted state) and
 * packages/cli/tests/unit/commands/install.test.ts (createDatabaseAsync /
 * initializeSchema mocked so the real openCliDatabase() helper still runs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { SkillInstallationService } from '@skillsmith/core'

const mocks = vi.hoisted(() => ({
  spinner: {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  },
  installFromContentFn: vi.fn(),
  createDatabaseAsync: vi.fn(),
  initializeSchema: vi.fn(),
  dbClose: vi.fn(),
  emitInstallEvent: vi.fn(async (_payload: unknown) => undefined),
  getPrivateRegistrySkillContent: vi.fn(),
  resolveFreshAccessToken: vi.fn(),
  getInstallPath: vi.fn((client: string) => `/mock/skills-for-${client}`),
  validClientIds: [
    'claude-code',
    'cursor',
    'copilot',
    'windsurf',
    'agents',
    'opencode',
    'hermes',
    'grok',
  ],
}))

vi.mock('ora', () => ({
  default: () => mocks.spinner,
}))

vi.mock('@skillsmith/core/telemetry', () => ({
  withTelemetry: <TArgs extends readonly unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn> | TReturn
  ) => fn,
}))

vi.mock('@skillsmith/core', () => ({
  createDatabaseAsync: (...args: unknown[]) => mocks.createDatabaseAsync(...args),
  initializeSchema: (...args: unknown[]) => mocks.initializeSchema(...args),
  isCorruptionError: () => false,
  backupCorruptDbFile: vi.fn(),
  SkillRepository: vi.fn().mockImplementation(function () {
    return {
      findById: vi.fn(() => null),
      findAll: vi.fn(() => ({ items: [], total: 0, limit: 1000, offset: 0, hasMore: false })),
    }
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return { clearAll: vi.fn() }
  }),
  QuarantineRepository: vi.fn().mockImplementation(function () {
    return { isQuarantined: vi.fn(() => false) }
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return { installFromContent: mocks.installFromContentFn }
  }),
  SkillsmithApiClient: Object.assign(vi.fn(), {
    toSkill: (r: { trust_tier?: string }) => ({ trustTier: r.trust_tier ?? 'community' }),
  }),
  createApiClient: vi.fn(() => ({ isOffline: () => true, getSkill: vi.fn() })),
  loadStoredAccessToken: vi.fn().mockResolvedValue(null),
  isGitHubUrl: vi.fn(() => false),
  emitInstallEvent: (payload: unknown) => mocks.emitInstallEvent(payload),
  getPrivateRegistrySkillContent: (...args: unknown[]) =>
    mocks.getPrivateRegistrySkillContent(...args),
  resolveFreshAccessToken: () => mocks.resolveFreshAccessToken(),
  // SMI-5893 (Wave 7 Step 4): real check against process.env so the
  // `opts.quiet ?? isQuietModeEnabled()` fallback (added alongside the CLI's
  // new root-level --quiet, which claims the LONG-form `--quiet` token ahead
  // of this command's own local `-q, --quiet`) is exercised faithfully.
  isQuietModeEnabled: () =>
    process.env['SKILLSMITH_QUIET']?.toLowerCase() === 'true' ||
    process.env['SKILLSMITH_QUIET'] === '1',
}))

vi.mock('@skillsmith/core/install', () => ({
  // packages/cli/src/config.ts calls this at module-load time for
  // DEFAULT_SKILLS_DIR — required even though this suite never asserts on it.
  getCanonicalInstallPath: vi.fn(() => '/mock/default-skills-dir'),
  getInstallPath: (client: string) => mocks.getInstallPath(client),
  resolveClientId: (raw: string | undefined) => {
    if (raw === undefined || raw === '') return 'claude-code'
    if (!mocks.validClientIds.includes(raw)) {
      throw new Error(`Invalid client '${raw}'. Valid: ${mocks.validClientIds.join(', ')}.`)
    }
    return raw
  },
}))

function makeFetchOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      skill_id: 'my-team/internal-helper',
      team_id: 'team-123',
      version: '1.0.0',
      description: null,
      content_hash: 'hash123',
      deprecated: false,
      published_at: '2026-07-01T00:00:00.000Z',
      content: { 'SKILL.md': '---\nname: internal-helper\n---\nhi' },
      ...overrides,
    },
  }
}

// Mock console and process.exit
const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

describe('SMI-5905: `skillsmith registry install` command — registration and happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    console.error = mockConsoleError
    delete process.env['SKILLSMITH_CLIENT']

    const mockDb = { close: mocks.dbClose }
    mocks.createDatabaseAsync.mockResolvedValue(mockDb)
    mocks.resolveFreshAccessToken.mockResolvedValue('user-jwt-token')
    mocks.getPrivateRegistrySkillContent.mockResolvedValue(makeFetchOk())
    mocks.installFromContentFn.mockResolvedValue({
      success: true,
      skillId: 'my-team/internal-helper',
      installPath: '/mock/skills-for-claude-code/internal-helper',
      trustTier: 'community',
    })
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
  })

  // ==========================================================================
  // Command registration
  // ==========================================================================

  describe('command registration', () => {
    it('registers `registry install` as a subcommand of `registry`', async () => {
      const { createRegistryCommand } = await import('./registry-install.js')
      const registry = createRegistryCommand()

      expect(registry).toBeInstanceOf(Command)
      expect(registry.name()).toBe('registry')
      const install = registry.commands.find((c) => c.name() === 'install')
      expect(install).toBeDefined()
    })

    it('has --version, --force, --json, --db, --client options', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      expect(cmd.options.find((o) => o.long === '--version')).toBeDefined()
      expect(cmd.options.find((o) => o.long === '--force' && o.short === '-f')).toBeDefined()
      expect(cmd.options.find((o) => o.long === '--json')).toBeDefined()
      expect(cmd.options.find((o) => o.long === '--db' && o.short === '-d')).toBeDefined()
      expect(cmd.options.find((o) => o.long === '--client')).toBeDefined()
    })

    it('requires a skillId argument', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.required).toBe(true)
    })
  })

  // ==========================================================================
  // Argument validation
  // ==========================================================================

  describe('skillId validation', () => {
    it('rejects a bare name with no author prefix, without calling the Edge Function', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'no-author-name'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.getPrivateRegistrySkillContent).not.toHaveBeenCalled()
    })

    // SMI-5905 Sol final-code-review finding #1: "." / ".." segments must be rejected locally
    // too, matching the Edge Function's own tightened SKILL_ID_PATTERN check.
    it.each(['acme/..', 'acme/.', '../acme'])(
      'rejects skillId "%s" (unsafe path segment), without calling the Edge Function',
      async (skillId) => {
        const { createRegistryInstallCommand } = await import('./registry-install.js')
        const cmd = createRegistryInstallCommand()

        await cmd.parseAsync(['node', 'test', skillId])

        expect(mockExit).toHaveBeenCalledWith(1)
        expect(mocks.getPrivateRegistrySkillContent).not.toHaveBeenCalled()
      }
    )
  })

  // ==========================================================================
  // Not logged in
  // ==========================================================================

  describe('not logged in', () => {
    it('shows a clear error and never calls the Edge Function', async () => {
      mocks.resolveFreshAccessToken.mockResolvedValueOnce(null)

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.getPrivateRegistrySkillContent).not.toHaveBeenCalled()
      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(errorOutput).toContain('Not logged in')
      expect(errorOutput).toContain('skillsmith login')
    })
  })

  // ==========================================================================
  // Happy path
  // ==========================================================================

  describe('happy path', () => {
    it('fetches content, installs via installFromContent(), and shows success', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mocks.getPrivateRegistrySkillContent).toHaveBeenCalledWith(
        expect.objectContaining({ jwtToken: 'user-jwt-token', skillId: 'my-team/internal-helper' })
      )
      expect(mocks.installFromContentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: 'my-team/internal-helper',
          version: '1.0.0',
          content: expect.objectContaining({ 'SKILL.md': expect.any(String) }),
        })
      )
      expect(mocks.spinner.succeed).toHaveBeenCalledWith('Skill installed')
      expect(mocks.dbClose).toHaveBeenCalled()
      expect(mockExit).not.toHaveBeenCalledWith(1)
    })

    // SMI-5982 PR-review follow-up: resolveCompanionAgentPath() no longer defaults a missing
    // baseDir to process.cwd() itself (directory-package mode now requires it explicitly), so
    // every SkillInstallationService construction site must pass companionBaseDir explicitly to
    // preserve this CLI command's existing cwd-relative behavior.
    it('constructs SkillInstallationService with companionBaseDir: process.cwd()', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(SkillInstallationService).toHaveBeenCalledWith(
        expect.objectContaining({ companionBaseDir: process.cwd() })
      )
    })

    it('passes --force through to installFromContent()', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper', '--force'])

      expect(mocks.installFromContentFn).toHaveBeenCalledWith(
        expect.objectContaining({ force: true })
      )
    })

    it('emits install telemetry with source cli on success', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mocks.emitInstallEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: 'my-team/internal-helper',
          source: 'cli',
          success: true,
          trustTier: 'community',
        })
      )
    })
  })

  // ==========================================================================
  // SMI-5893 (Wave 7 Step 4): isQuietModeEnabled() fallback
  //
  // The CLI's new root-level --quiet (packages/cli/src/index.ts) claims the
  // LONG-form `--quiet` token ahead of this command's own local
  // `-q, --quiet` whenever both are registered on the same composed
  // program, leaving `opts.quiet` undefined here even though the user asked
  // for quiet output. `opts.quiet ?? isQuietModeEnabled()` is the fallback
  // that keeps this command quiet in that case, via the SKILLSMITH_QUIET
  // env var root's preAction hook sets. This isolates that fallback
  // directly (no --quiet/-q flag passed at all) rather than reproducing the
  // full root-collision, since this suite runs createRegistryInstallCommand()
  // standalone, outside the composed root program.
  // ==========================================================================

  describe('isQuietModeEnabled() fallback', () => {
    const ORIGINAL_SKILLSMITH_QUIET = process.env['SKILLSMITH_QUIET']

    afterEach(() => {
      if (ORIGINAL_SKILLSMITH_QUIET === undefined) {
        delete process.env['SKILLSMITH_QUIET']
      } else {
        process.env['SKILLSMITH_QUIET'] = ORIGINAL_SKILLSMITH_QUIET
      }
    })

    it('suppresses advisory tips via SKILLSMITH_QUIET even without --quiet/-q', async () => {
      process.env['SKILLSMITH_QUIET'] = 'true'
      mocks.installFromContentFn.mockResolvedValue({
        success: true,
        skillId: 'my-team/internal-helper',
        installPath: '/mock/skills-for-claude-code/internal-helper',
        trustTier: 'community',
        tips: ['Tip: Use the skill by invoking /internal-helper'],
      })

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      const allOutput = mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allOutput).not.toContain('Tip:')
    })
  })

  // ==========================================================================
  // --version flag
  // ==========================================================================

  describe('--version flag', () => {
    it('forwards --version to getPrivateRegistrySkillContent()', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper', '--version', '2.3.4'])

      expect(mocks.getPrivateRegistrySkillContent).toHaveBeenCalledWith(
        expect.objectContaining({ version: '2.3.4' })
      )
    })

    it('omits version from the call when --version is not passed', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      const call = mocks.getPrivateRegistrySkillContent.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >
      expect(call).toBeDefined()
      expect('version' in call).toBe(false)
    })
  })
})
