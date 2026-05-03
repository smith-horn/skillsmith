/**
 * @fileoverview SMI-4590 Step 0a — `sklx audit` restructure tests
 * @module @skillsmith/cli/tests/audit-restructure
 *
 * Asserts the parent `audit` command surface:
 * - `sklx audit advisories` is registered as a subcommand.
 * - `sklx audit <skill-id>` (positional fallback) emits the deprecation
 *   warning and forwards to the same advisories handler.
 * - `sklx audit` with no args prints parent help.
 *
 * Behavioral coverage of `runAdvisoriesAudit` itself stays under
 * `audit.ts`'s existing test surface — these tests verify the wiring only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ============================================================================
// Mock setup — must precede source imports so commander.action() bodies see
// the mocked deps when they execute.
// ============================================================================

const mocks = vi.hoisted(() => ({
  requireTier: vi.fn(async (_tier: string): Promise<void> => undefined),
  createDatabaseAsync: vi.fn(
    async (_path: string): Promise<{ close: () => void }> => ({
      close: () => undefined,
    })
  ),
  initializeSchema: vi.fn((_db: unknown): void => undefined),
  AdvisoryRepositoryCtor: vi.fn((_db: unknown): void => undefined),
  getActiveAdvisories: vi.fn((): unknown[] => []),
}))

vi.mock('@skillsmith/core', () => ({
  createDatabaseAsync: (path: string) => mocks.createDatabaseAsync(path),
  initializeSchema: (db: unknown) => mocks.initializeSchema(db),
  AdvisoryRepository: function AdvisoryRepository(this: unknown, db: unknown) {
    mocks.AdvisoryRepositoryCtor(db)
    ;(this as { getActiveAdvisories: () => unknown[] }).getActiveAdvisories =
      mocks.getActiveAdvisories
  },
}))

vi.mock('../src/utils/require-tier.js', () => ({
  requireTier: (tier: string) => mocks.requireTier(tier),
}))

import {
  createAuditCommand,
  createAuditAdvisoriesSubcommand,
  AUDIT_FLAT_DEPRECATION_NOTICE,
} from '../src/commands/audit.js'

// ============================================================================
// Test helpers
// ============================================================================

interface CapturedDb {
  close: ReturnType<typeof vi.fn>
}

function setupDbStub(): CapturedDb {
  const db: CapturedDb = { close: vi.fn() }
  mocks.createDatabaseAsync.mockResolvedValue(db as unknown as { close: () => void })
  return db
}

// ============================================================================
// Tests
// ============================================================================

describe('SMI-4590 Step 0a — sklx audit restructure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireTier.mockResolvedValue(undefined)
    mocks.getActiveAdvisories.mockReturnValue([])
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // process.exit must throw so test bodies never actually exit the runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    exitSpy.mockRestore()
  })

  describe('parent command shape', () => {
    it('registers `audit` as a parent command with description', () => {
      const audit = createAuditCommand()
      expect(audit.name()).toBe('audit')
      expect(audit.description()).toMatch(/audit/i)
    })

    it('registers `advisories` as a subcommand', () => {
      const audit = createAuditCommand()
      const subcommandNames = audit.commands.map((c) => c.name())
      expect(subcommandNames).toContain('advisories')
    })
  })

  describe('`sklx audit advisories` (canonical)', () => {
    it('runs the advisories handler', async () => {
      setupDbStub()
      const audit = createAuditCommand()
      const root = new Command().exitOverride()
      root.addCommand(audit)
      await root.parseAsync(['node', 'sklx', 'audit', 'advisories'])
      expect(mocks.requireTier).toHaveBeenCalledWith('team')
      expect(mocks.createDatabaseAsync).toHaveBeenCalled()
      expect(mocks.AdvisoryRepositoryCtor).toHaveBeenCalled()
    })

    it('does NOT emit the deprecation warning', async () => {
      setupDbStub()
      const audit = createAuditCommand()
      const root = new Command().exitOverride()
      root.addCommand(audit)
      await root.parseAsync(['node', 'sklx', 'audit', 'advisories'])
      const warnings = (stderrSpy.mock.calls.flat() as unknown[]).filter(
        (arg): arg is string => typeof arg === 'string' && arg.includes('DEPRECATED')
      )
      expect(warnings).toHaveLength(0)
    })
  })

  describe('`sklx audit <skill-id>` deprecation alias', () => {
    it('emits the deprecation warning to stderr', async () => {
      setupDbStub()
      const audit = createAuditCommand()
      const root = new Command().exitOverride()
      root.addCommand(audit)
      await root.parseAsync(['node', 'sklx', 'audit', 'some/skill-id'])
      const warnings = (stderrSpy.mock.calls.flat() as unknown[]).filter(
        (arg): arg is string =>
          typeof arg === 'string' && arg.includes(AUDIT_FLAT_DEPRECATION_NOTICE)
      )
      expect(warnings.length).toBeGreaterThan(0)
    })

    it('forwards to the same advisories handler', async () => {
      setupDbStub()
      const audit = createAuditCommand()
      const root = new Command().exitOverride()
      root.addCommand(audit)
      await root.parseAsync(['node', 'sklx', 'audit', 'some/skill-id'])
      expect(mocks.requireTier).toHaveBeenCalledWith('team')
      expect(mocks.createDatabaseAsync).toHaveBeenCalled()
    })

    it('mentions the canonical `audit advisories` form in the warning', () => {
      expect(AUDIT_FLAT_DEPRECATION_NOTICE).toMatch(/audit advisories/)
    })

    it('flags the alias as removed in the next minor', () => {
      expect(AUDIT_FLAT_DEPRECATION_NOTICE).toMatch(/next minor/i)
    })
  })

  describe('`sklx audit` with no args', () => {
    it('prints help (no advisories handler invocation)', async () => {
      const audit = createAuditCommand()
      const root = new Command().exitOverride()
      root.addCommand(audit)

      // commander's `.help()` calls process.exit; our spy throws.
      await expect(root.parseAsync(['node', 'sklx', 'audit'])).rejects.toThrow()

      expect(mocks.requireTier).not.toHaveBeenCalled()
      expect(mocks.createDatabaseAsync).not.toHaveBeenCalled()
    })
  })

  describe('subcommand factory exports (regression guard)', () => {
    it('createAuditAdvisoriesSubcommand returns a Command named `advisories`', () => {
      const cmd = createAuditAdvisoriesSubcommand()
      expect(cmd.name()).toBe('advisories')
    })

    it('createAuditCommand returns a Command named `audit`', () => {
      const cmd = createAuditCommand()
      expect(cmd.name()).toBe('audit')
    })
  })
})
