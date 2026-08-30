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
import { SkillInstallationService } from '@skillsmith/core'

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

// SMI-6103: the two new author-mismatch regression tests below are the first
// tests in this file to fall through the cache-match rejection into the
// manifest/SourceRecoveryService path — mocked the same way
// manage.update.source-recovery.test.ts already does for that path.
vi.mock('../src/utils/manifest.js', () => ({
  loadManifest: vi.fn(),
}))

/** Loose shape for a mocked local-registry-cache row (SkillRepository.findAll items). */
interface MockCachedSkill {
  id: string
  name: string
  version: string
  trustTier: string
  author: string
}

/** Loose shape for mocked parsed SKILL.md front-matter (SkillParser.parse output). */
interface MockParsedSkill {
  name?: string
  version?: string | null
  id?: string | undefined
  author?: string | undefined
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
  // SourceRecoveryService.recoverOne() mock — default "nothing recovered".
  recoverOneFn: vi.fn(
    async (): Promise<{
      status: 'recovered' | 'unknown'
      confidence: 'exact' | 'high' | 'medium' | 'low' | 'user-specified' | 'unknown'
      registryId: string | null
      recoveredSource: { owner: string; repo: string; url: string } | null
    }> => ({
      status: 'unknown',
      confidence: 'unknown',
      registryId: null,
      recoveredSource: null,
    })
  ),
  // ADR-139 (SMI-6274 Wave 4): getSkillDiff()'s adoption path for an
  // untracked skill (no manifest entry) — see the identical mocks in
  // manage.update.source-recovery.test.ts.
  manifestUpdateSafelyFn: vi.fn(async () => undefined),
  buildAdoptedEntryFn: vi.fn(
    async (name: string, installPath: string): Promise<Record<string, unknown>> => ({
      id: name,
      name,
      version: 'unknown',
      source: 'unknown',
      installPath,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-01-01T00:00:00.000Z',
    })
  ),
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
  SourceRecoveryService: vi.fn().mockImplementation(function () {
    return { recoverOne: mocks.recoverOneFn }
  }),
  // Mirrors production (skill-installation.helpers.ts's manifestKeyFor)
  // exactly: canonical client keeps the bare name, any other client gets
  // `name::client`.
  manifestKeyFor: (name: string, client: string) =>
    client === 'claude-code' ? name : `${name}::${client}`,
  // Never actually invoked (SourceRecoveryService's constructor above is
  // fully mocked and ignores its params) -- present only so the constructor
  // call site's destructuring/typing has something to reference.
  hashContent: vi.fn((content: string) => content),
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
  // ADR-139 (SMI-6274 Wave 4): getSkillDiff()'s adoption path for an
  // untracked skill (manifest entry genuinely missing).
  ManifestManager: vi.fn().mockImplementation(function (manifestPath: string) {
    return { path: manifestPath, updateSafely: mocks.manifestUpdateSafelyFn }
  }),
  buildAdoptedManifestEntry: (name: string, installPath: string) =>
    mocks.buildAdoptedEntryFn(name, installPath),
  // GPT-5.6-Sol PR review round 4: the race-safe adoption-write wrapper
  // moved to @skillsmith/core (adoptUntrackedSkillEntry, alongside
  // buildAdoptedManifestEntry) so performUninstall() and getSkillDiff()
  // share ONE implementation instead of two drifting copies. Mocked here
  // with equivalent logic, driven by the SAME buildAdoptedManifestEntry/
  // ManifestManager mocks above, so every existing assertion on
  // buildAdoptedEntryFn's call args, manifestUpdateSafelyFn's captured
  // callback, and adoptionError content keeps exercising the same shape.
  adoptUntrackedSkillEntry: async (
    skillName: string,
    skillDirName: string,
    installPath: string,
    manifestKey: string,
    manifest: {
      path: string
      updateSafely: (
        fn: (current: { installedSkills: Record<string, unknown> }) => {
          installedSkills: Record<string, unknown>
        }
      ) => Promise<void>
    }
  ): Promise<{ entry: Record<string, unknown>; adopted: boolean } | { adoptionError: string }> => {
    const adoptedEntry = await mocks.buildAdoptedEntryFn(skillDirName, installPath)
    let resolvedEntry: Record<string, unknown> = adoptedEntry
    let adopted = true
    try {
      await manifest.updateSafely((current) => {
        const existing = current.installedSkills?.[manifestKey]
        if (existing) {
          resolvedEntry = existing as Record<string, unknown>
          adopted = false
          return current
        }
        resolvedEntry = adoptedEntry
        adopted = true
        return {
          ...current,
          installedSkills: { ...current.installedSkills, [manifestKey]: adoptedEntry },
        }
      })
    } catch (adoptError) {
      return {
        adoptionError:
          'Failed to adopt untracked skill "' +
          skillName +
          '" at ' +
          installPath +
          ' into manifest ' +
          manifest.path +
          ': ' +
          (adoptError instanceof Error ? adoptError.message : String(adoptError)),
      }
    }
    return { entry: resolvedEntry, adopted }
  },
}))

describe('SMI-5593: skillsmith update — real update path', () => {
  const SKILLS_DIR = join(homedir(), '.claude', 'skills')

  beforeEach(async () => {
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
    mocks.recoverOneFn.mockResolvedValue({
      status: 'unknown',
      confidence: 'unknown',
      registryId: null,
      recoveredSource: null,
    })
    // ADR-139 (SMI-6274 Wave 4): adoption defaults — succeed, and
    // reconstruct an 'unknown'-version/source entry, matching production.
    mocks.manifestUpdateSafelyFn.mockResolvedValue(undefined)
    mocks.buildAdoptedEntryFn.mockImplementation(async (name: string, installPath: string) => ({
      id: name,
      name,
      version: 'unknown',
      source: 'unknown',
      installPath,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-01-01T00:00:00.000Z',
    }))

    // SMI-6103: default empty manifest — the two author-mismatch regression
    // tests fall through to this path and expect no manifest entry either.
    const { loadManifest } = await import('../src/utils/manifest.js')
    vi.mocked(loadManifest).mockResolvedValue({ version: '1.0.0', installedSkills: {} })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Mock a single installed skill directory with the given SKILL.md front-matter. */
  async function mockInstalledSkill(
    name: string,
    opts: { version?: string; id?: string; author?: string } = {}
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
    mocks.parseFn.mockReturnValue({
      name,
      version: opts.version ?? null,
      id: opts.id,
      author: opts.author,
    })
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

    it('diffs against the local registry cache when the skill is indexed there AND the installed skill claims the same author', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
      ])

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('astro', '/fake/db.sqlite')

      expect(result).not.toBe('not-installed')
      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object' && !('adoptionError' in result)) {
        expect(result.skillId).toBe('wrsmith108/astro')
        expect(result.changes.some((c) => c.includes('1.0.0 -> 2.0.0'))).toBe(true)
      }
    })

    // SMI-6103: a bare-name cache match whose author does NOT match (or is
    // absent from) the installed skill's own claimed front-matter must NOT
    // be trusted — this is the exact shape of a real incident where two
    // personal, unclaimed skills ("commit", "Linear") were silently
    // overwritten with unrelated same-named registry skills. With no
    // manifest entry and no SourceRecoveryService match configured in this
    // test, the safe outcome is a non-confident diff against the wrong
    // author's row — and, per ADR-139 (SMI-6274 Wave 4), the untracked skill
    // is now ADOPTED along the way, so the outcome is 'adopted-unresolvable'
    // rather than the plain 'unresolvable' this returned before adoption
    // existed.
    it('does NOT trust a bare-name cache match when the installed skill has no claimed author', async () => {
      await mockInstalledSkill('commit', { version: '1.0.0' }) // no author claimed
      mockCache([
        {
          id: 'jinee525/react-component-generator',
          name: 'commit',
          version: '9.9.9',
          trustTier: 'community',
          author: 'jinee525',
        },
      ])

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('commit', '/fake/db.sqlite')

      expect(result).toBe('adopted-unresolvable')
    })

    it('does NOT trust a bare-name cache match when the installed skill claims a DIFFERENT author', async () => {
      await mockInstalledSkill('linear', { version: '3.2.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'lobehub/lobehub',
          name: 'linear',
          version: '1.0.0',
          trustTier: 'community',
          author: 'lobehub',
        },
      ])

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('linear', '/fake/db.sqlite')

      expect(result).toBe('adopted-unresolvable')
    })

    // GPT-5.6-Sol PR review finding (ADR-139 follow-up, adoption-guessed-id
    // guard): moved to manage.update.adoption.test.ts (this file grew past
    // the 500-line standard) — see that file's identically-named test.

    // SMI-6103 (PR #2465 review finding): the cache scan must check every
    // same-name row for a matching author, not just the first one found —
    // an unrelated author's row sorting first must not shadow a later,
    // correct-author row and wrongly make a legitimate update unresolvable.
    it('finds the correct-author row even when an unrelated-author row of the same name sorts first', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'some-other-author/astro',
          name: 'astro',
          version: '5.0.0',
          trustTier: 'community',
          author: 'some-other-author',
        },
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
      ])

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('astro', '/fake/db.sqlite')

      expect(result).not.toBe('not-installed')
      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object' && !('adoptionError' in result)) {
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
      await mockInstalledSkill('astro', { version: '2.0.0', author: 'wrsmith108' })
      // trustTier must match getInstalledSkills()'s mocked inferTrustTier()
      // (always 'unknown' in this file's SkillParser mock) for a true no-op diff.
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'unknown',
          author: 'wrsmith108',
        },
      ])
      const { confirm } = await import('@inquirer/prompts')

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite')

      expect(success).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('--dry-run shows the diff without prompting or installing', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
      ])
      const { confirm } = await import('@inquirer/prompts')

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite', true)

      expect(success).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('force-installs the resolved skill id on confirmation', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
      ])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(true)

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite')

      expect(success).toBe(true)
      expect(mocks.installFn).toHaveBeenCalledWith('wrsmith108/astro', { force: true })
    })

    // SMI-5982 PR-review follow-up: resolveCompanionAgentPath() no longer defaults a missing
    // baseDir to process.cwd() itself (directory-package mode now requires it explicitly), so
    // every SkillInstallationService construction site must pass companionBaseDir explicitly to
    // preserve this CLI command's existing cwd-relative behavior.
    it('constructs SkillInstallationService with companionBaseDir: process.cwd()', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
      ])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(true)

      const { updateSkill } = await import('../src/commands/manage.js')
      await updateSkill('astro', '/fake/db.sqlite')

      expect(SkillInstallationService).toHaveBeenCalledWith(
        expect.objectContaining({ companionBaseDir: process.cwd() })
      )
    })

    it('cancels without installing when the user declines the prompt', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
      ])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(false)

      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('astro', '/fake/db.sqlite')

      expect(success).toBe(false)
      expect(mocks.installFn).not.toHaveBeenCalled()
    })

    it('reports install failure (e.g. a conflict) without throwing', async () => {
      await mockInstalledSkill('astro', { version: '1.0.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
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
      // A single shared claimed author across both installed skills — this
      // mock's SkillParser stub can't distinguish which file is being
      // parsed, so both cache rows below use the same author the blanket
      // mock claims (SMI-6103: getSkillDiff now requires the match).
      mocks.parseFn.mockImplementation(() => ({ version: '1.0.0', author: 'wrsmith108' }))
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
        {
          id: 'wrsmith108/ci-doctor',
          name: 'ci-doctor',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
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
        skillId === 'wrsmith108/astro'
          ? { success: true, skillId: 'wrsmith108/astro', installPath: join(homedir(), 'astro') }
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
      mocks.parseFn.mockReturnValue({ version: '1.0.0', author: 'wrsmith108' })
      mockCache([
        {
          id: 'wrsmith108/astro',
          name: 'astro',
          version: '2.0.0',
          trustTier: 'community',
          author: 'wrsmith108',
        },
      ])
      const { confirm } = await import('@inquirer/prompts')
      vi.mocked(confirm).mockResolvedValue(true)

      const { updateSkills } = await import('../src/commands/manage.js')
      await updateSkills(undefined, '/fake/db.sqlite', false)

      expect(mocks.installFn).toHaveBeenCalledWith('wrsmith108/astro', { force: true })
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
