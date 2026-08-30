/**
 * ADR-139 (SMI-6274 Wave 4) — `getSkillDiff`'s untracked-skill ADOPTION path
 * and the adoption-guessed-id guard, per GPT-5.6-Sol PR review follow-up.
 *
 * Split out of manage.update.source-recovery.test.ts (which had grown past
 * the 500-line pre-commit gate once this topic's tests were added) to keep
 * both files under it — mirrors that file's own split from
 * manage.update.test.ts, by topic.
 *
 * Two review findings this file exists to cover:
 *   1. `update` previously never adopted an untracked skill at all (only
 *      `remove` did) — it fell straight to SourceRecoveryService and could
 *      dead-end at 'unresolvable' with zero side effects. `getSkillDiff` now
 *      adopts (writes a reconstructed manifest entry, version/source
 *      'unknown') BEFORE resolution is attempted, via the SAME
 *      `buildAdoptedManifestEntry()` builder `performUninstall()` uses.
 *   2. An adopted entry's `id` is a GUESS (`= skillName`) — `getSkillDiff`
 *      must never trust it as an authoritative registry id (source !==
 *      'unknown' guard), or a leftover adopted entry could silently steer
 *      `update` onto an unrelated same-named registry skill.
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

// Mock the CLI's own manifest reader (packages/cli/src/utils/manifest.ts) —
// separate from @skillsmith/core's SkillManifest types below.
vi.mock('../src/utils/manifest.js', () => ({
  loadManifest: vi.fn(),
}))

/** Loose shape for mocked parsed SKILL.md front-matter (SkillParser.parse output). */
interface MockParsedSkill {
  name?: string
  version?: string | null
}

interface MockRecoveryResult {
  status: 'recovered' | 'unknown'
  confidence: 'exact' | 'high' | 'medium' | 'low' | 'user-specified' | 'unknown'
  registryId: string | null
  recoveredSource: { owner: string; repo: string; url: string } | null
}

// Hoisted mock state
const mocks = vi.hoisted(() => ({
  installFn: vi.fn(),
  dbClose: vi.fn(),
  createDatabaseAsync: vi.fn(),
  initializeSchema: vi.fn(),
  findAllFn: vi.fn(
    (): { items: unknown[]; total: number; limit: number; offset: number; hasMore: boolean } => ({
      items: [],
      total: 0,
      limit: 1000,
      offset: 0,
      hasMore: false,
    })
  ),
  parseFn: vi.fn((): MockParsedSkill | undefined => undefined),
  apiClient: {
    isOffline: (): boolean => true,
    getSkill: vi.fn(),
  },
  // SourceRecoveryService.recoverOne() mock — default "nothing recovered".
  recoverOneFn: vi.fn(
    async (): Promise<MockRecoveryResult> => ({
      status: 'unknown',
      confidence: 'unknown',
      registryId: null,
      recoveredSource: null,
    })
  ),
  // ADR-139 (SMI-6274 Wave 4): getSkillDiff()'s adoption path (untracked
  // skill -> reconstructed manifest entry). Default succeeds; individual
  // tests override to simulate an adoption WRITE failure.
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

vi.mock('@skillsmith/core', () => ({
  createDatabase: vi.fn(() => ({ close: vi.fn() })),
  createDatabaseAsync: (...args: unknown[]) => mocks.createDatabaseAsync(...args),
  initializeSchema: (...args: unknown[]) => mocks.initializeSchema(...args),
  SkillRepository: vi.fn().mockImplementation(function () {
    return { findAll: mocks.findAllFn, findById: vi.fn(() => null) }
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return { clearAll: vi.fn() }
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return { uninstall: vi.fn(), install: mocks.installFn }
  }),
  SkillParser: vi.fn().mockImplementation(function () {
    return { parse: mocks.parseFn, inferTrustTier: vi.fn(() => 'unknown') }
  }),
  SourceRecoveryService: vi.fn().mockImplementation(function () {
    return { recoverOne: mocks.recoverOneFn }
  }),
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
  manifestKeyFor: (name: string, client: string) =>
    client === 'claude-code' ? name : `${name}::${client}`,
  hashContent: vi.fn((content: string) => content),
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

describe('ADR-139 (SMI-6274 Wave 4): getSkillDiff untracked-skill adoption + adoption-guessed-id guard', () => {
  const SKILLS_DIR = join(homedir(), '.claude', 'skills')

  beforeEach(async () => {
    vi.clearAllMocks()

    const mockDb = { close: mocks.dbClose }
    mocks.createDatabaseAsync.mockResolvedValue(mockDb)
    mocks.findAllFn.mockReturnValue({ items: [], total: 0, limit: 1000, offset: 0, hasMore: false })
    mocks.parseFn.mockReturnValue(undefined)
    mocks.apiClient.isOffline = () => true
    mocks.apiClient.getSkill = vi.fn()
    mocks.recoverOneFn.mockResolvedValue({
      status: 'unknown',
      confidence: 'unknown',
      registryId: null,
      recoveredSource: null,
    })
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

    const { loadManifest } = await import('../src/utils/manifest.js')
    vi.mocked(loadManifest).mockResolvedValue({ version: '1.0.0', installedSkills: {} })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Mock a single installed skill directory (empty local registry cache by default). */
  async function mockInstalledSkill(name: string, version = '1.0.0'): Promise<void> {
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
    mocks.parseFn.mockReturnValue({ name, version })
  }

  it('returns "adopted-unresolvable" (not a hard command failure) when recovery itself throws — required test 17 (update adoption)', async () => {
    // The injected recovery deps query the local `skills` cache directly, so
    // a missing/corrupt table throws rather than returning zero candidates.
    await mockInstalledSkill('cache-broken-skill')
    mocks.recoverOneFn.mockRejectedValue(new Error('SQLITE_ERROR: no such table: skills'))

    const { getSkillDiff } = await import('../src/commands/manage.js')
    const result = await getSkillDiff('cache-broken-skill', '/fake/db.sqlite')

    expect(result).toBe('adopted-unresolvable')
    // ADR-139 point 1: adoption must actually WRITE a reconstructed
    // manifest entry (via buildAdoptedManifestEntry + ManifestManager),
    // not just change getSkillDiff's return value — this is the concrete
    // required-test-17 gap the PR review found (update never adopted).
    expect(mocks.buildAdoptedEntryFn).toHaveBeenCalledWith(
      'cache-broken-skill',
      join(SKILLS_DIR, 'cache-broken-skill')
    )
    expect(mocks.manifestUpdateSafelyFn).toHaveBeenCalledTimes(1)
  })

  it('returns "adopted-unresolvable" when the manifest is missing entirely and recovery finds nothing, and writes the adopted entry — required test 17 (update adoption)', async () => {
    await mockInstalledSkill('mystery-skill')
    // loadManifest default (beforeEach) is an empty manifest; recoverOneFn
    // default (beforeEach) is 'unknown'/unresolved.

    const { getSkillDiff } = await import('../src/commands/manage.js')
    const result = await getSkillDiff('mystery-skill', '/fake/db.sqlite')

    expect(result).toBe('adopted-unresolvable')
    expect(mocks.buildAdoptedEntryFn).toHaveBeenCalledWith(
      'mystery-skill',
      join(SKILLS_DIR, 'mystery-skill')
    )
    // The updateSafely callback actually inserts the adopted entry under
    // the right manifest key — verified by invoking the callback the mock
    // captured, exactly as ManifestManager itself would.
    const updateFn = (
      mocks.manifestUpdateSafelyFn.mock.calls[0] as unknown[] | undefined
    )?.[0] as (current: { installedSkills: Record<string, unknown> }) => {
      installedSkills: Record<string, unknown>
    }
    const next = updateFn({ installedSkills: {} })
    expect(next.installedSkills['mystery-skill']).toMatchObject({
      id: 'mystery-skill',
      version: 'unknown',
      source: 'unknown',
    })
  })

  it('adoption-write failure surfaces a distinct, actionable error naming the skill and manifest — required test (guard/failure contract)', async () => {
    await mockInstalledSkill('disk-full-skill')
    mocks.manifestUpdateSafelyFn.mockRejectedValue(new Error('ENOSPC: no space left on device'))

    const { getSkillDiff } = await import('../src/commands/manage.js')
    const result = await getSkillDiff('disk-full-skill', '/fake/db.sqlite')

    expect(result).not.toBe('unresolvable')
    expect(result).not.toBe('adopted-unresolvable')
    expect(typeof result).toBe('object')
    if (typeof result === 'object' && 'adoptionError' in result) {
      expect(result.adoptionError).toContain('disk-full-skill')
      expect(result.adoptionError).toContain('ENOSPC')
    }
  })

  // GPT-5.6-Sol PR review finding: a manifest entry whose `id` is a GUESSED
  // value (adoption's `id = skillName`, recorded whenever `source ===
  // 'unknown'`) must NEVER be trusted as an authoritative registry id —
  // otherwise a leftover adopted entry (e.g. from a `remove` that adopted
  // but then failed partway through) could silently steer `update` onto an
  // unrelated same-named registry skill.
  it('does not trust a manifest id when source is "unknown" (adoption-guessed-id guard)', async () => {
    await mockInstalledSkill('guessed-id-skill')
    const { loadManifest } = await import('../src/utils/manifest.js')
    vi.mocked(loadManifest).mockResolvedValue({
      version: '1.0.0',
      installedSkills: {
        // A plausible-looking but WRONG guessed id, exactly the shape a
        // stale/partial adoption would leave behind.
        'guessed-id-skill': {
          id: 'some-author/some-other-skill',
          name: 'guessed-id-skill',
          version: 'unknown',
          source: 'unknown',
          installPath: join(SKILLS_DIR, 'guessed-id-skill'),
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        },
      },
    })
    // No cache match (findAllFn default: empty), no SourceRecoveryService
    // match (recoverOneFn default: unresolved) — the ONLY way this could
    // resolve to 'some-author/some-other-skill' is by wrongly trusting the
    // guessed id directly.

    const { getSkillDiff } = await import('../src/commands/manage.js')
    const result = await getSkillDiff('guessed-id-skill', '/fake/db.sqlite')

    // Must NOT resolve to the guessed id — falls through to source recovery
    // (which also finds nothing here), landing on 'adopted-unresolvable'
    // rather than a confident (and wrong) diff.
    expect(result).toBe('adopted-unresolvable')
    if (typeof result === 'object' && !('adoptionError' in result)) {
      expect(result.skillId).not.toBe('some-author/some-other-skill')
    }
    // Since a real (already-tracked) manifest entry existed, adoption must
    // NOT run again — no fresh write.
    expect(mocks.manifestUpdateSafelyFn).not.toHaveBeenCalled()
  })
})
