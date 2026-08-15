/**
 * @fileoverview Tests for `skillsmith registry install <skillId>` — --client/SKILLSMITH_CLIENT
 * targeting, Edge Function error mapping (401/403/404/429), raw-content-never-leaks, and DB
 * lifecycle. Command registration, argument validation, not-logged-in, happy path, and --version
 * coverage live in the sibling `registry-install.action.test.ts` (split to stay under the repo's
 * 500-line file cap; both files duplicate this shared mock/fixture setup rather than sharing
 * `vi.mock()` declarations across files, since Vitest's mock hoisting is per-file).
 * @module @skillsmith/cli/commands/registry-install.action.leak-and-errors.test
 * @see SMI-5905 Wave 4
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
  // SMI-5893 (Wave 7 Step 4): real check against process.env — see the
  // sibling registry-install.action.test.ts for the full rationale.
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

const SKILL_CONTENT_MARKER = 'DO-NOT-LEAK-THIS-CONTENT-MARKER'

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
      content: { 'SKILL.md': `---\nname: internal-helper\n---\n${SKILL_CONTENT_MARKER}` },
      ...overrides,
    },
  }
}

function makeFetchErr(code: string, status: number, message = 'error') {
  return { ok: false as const, code, status, message }
}

// Mock console and process.exit
const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

describe('SMI-5905: `skillsmith registry install` command — errors, client targeting, leaks', () => {
  const originalClientEnv = process.env['SKILLSMITH_CLIENT']

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
    if (originalClientEnv === undefined) {
      delete process.env['SKILLSMITH_CLIENT']
    } else {
      process.env['SKILLSMITH_CLIENT'] = originalClientEnv
    }
  })

  // ==========================================================================
  // --client / SKILLSMITH_CLIENT targeting (SMI-5894)
  // ==========================================================================

  describe('--client / SKILLSMITH_CLIENT targeting', () => {
    it('uses --client when passed explicitly', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper', '--client', 'cursor'])

      expect(mocks.getInstallPath).toHaveBeenCalledWith('cursor')
    })

    it('falls back to SKILLSMITH_CLIENT when --client is not passed', async () => {
      process.env['SKILLSMITH_CLIENT'] = 'windsurf'

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mocks.getInstallPath).toHaveBeenCalledWith('windsurf')
    })

    it('defaults to claude-code when neither is set', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mocks.getInstallPath).toHaveBeenCalledWith('claude-code')
    })

    it('rejects an unknown --client value', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper', '--client', 'nonsense'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.getPrivateRegistrySkillContent).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Edge Function error mapping (401 / 403 / 404 / 429)
  // ==========================================================================

  describe('Edge Function error mapping', () => {
    it('401 unauthenticated → session-expired message', async () => {
      mocks.getPrivateRegistrySkillContent.mockResolvedValueOnce(
        makeFetchErr('unauthenticated', 401)
      )

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()
      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(errorOutput).toMatch(/session/i)
      expect(errorOutput).toContain('skillsmith login')
      expect(mocks.installFromContentFn).not.toHaveBeenCalled()
    })

    it('403 forbidden → Enterprise-subscription message', async () => {
      mocks.getPrivateRegistrySkillContent.mockResolvedValueOnce(makeFetchErr('forbidden', 403))

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()
      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(errorOutput).toMatch(/enterprise/i)
      expect(mocks.installFromContentFn).not.toHaveBeenCalled()
    })

    it('404 not_found → generic not-found message, no team-existence leak', async () => {
      mocks.getPrivateRegistrySkillContent.mockResolvedValueOnce(makeFetchErr('not_found', 404))

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()
      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(errorOutput).toMatch(/not found/i)
      // Must not imply anything about another team owning the skillId.
      expect(errorOutput.toLowerCase()).not.toContain('another team')
      expect(errorOutput.toLowerCase()).not.toContain('belongs to')
      expect(mocks.installFromContentFn).not.toHaveBeenCalled()
    })

    it('429 rate_limited → retry-shortly message', async () => {
      mocks.getPrivateRegistrySkillContent.mockResolvedValueOnce(makeFetchErr('rate_limited', 429))

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()
      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(errorOutput).toMatch(/rate limit/i)
    })

    it('--json emits a distinct errorCode per outcome', async () => {
      mocks.getPrivateRegistrySkillContent.mockResolvedValueOnce(makeFetchErr('forbidden', 403))

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()
      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper', '--json'])

      const jsonCalls = mockConsoleLog.mock.calls.filter((c) => {
        try {
          JSON.parse(c[0])
          return true
        } catch {
          return false
        }
      })
      expect(jsonCalls.length).toBeGreaterThan(0)
      const parsed = JSON.parse(jsonCalls[0]![0])
      expect(parsed.success).toBe(false)
      expect(parsed.errorCode).toBe('forbidden')
    })
  })

  // ==========================================================================
  // Content never leaks into output
  // ==========================================================================

  describe('raw content never appears in output', () => {
    it('does not print the fetched SKILL.md content on success', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      const allLogOutput = mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n')
      const allErrOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allLogOutput).not.toContain(SKILL_CONTENT_MARKER)
      expect(allErrOutput).not.toContain(SKILL_CONTENT_MARKER)
    })

    it('does not print the fetched SKILL.md content in --json output', async () => {
      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper', '--json'])

      const allLogOutput = mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allLogOutput).not.toContain(SKILL_CONTENT_MARKER)
    })

    it('does not print raw content even when the install itself fails', async () => {
      mocks.installFromContentFn.mockResolvedValueOnce({
        success: false,
        skillId: 'my-team/internal-helper',
        installPath: '',
        error: 'Invalid SKILL.md',
        errorCode: 'VALIDATION_FAILED',
      })

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()

      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      const allLogOutput = mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n')
      const allErrOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allLogOutput).not.toContain(SKILL_CONTENT_MARKER)
      expect(allErrOutput).not.toContain(SKILL_CONTENT_MARKER)
    })
  })

  // ==========================================================================
  // DB lifecycle
  // ==========================================================================

  describe('database lifecycle', () => {
    it('closes the database even when the Edge Function call fails', async () => {
      mocks.getPrivateRegistrySkillContent.mockResolvedValueOnce(makeFetchErr('not_found', 404))

      const { createRegistryInstallCommand } = await import('./registry-install.js')
      const cmd = createRegistryInstallCommand()
      await cmd.parseAsync(['node', 'test', 'my-team/internal-helper'])

      expect(mocks.dbClose).toHaveBeenCalled()
    })
  })
})
