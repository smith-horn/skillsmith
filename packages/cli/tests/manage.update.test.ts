/**
 * SMI-5593: `skillsmith update` real implementation tests.
 *
 * Split out of manage.test.ts (which had grown past the 500-line pre-commit
 * file-length gate) mirroring the manage.ts/manage.action.ts/manage.update.ts
 * source split.
 *
 * skillsmith update was a stub (`throw new Error('updateSkill not yet
 * implemented')`). These tests cover the real implementation: registry
 * fallback when the local SQLite cache is empty (SMI-5427), the
 * one/set/all selector, --dry-run, and the not-installed/unresolvable edge
 * cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { homedir } from 'os'

// Mock file system
vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}))

// Mock inquirer
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}))

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}))

/** Loose shape for a mocked local-registry-cache row (SkillRepository.findAll items). */
interface MockCachedSkill {
  id: string
  name: string
  version: string
  trustTier: string
}

/** Loose shape for mocked parsed SKILL.md front-matter (SkillParser.parse output). */
interface MockParsedSkill {
  name?: string
  version?: string | null
  id?: string | undefined
}

// Hoisted mock state for SkillInstallationService and the update path
const mocks = vi.hoisted(() => ({
  uninstallFn: vi.fn(),
  installFn: vi.fn(),
  dbClose: vi.fn(),
  createDatabaseAsync: vi.fn(),
  initializeSchema: vi.fn(),
  findAllFn: vi.fn(
    (): {
      items: MockCachedSkill[]
      total: number
      limit: number
      offset: number
      hasMore: boolean
    } => ({
      items: [],
      total: 0,
      limit: 1000,
      offset: 0,
      hasMore: false,
    })
  ),
  findByIdFn: vi.fn((): MockCachedSkill | null => null),
  // Shared across every `new SkillParser()` instance so a test can drive what
  // parsed SKILL.md front-matter (name/version/id) the update path sees.
  parseFn: vi.fn((): MockParsedSkill | undefined => undefined),
  // Mutable per-test API client stub returned by createApiClient() (install.js,
  // not @skillsmith/core — but reached transitively via createApiBackedRegistryLookup).
  apiClient: {
    isOffline: (): boolean => true,
    getSkill: vi.fn(),
  },
}))

// Mock core - use class implementations to avoid vitest warning
vi.mock('@skillsmith/core', () => ({
  createDatabase: vi.fn(() => ({
    close: vi.fn(),
  })),
  createDatabaseAsync: (...args: unknown[]) => mocks.createDatabaseAsync(...args),
  initializeSchema: (...args: unknown[]) => mocks.initializeSchema(...args),
  SkillRepository: vi.fn().mockImplementation(function () {
    return {
      findAll: mocks.findAllFn,
      findById: mocks.findByIdFn,
    }
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return {
      clearAll: vi.fn(),
    }
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return {
      uninstall: mocks.uninstallFn,
      install: mocks.installFn,
    }
  }),
  SkillParser: vi.fn().mockImplementation(function () {
    return {
      parse: mocks.parseFn,
      inferTrustTier: vi.fn(() => 'unknown'),
    }
  }),
  // Reached only via install.js's createApiBackedRegistryLookup(), which
  // updateSkill() now calls on every update — not the update path's main
  // logic, but must resolve without throwing.
  QuarantineRepository: vi.fn().mockImplementation(function () {
    return { isQuarantined: vi.fn(() => false) }
  }),
  SkillsmithApiClient: {
    toSkill: vi.fn(() => ({ trustTier: 'community' })),
  },
  emitInstallEvent: vi.fn(),
  isGitHubUrl: vi.fn(() => false),
  createApiClient: vi.fn(() => mocks.apiClient),
  loadStoredAccessToken: vi.fn(async () => null),
}))

describe('SMI-5593: skillsmith update — real update path', () => {
  const SKILLS_DIR = join(homedir(), '.claude', 'skills')

  beforeEach(() => {
    vi.clearAllMocks()

    const mockDb = { close: mocks.dbClose }
    mocks.createDatabaseAsync.mockResolvedValue(mockDb)
    mocks.uninstallFn.mockResolvedValue({ success: true })

    // vi.clearAllMocks() only clears call history, not implementations set
    // via mockReturnValue/mockResolvedValue, so a persistent override from
    // one test would otherwise leak into the next.
    mocks.installFn.mockResolvedValue({
      success: true,
      skillId: 'author/test-skill',
      installPath: join(homedir(), '.claude', 'skills', 'test-skill'),
    })
    mocks.findAllFn.mockReturnValue({ items: [], total: 0, limit: 1000, offset: 0, hasMore: false })
    mocks.findByIdFn.mockReturnValue(null)
    mocks.parseFn.mockReturnValue(undefined)
    mocks.apiClient.isOffline = () => true
    mocks.apiClient.getSkill = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Mock a single installed skill directory with the given SKILL.md front-matter. */
  async function mockInstalledSkill(
    name: string,
    opts: { version?: string; id?: string } = {}
  ): Promise<void> {
    const { readdir, stat } = await import('fs/promises')
    vi.mocked(readdir).mockImplementation(async (dirPath) => {
      if (dirPath === SKILLS_DIR) {
        return [{ name, isDirectory: () => true }] as unknown as ReturnType<typeof readdir>
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    vi.mocked(stat).mockResolvedValue({
      mtime: new Date('2026-01-01'),
    } as unknown as Awaited<ReturnType<typeof stat>>)
    mocks.parseFn.mockReturnValue({ name, version: opts.version ?? null, id: opts.id })
  }

  async function mockNoInstalledSkills(): Promise<void> {
    const { readdir } = await import('fs/promises')
    vi.mocked(readdir).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  }

  /** Drive SkillRepository.findAll()'s mocked local-registry-cache page. */
  function mockCache(items: MockCachedSkill[]): void {
    mocks.findAllFn.mockReturnValue({
      items,
      total: items.length,
      limit: 1000,
      offset: 0,
      hasMore: false,
    })
  }

  describe('getSkillDiff', () => {
    it('returns "not-installed" when the skill is not on disk', async () => {
      await mockNoInstalledSkills()
      const { getSkillDiff } = await import('../src/commands/manage.js')

      const result = await getSkillDiff('ghost-skill', '/fake/db.sqlite')
      expect(result).toBe('not-installed')
    })

    it('diffs against the local registry cache when the skill is indexed there', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0' })
      mockCache([
        { id: 'wrsmith108/astro', name: 'astro', version: '2.0.0', trustTier: 'community' },
      ])

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('astro', '/fake/db.sqlite')

      expect(result).not.toBe('not-installed')
      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object') {
        expect(result.skillId).toBe('wrsmith108/astro')
        expect(result.changes.some((c) => c.includes('1.0.0 -> 2.0.0'))).toBe(true)
      }
    })

    // SMI-5895 Wave 2 Step 1: the "local cache empty -> fall back to a
    // recorded source" and "unresolvable" cases now resolve via the
    // manifest / a confidence-gated SourceRecoveryService recovery instead
    // of the dead `resolveInstalledSkillId()` SKILL.md front-matter read
    // this file previously exercised. See manage.update.source-recovery.test.ts.
  })

  describe('updateSkill', () => {
    it('fails clearly without prompting or installing when not installed', async () => {
      await mockNoInstalledSkills()
      const { confirm } = await import('@inquirer/prompts')

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('ghost-skill', '/fake/db.sqlite')

      expect(success).toBe(false)
      expect(confirm).not.toHaveBeenCalled()
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('reports already up to date without prompting when there is no diff', async () => {
      await mockInstalledSkill('astro', { version: '2.0.0' })
      // trustTier must match getInstalledSkills()'s mocked inferTrustTier()
      // (always 'unknown' in this file's SkillParser mock) for a true no-op diff.
      mockCache([{ id: 'wrsmith108/astro', name: 'astro', version: '2.0.0', trustTier: 'unknown' }])
      const { confirm } = await import('@inquirer/prompts')

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite')

      expect(success).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('--dry-run shows the diff without prompting or installing', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0' })
      mockCache([
        { id: 'wrsmith108/astro', name: 'astro', version: '2.0.0', trustTier: 'community' },
      ])
      const { confirm } = await import('@inquirer/prompts')

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite', true)

      expect(success).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('force-installs the resolved skill id on confirmation', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0' })
      mockCache([
        { id: 'wrsmith108/astro', name: 'astro', version: '2.0.0', trustTier: 'community' },
      ])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(true)

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite')

      expect(success).toBe(true)
      expect(mocks.installFn).toHaveBeenCalledWith('wrsmith108/astro', { force: true })
    })

    it('cancels without installing when the user declines the prompt', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0' })
      mockCache([
        { id: 'wrsmith108/astro', name: 'astro', version: '2.0.0', trustTier: 'community' },
      ])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(false)

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite')

      expect(success).toBe(false)
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('reports install failure (e.g. a conflict) without throwing', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0' })
      mockCache([
        { id: 'wrsmith108/astro', name: 'astro', version: '2.0.0', trustTier: 'community' },
      ])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(true)
      mocks.installFn.mockResolvedValue({
        success: false,
        error: 'ALREADY_INSTALLED: local modifications detected',
      })

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite')

      expect(success).toBe(false)
    })
  })

  describe('updateSkills (multi-skill / --all)', () => {
    /** Two installed skills (astro, ci-doctor), both resolvable via the local cache. */
    async function mockTwoInstalledSkills(): Promise<void> {
      const { readdir, stat } = await import('fs/promises')
      vi.mocked(readdir).mockImplementation(async (dirPath) => {
        if (dirPath === SKILLS_DIR) {
          return [
            { name: 'astro', isDirectory: () => true },
            { name: 'ci-doctor', isDirectory: () => true },
          ] as unknown as ReturnType<typeof readdir>
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      vi.mocked(stat).mockResolvedValue({
        mtime: new Date('2026-01-01'),
      } as unknown as Awaited<ReturnType<typeof stat>>)
      mocks.parseFn.mockImplementation(() => ({ version: '1.0.0' }))
      mockCache([
        { id: 'a/astro', name: 'astro', version: '2.0.0', trustTier: 'community' },
        { id: 'b/ci-doctor', name: 'ci-doctor', version: '2.0.0', trustTier: 'community' },
      ])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(true)
    }

    it('updates a specific set of named skills and reports a summary', async () => {
      await mockTwoInstalledSkills()

      const { updateSkills } = await import('../src/commands/manage.js')
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await updateSkills(['astro', 'ci-doctor'], '/fake/db.sqlite', false)

      expect(mocks.installFn).toHaveBeenCalledTimes(2)
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('Updated: 2')

      logSpy.mockRestore()
    })

    it('continues past a per-skill failure and reports a partial-failure summary', async () => {
      await mockTwoInstalledSkills()
      mocks.installFn.mockImplementation(async (skillId: unknown) =>
        skillId === 'a/astro'
          ? { success: true, skillId: 'a/astro', installPath: join(homedir(), 'astro') }
          : { success: false, error: 'ALREADY_INSTALLED: local modifications detected' }
      )

      const { updateSkills } = await import('../src/commands/manage.js')
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await updateSkills(['astro', 'ci-doctor'], '/fake/db.sqlite', false)

      expect(mocks.installFn).toHaveBeenCalledTimes(2)
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('Updated: 1')
      expect(output).toContain('Failed: 1')

      logSpy.mockRestore()
    })

    it('updates every installed skill when names is omitted (--all)', async () => {
      const { readdir, stat } = await import('fs/promises')
      vi.mocked(readdir).mockImplementation(async (dirPath) => {
        if (dirPath === SKILLS_DIR) {
          return [{ name: 'astro', isDirectory: () => true }] as unknown as ReturnType<
            typeof readdir
          >
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      vi.mocked(stat).mockResolvedValue({
        mtime: new Date('2026-01-01'),
      } as unknown as Awaited<ReturnType<typeof stat>>)
      mocks.parseFn.mockReturnValue({ version: '1.0.0' })
      mockCache([{ id: 'a/astro', name: 'astro', version: '2.0.0', trustTier: 'community' }])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(true)

      const { updateSkills } = await import('../src/commands/manage.js')
      await updateSkills(undefined, '/fake/db.sqlite', false)

      expect(mocks.installFn).toHaveBeenCalledWith('a/astro', { force: true })
    })

    it('prints "No skills installed" and does nothing when there is nothing to update', async () => {
      await mockNoInstalledSkills()
      const { updateSkills } = await import('../src/commands/manage.js')
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await updateSkills(undefined, '/fake/db.sqlite', false)

      expect(mocks.installFn).not.toHaveBeenCalled()
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('No skills installed')

      logSpy.mockRestore()
    })
  })

  describe('updateActionImpl (via updateAction) — explicit selector required', () => {
    it('prints usage guidance and exits non-zero with no names and no --all', async () => {
      const { updateAction } = await import('../src/commands/manage.js')
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      await updateAction([], { db: '/fake/db.sqlite' })

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(mocks.installFn).not.toHaveBeenCalled()
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('skillsmith update --all')

      logSpy.mockRestore()
      exitSpy.mockRestore()
    })

    it('rejects combining --all with explicit skill names', async () => {
      const { updateAction } = await import('../src/commands/manage.js')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      await updateAction(['astro'], { db: '/fake/db.sqlite', all: true })

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(mocks.installFn).not.toHaveBeenCalled()

      errorSpy.mockRestore()
      exitSpy.mockRestore()
    })
  })
})
