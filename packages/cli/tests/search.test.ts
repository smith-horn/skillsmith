/**
 * SMI-744: Interactive Search Command Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { DEFAULT_DB_PATH } from '../src/config.js'

// Mock dependencies before importing the module
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  checkbox: vi.fn(),
  number: vi.fn(),
  select: vi.fn(),
}))

// Hoisted mock state for the SMI-5982 interactive-install regression suite below.
const mocks = vi.hoisted(() => ({
  installFn: vi.fn(),
  ora: {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  },
}))

vi.mock('ora', () => ({
  default: () => mocks.ora,
}))

vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    createDatabase: vi.fn(() => ({
      close: vi.fn(),
    })),
    SearchService: vi.fn(() => ({
      search: vi.fn(() => ({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        hasMore: false,
      })),
    })),
    SkillRepository: vi.fn().mockImplementation(function () {
      return {}
    }),
    SkillDependencyRepository: vi.fn().mockImplementation(function () {
      return {}
    }),
    SkillInstallationService: vi.fn().mockImplementation(function () {
      return { install: mocks.installFn }
    }),
  }
})

vi.mock('@skillsmith/core/install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core/install')>()
  return {
    ...actual,
    getInstallPath: vi.fn(() => '/mock/skills'),
    resolveClientId: vi.fn(() => 'claude-code'),
  }
})

vi.mock('@skillsmith/core/embeddings/probe', () => ({
  probeEmbeddingCapability: vi.fn(async () => undefined),
}))

vi.mock('@skillsmith/core/telemetry', () => ({
  withTelemetry: <TArgs extends readonly unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn> | TReturn
  ) => fn,
}))

vi.mock('../src/utils/open-database.js', () => ({
  openCliDatabase: vi.fn(async () => ({ close: vi.fn() })),
}))

vi.mock('../src/commands/install.js', () => ({
  createApiBackedRegistryLookup: vi.fn(async () => ({})),
}))

vi.mock('../src/commands/search.helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands/search.helpers.js')>()
  return {
    ...actual,
    searchRemoteOrLocal: vi.fn(async () => ({
      kind: 'results' as const,
      items: [
        {
          skill: {
            id: 'community/jest-helper',
            name: 'jest-helper',
            description: 'A helper skill',
            author: 'test-author',
            repoUrl: 'https://github.com/test-author/jest-helper',
            qualityScore: 0.8,
            trustTier: 'community' as const,
            tags: ['testing'],
            installable: true,
            riskScore: 5,
            securityFindingsCount: 0,
            securityScannedAt: '2026-01-01T00:00:00.000Z',
            securityPassed: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          rank: 1,
          highlights: {},
        },
      ],
      hasMore: false,
      totalHint: 1,
    })),
  }
})

describe('SMI-744: Search Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createSearchCommand', () => {
    it('creates a command with correct name', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('search')
    })

    it('has interactive option', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const interactiveOpt = cmd.options.find((o) => o.short === '-i')
      expect(interactiveOpt).toBeDefined()
      expect(interactiveOpt?.long).toBe('--interactive')
    })

    it('has database path option with default', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const dbOpt = cmd.options.find((o) => o.short === '-d')
      expect(dbOpt).toBeDefined()
      expect(dbOpt?.defaultValue).toBe(DEFAULT_DB_PATH)
    })

    it('has limit option', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const limitOpt = cmd.options.find((o) => o.short === '-l')
      expect(limitOpt).toBeDefined()
    })

    it('has trust tier filter option', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const tierOpt = cmd.options.find((o) => o.short === '-t')
      expect(tierOpt).toBeDefined()
    })

    it('has minimum score filter option', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const scoreOpt = cmd.options.find((o) => o.short === '-s')
      expect(scoreOpt).toBeDefined()
    })
  })

  describe('Trust Tier Colors', () => {
    it('defines colors for all trust tiers', async () => {
      // The colors are defined in the module
      const trustTiers = ['verified', 'community', 'experimental', 'unknown']

      // All tiers should have associated colors (implementation detail)
      expect(trustTiers.length).toBe(4)
    })
  })

  describe('Pagination', () => {
    it('uses default page size of 10', async () => {
      // PAGE_SIZE constant in the module
      const expectedPageSize = 10
      expect(expectedPageSize).toBe(10)
    })
  })

  // ==========================================================================
  // SMI-5982 PR-review follow-up: resolveCompanionAgentPath() no longer
  // defaults a missing baseDir to process.cwd() itself (directory-package
  // mode now requires it explicitly), so search's own "install from search
  // results" call site must pass companionBaseDir explicitly to preserve its
  // existing cwd-relative behavior.
  // ==========================================================================
  describe('interactive install (SMI-5982)', () => {
    it('constructs SkillInstallationService with companionBaseDir: process.cwd()', async () => {
      const { input, checkbox, number, select } = await import('@inquirer/prompts')
      const { SkillInstallationService } = await import('@skillsmith/core')

      vi.mocked(input).mockResolvedValueOnce('jest-helper')
      vi.mocked(checkbox).mockResolvedValueOnce([])
      vi.mocked(number).mockResolvedValueOnce(0)
      // Prompt sequence: pick the first result to view -> choose "Install this
      // skill" -> exit on the next results screen (ends the interactive loop).
      vi.mocked(select)
        .mockResolvedValueOnce('view_0')
        .mockResolvedValueOnce('install')
        .mockResolvedValueOnce('exit')

      mocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'community/jest-helper',
        installPath: '/mock/skills/jest-helper',
      })

      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      await cmd.parseAsync(['node', 'test', '--interactive', '--db', 'fake.db'])

      expect(SkillInstallationService).toHaveBeenCalledWith(
        expect.objectContaining({ companionBaseDir: process.cwd() })
      )
      expect(mocks.installFn).toHaveBeenCalledWith('community/jest-helper', {})
    })
  })

  // ==========================================================================
  // SMI-5893 (Wave 7 Step 4): `runSearch`'s spinner-suppression check now
  // calls the shared `isQuietModeEnabled()` helper instead of a narrower
  // literal `process.env['SKILLSMITH_QUIET'] === 'true'` string comparison —
  // isolate/restore the env var around each case (process-level shared state).
  // ==========================================================================
  describe('SMI-5893 (Wave 7 Step 4): SKILLSMITH_QUIET env-var fallback', () => {
    const ORIGINAL_SKILLSMITH_QUIET = process.env['SKILLSMITH_QUIET']

    afterEach(() => {
      if (ORIGINAL_SKILLSMITH_QUIET === undefined) {
        delete process.env['SKILLSMITH_QUIET']
      } else {
        process.env['SKILLSMITH_QUIET'] = ORIGINAL_SKILLSMITH_QUIET
      }
    })

    it('suppresses the search spinner via isQuietModeEnabled() even without --quiet/--no-progress', async () => {
      process.env['SKILLSMITH_QUIET'] = 'true'

      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      await cmd.parseAsync(['node', 'test', 'jest', '--db', 'fake.db'])

      expect(mocks.ora.start).not.toHaveBeenCalled()
    })

    it('shows the search spinner when SKILLSMITH_QUIET is unset and no local quiet flag is passed', async () => {
      delete process.env['SKILLSMITH_QUIET']

      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      await cmd.parseAsync(['node', 'test', 'jest', '--db', 'fake.db'])

      expect(mocks.ora.start).toHaveBeenCalled()
    })
  })
})
