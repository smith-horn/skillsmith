/**
 * SMI-3484: CLI Install Command Tests (Wave 1)
 *
 * Tests for the install command that installs skills from registry/GitHub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
// SMI-5427: mocked at runtime via vi.mock('@skillsmith/core') below; the real
// type is preserved for the GAP-07 regression block (no cast on the instance).
import { SkillRepository, type DatabaseType } from '@skillsmith/core'

// ============================================================================
// Mock Setup - Must be before imports
// ============================================================================

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
  createDatabaseAsync: vi.fn(),
  initializeSchema: vi.fn(),
  dbClose: vi.fn(),
  // SMI-4795: hoisted so tests can assert install-telemetry payloads.
  emitInstallEvent: vi.fn(async (_payload: unknown) => undefined),
  // SMI-5427: hoisted so the createApiBackedRegistryLookup API-fallback path is
  // exercisable. Default offline (() => true) keeps existing install tests on the
  // local-only path; the GAP-07 regression tests flip it per-call with
  // mockReturnValueOnce so there is no cross-test leak.
  apiIsOffline: vi.fn(() => true),
  apiGetSkill: vi.fn(),
}))

vi.mock('ora', () => ({
  default: () => mocks.spinner,
}))

vi.mock('@skillsmith/core', () => ({
  createDatabaseAsync: (...args: unknown[]) => mocks.createDatabaseAsync(...args),
  initializeSchema: (...args: unknown[]) => mocks.initializeSchema(...args),
  SkillRepository: vi.fn().mockImplementation(function () {
    return {
      findById: vi.fn(() => null),
      findAll: vi.fn(() => ({ items: [], total: 0, limit: 1000, offset: 0, hasMore: false })),
    }
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return {
      clearAll: vi.fn(),
    }
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return {
      install: mocks.installFn,
    }
  }),
  // SMI-5427: createApiBackedRegistryLookup calls these. Default offline (via the
  // hoisted apiIsOffline) skips the API fallback so existing install tests are
  // unaffected; the GAP-07 regression tests flip apiIsOffline + apiGetSkill to
  // drive the remote path. SkillsmithApiClient.toSkill must be a real static.
  QuarantineRepository: vi.fn().mockImplementation(function () {
    return { isQuarantined: vi.fn(() => false) }
  }),
  SkillsmithApiClient: Object.assign(vi.fn(), {
    toSkill: (r: { trust_tier?: string }) => ({ trustTier: r.trust_tier ?? 'community' }),
  }),
  loadStoredAccessToken: vi.fn().mockResolvedValue(null),
  createApiClient: vi.fn(() => ({
    isOffline: mocks.apiIsOffline,
    getSkill: mocks.apiGetSkill,
  })),
  isGitHubUrl: vi.fn((url: string) => url.startsWith('https://github.com/')),
  emitInstallEvent: (payload: unknown) => mocks.emitInstallEvent(payload),
}))

// Mock console and process.exit
const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

// ============================================================================
// Tests
// ============================================================================

describe('SMI-3484: CLI Install Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    console.error = mockConsoleError

    // Default: database opens and closes successfully
    const mockDb = { close: mocks.dbClose }
    mocks.createDatabaseAsync.mockResolvedValue(mockDb)

    // Default: install succeeds
    mocks.installFn.mockResolvedValue({
      success: true,
      skillId: 'community/jest-helper',
      installPath: '/tmp/.claude/skills/jest-helper',
      trustTier: 'community',
    })
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
  })

  // ==========================================================================
  // Command Registration
  // ==========================================================================

  describe('command registration', () => {
    it('should create a Command instance named "install"', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('install')
    })

    it('should have a description mentioning install', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      expect(cmd.description().toLowerCase()).toContain('install')
    })

    it('should have --force option with short flag -f', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const forceOpt = cmd.options.find((o) => o.short === '-f')
      expect(forceOpt).toBeDefined()
      expect(forceOpt?.long).toBe('--force')
    })

    it('should have --skip-scan option', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.long === '--skip-scan')
      expect(opt).toBeDefined()
    })

    it('should have --skip-optimize option', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.long === '--skip-optimize')
      expect(opt).toBeDefined()
    })

    it('should have --quiet option with short flag -q', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.short === '-q')
      expect(opt).toBeDefined()
      expect(opt?.long).toBe('--quiet')
    })

    it('should have --json option', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.long === '--json')
      expect(opt).toBeDefined()
    })

    it('should have --db option with short flag -d', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const opt = cmd.options.find((o) => o.short === '-d')
      expect(opt).toBeDefined()
      expect(opt?.long).toBe('--db')
    })

    it('should require a skillId argument', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      expect(cmd.registeredArguments.length).toBe(1)
      expect(cmd.registeredArguments[0]?.required).toBe(true)
    })
  })

  // ==========================================================================
  // Argument Parsing
  // ==========================================================================

  describe('argument parsing', () => {
    it('should accept valid author/name format', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.installFn).toHaveBeenCalledWith('community/jest-helper', expect.any(Object))
    })

    it('should accept GitHub URL', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      const url = 'https://github.com/owner/repo'
      await cmd.parseAsync(['node', 'test', url])

      expect(mocks.installFn).toHaveBeenCalledWith(url, expect.any(Object))
    })

    it('should reject bare name without author prefix', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'jest-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('should reject invalid format with multiple slashes', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'a/b/c'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('should reject empty author segment', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', '/name'])

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mocks.installFn).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Happy Path
  // ==========================================================================

  describe('happy path', () => {
    it('should install a skill and show success', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.spinner.succeed).toHaveBeenCalledWith('Skill installed')
      expect(mocks.dbClose).toHaveBeenCalled()
    })

    it('should pass --force option to install service', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--force'])

      expect(mocks.installFn).toHaveBeenCalledWith(
        'community/jest-helper',
        expect.objectContaining({ force: true })
      )
    })

    it('should pass --skip-scan option to install service', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--skip-scan'])

      expect(mocks.installFn).toHaveBeenCalledWith(
        'community/jest-helper',
        expect.objectContaining({ skipScan: true })
      )
    })

    it('should pass --skip-optimize option to install service', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--skip-optimize'])

      expect(mocks.installFn).toHaveBeenCalledWith(
        'community/jest-helper',
        expect.objectContaining({ skipOptimize: true })
      )
    })

    it('should close database after successful install', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.dbClose).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Already Installed
  // ==========================================================================

  describe('already installed', () => {
    it('should fail when skill is already installed', async () => {
      mocks.installFn.mockResolvedValue({
        success: false,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
        error: 'Skill "jest-helper" is already installed. Use force=true to reinstall.',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.spinner.fail).toHaveBeenCalledWith('Installation failed')
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should succeed with --force when already installed', async () => {
      mocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--force'])

      expect(mocks.installFn).toHaveBeenCalledWith(
        'community/jest-helper',
        expect.objectContaining({ force: true })
      )
      expect(mocks.spinner.succeed).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // --quiet Flag
  // ==========================================================================

  describe('--quiet flag', () => {
    it('should suppress advisory output when --quiet is set', async () => {
      mocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
        tips: ['Tip: Use the skill by invoking /jest-helper'],
        optimization: {
          optimized: true,
          tokenReductionPercent: 30,
          subSkills: ['sub1.md'],
        },
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--quiet'])

      // Tips and optimization info should be suppressed
      const allOutput = mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allOutput).not.toContain('Tip:')
      expect(allOutput).not.toContain('reduction')
    })

    it('should still show security-critical errors when --quiet is set', async () => {
      mocks.installFn.mockResolvedValue({
        success: false,
        skillId: 'community/dangerous-skill',
        installPath: '',
        error: 'Security scan failed with 2 critical/high findings',
        securityReport: {
          passed: false,
          riskScore: 85,
          findings: [{ severity: 'critical', message: 'Dangerous command execution detected' }],
        },
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/dangerous-skill', '--quiet'])

      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(errorOutput).toContain('Security scan failed')
    })
  })

  // ==========================================================================
  // --json Flag
  // ==========================================================================

  describe('--json flag', () => {
    it('should output structured JSON on success', async () => {
      mocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
        trustTier: 'community',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--json'])

      // Find the JSON output call
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
      expect(parsed.success).toBe(true)
      expect(parsed.skillId).toBe('community/jest-helper')
      expect(parsed.installPath).toBe('/tmp/.claude/skills/jest-helper')
    })

    it('should output structured JSON on failure', async () => {
      mocks.installFn.mockResolvedValue({
        success: false,
        skillId: 'community/missing',
        installPath: '',
        error: 'Skill not found',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/missing', '--json'])

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
      expect(parsed.error).toBe('Skill not found')
    })

    it('should output JSON for invalid format errors', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'invalid', '--json'])

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
      expect(parsed.error).toContain('Invalid skill ID format')
    })

    it('should not show spinner when --json is set', async () => {
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper', '--json'])

      // Spinner should not be started in JSON mode
      expect(mocks.spinner.start).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('error handling', () => {
    it('should exit with code 1 on install failure', async () => {
      mocks.installFn.mockResolvedValue({
        success: false,
        skillId: 'community/missing',
        installPath: '',
        error: 'Skill not found',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/missing'])

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should handle database connection errors', async () => {
      mocks.createDatabaseAsync.mockRejectedValue(new Error('Database locked'))

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should sanitize error messages', async () => {
      mocks.createDatabaseAsync.mockRejectedValue(new Error('Error at /Users/testuser/secret/path'))

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      const errorOutput = mockConsoleError.mock.calls.map((c) => c.join(' ')).join(' ')
      expect(errorOutput).not.toContain('/Users/testuser/')
    })

    it('should close database even on error', async () => {
      mocks.installFn.mockRejectedValue(new Error('Unexpected error'))

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()

      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.dbClose).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // SMI-4795: install telemetry must thread errorCode + trustTier
  //
  // CLI emit site previously forwarded only {skillId, source, success,
  // durationMs}. After SMI-4795 trustTier is included on every event (when
  // the service surfaces it) and errorCode is included only on failures.
  // ==========================================================================

  describe('SMI-4795: emitInstallEvent receives errorCode + trustTier', () => {
    interface TelemetryPayload {
      skillId: string
      source: string
      success: boolean
      durationMs?: number
      trustTier?: string
      errorCode?: string
    }

    function getEmittedPayload(): TelemetryPayload {
      const calls = mocks.emitInstallEvent.mock.calls as unknown as Array<[unknown]>
      expect(calls.length).toBeGreaterThan(0)
      const firstCall = calls[0]
      expect(firstCall).toBeDefined()
      const payload = (firstCall as [unknown])[0] as TelemetryPayload
      expect(payload).toBeDefined()
      return payload
    }

    it('forwards trustTier and errorCode on a failed install', async () => {
      mocks.installFn.mockResolvedValueOnce({
        success: false,
        skillId: 'community/jest-helper',
        installPath: '/tmp/.claude/skills/jest-helper',
        errorCode: 'SCAN_REJECTED',
        trustTier: 'community',
        error: 'Security scan failed',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()
      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.emitInstallEvent).toHaveBeenCalledTimes(1)
      const payload = getEmittedPayload()
      expect(payload).toMatchObject({
        skillId: 'community/jest-helper',
        source: 'cli',
        success: false,
        errorCode: 'SCAN_REJECTED',
        trustTier: 'community',
      })
      expect(typeof payload.durationMs).toBe('number')
    })

    it('forwards trustTier on success but omits errorCode', async () => {
      // Default beforeEach already returns success+trustTier:'community'.
      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()
      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.emitInstallEvent).toHaveBeenCalledTimes(1)
      const payload = getEmittedPayload()
      expect(payload).toMatchObject({
        skillId: 'community/jest-helper',
        source: 'cli',
        success: true,
        trustTier: 'community',
      })
      expect(payload.errorCode).toBeUndefined()
    })

    it('omits both fields when service result lacks them', async () => {
      mocks.installFn.mockResolvedValueOnce({
        success: false,
        skillId: 'community/jest-helper',
        installPath: '',
        error: 'legacy failure',
      })

      const { createInstallCommand } = await import('../../../src/commands/install.js')
      const cmd = createInstallCommand()
      await cmd.parseAsync(['node', 'test', 'community/jest-helper'])

      expect(mocks.emitInstallEvent).toHaveBeenCalledTimes(1)
      const payload = getEmittedPayload()
      expect(payload.errorCode).toBeUndefined()
      expect(payload.trustTier).toBeUndefined()
      expect(payload.success).toBe(false)
    })
  })
})

// ============================================================================
// SMI-5427 GAP-07: createApiBackedRegistryLookup must honor the quarantine flag
// returned by the remote skills-get API. skills-get does NOT filter quarantined
// skills (it returns them with quarantined:true / installable:false), so the
// API-fallback path must surface quarantined:true rather than hardcoding false —
// otherwise `install <quarantined-id>` on an empty local DB would BYPASS the
// quarantine block that the local QuarantineRepository path enforces.
// ============================================================================

describe('SMI-5427: createApiBackedRegistryLookup honors remote quarantine (GAP-07)', () => {
  // findById -> null (mock default) so the local lookup misses and the API
  // fallback runs. Per-test mockReturnValueOnce/mockResolvedValueOnce so neither
  // the offline flag nor the API response leaks across tests.
  const minimalDb = {} as unknown as DatabaseType

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks a quarantined remote skill as quarantined (does not bypass the block)', async () => {
    const { createApiBackedRegistryLookup } = await import('../../../src/commands/install.js')
    const skillRepo = new SkillRepository(minimalDb)

    mocks.apiIsOffline.mockReturnValueOnce(false)
    mocks.apiGetSkill.mockResolvedValueOnce({
      data: {
        repo_url: 'https://github.com/acme/evil-skill',
        name: 'evil-skill',
        trust_tier: 'community',
        quarantined: true,
        installable: false,
      },
    })

    const lookup = await createApiBackedRegistryLookup(skillRepo, minimalDb)
    const result = await lookup.lookup('acme/evil-skill')

    expect(mocks.apiGetSkill).toHaveBeenCalledWith('acme/evil-skill')
    expect(result).not.toBeNull()
    expect(result?.quarantined).toBe(true)
    expect(result?.repoUrl).toBe('https://github.com/acme/evil-skill')
  })

  it('marks a healthy remote skill as installable (quarantined:false)', async () => {
    const { createApiBackedRegistryLookup } = await import('../../../src/commands/install.js')
    const skillRepo = new SkillRepository(minimalDb)

    mocks.apiIsOffline.mockReturnValueOnce(false)
    mocks.apiGetSkill.mockResolvedValueOnce({
      data: {
        repo_url: 'https://github.com/acme/good-skill',
        name: 'good-skill',
        trust_tier: 'verified',
        quarantined: false,
        installable: true,
      },
    })

    const lookup = await createApiBackedRegistryLookup(skillRepo, minimalDb)
    const result = await lookup.lookup('acme/good-skill')

    expect(result).not.toBeNull()
    expect(result?.quarantined).toBe(false)
    expect(result?.repoUrl).toBe('https://github.com/acme/good-skill')
    expect(result?.trustTier).toBe('verified')
  })
})
