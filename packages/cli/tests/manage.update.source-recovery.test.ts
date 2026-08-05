/**
 * SMI-5895 Wave 2 Step 1 — `getSkillDiff`'s manifest / SourceRecoveryService
 * fallback (when the skill isn't in the local registry cache).
 *
 * Split out of manage.update.test.ts (which mocks the local-cache-hit path;
 * this file is the "cache miss" half) to keep both files under the
 * 500-line pre-commit gate and to group by topic, matching Wave 1's own
 * split convention (manage-multi-client.test.ts).
 *
 * `manage.update.ts` previously fell back to `resolveInstalledSkillId()` —
 * a SKILL.md front-matter `id:` read that was always-null dead code, since
 * `SkillParser.toMetadata()` never emits a top-level `id` field. This file
 * proves the real replacement: (1) `~/.skillsmith/manifest.json`, which
 * `SkillInstallationService.install()` already writes an `id`/`source`
 * into on every successful install, is consulted first; (2) only when that
 * entry is genuinely missing does `SourceRecoveryService` (SMI-5407) run,
 * gated so a medium/low-confidence speculative match is never silently
 * trusted (plan-review correction — an update that blindly applied a
 * low-confidence name match could overwrite a local skill with the wrong
 * upstream version).
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
  // Real (not test-doubled) logic -- getSkillDiff calls this directly to
  // compute the manifest lookup key, so its return value must match
  // production (skill-installation.helpers.ts's manifestKeyFor) exactly:
  // canonical client keeps the bare name, any other client gets `name::client`.
  manifestKeyFor: (name: string, client: string) =>
    client === 'claude-code' ? name : `${name}::${client}`,
  // Never actually invoked (SourceRecoveryService's constructor above is
  // fully mocked and ignores its params) -- present only so the constructor
  // call site's destructuring/typing has something to reference.
  hashContent: vi.fn((content: string) => content),
}))

describe('SMI-5895 Wave 2 Step 1: getSkillDiff — manifest / SourceRecoveryService fallback', () => {
  const SKILLS_DIR = join(homedir(), '.claude', 'skills')

  beforeEach(async () => {
    vi.clearAllMocks()

    const mockDb = { close: mocks.dbClose }
    mocks.createDatabaseAsync.mockResolvedValue(mockDb)
    mocks.installFn.mockResolvedValue({
      success: true,
      skillId: 'author/test-skill',
      installPath: join(homedir(), '.claude', 'skills', 'test-skill'),
    })
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

    const { loadManifest } = await import('../src/utils/manifest.js')
    vi.mocked(loadManifest).mockResolvedValue({ version: '1.0.0', installedSkills: {} })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Mock a single installed skill directory (empty local registry cache by
   * default). `frontmatterName` defaults to the directory name; pass it
   * explicitly to reproduce the real-world case where SKILL.md's `name:`
   * differs from the directory `install()` created (getSkillsFromDirectory
   * prefers the front-matter name for `InstalledSkill.name`).
   */
  async function mockInstalledSkill(
    name: string,
    version = '1.0.0',
    frontmatterName = name
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
    mocks.parseFn.mockReturnValue({ name: frontmatterName, version })
  }

  async function setManifestEntry(key: string, id: string): Promise<void> {
    const { loadManifest } = await import('../src/utils/manifest.js')
    vi.mocked(loadManifest).mockResolvedValue({
      version: '1.0.0',
      installedSkills: {
        [key]: {
          id,
          name: key,
          version: '1.0.0',
          source: `github:${id}`,
          installPath: join(SKILLS_DIR, key),
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        },
      },
    })
  }

  describe('manifest resolution (cache miss)', () => {
    it('resolves via the manifest and confirms a registry-shaped id against the remote registry', async () => {
      await mockInstalledSkill('astro')
      await setManifestEntry('astro', 'wrsmith108/astro')
      mocks.apiClient.isOffline = () => false
      mocks.apiClient.getSkill = vi.fn().mockResolvedValue({
        data: {
          repo_url: 'https://github.com/wrsmith108/astro',
          name: 'astro',
          trust_tier: 'community',
        },
      })

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('astro', '/fake/db.sqlite')

      expect(result).not.toBe('not-installed')
      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object') {
        expect(result.skillId).toBe('wrsmith108/astro')
      }
    })

    it('resolves via the manifest without a registry API call when the recorded id is a raw GitHub URL (direct-URL install)', async () => {
      await mockInstalledSkill('my-direct-skill')
      await setManifestEntry('my-direct-skill', 'https://github.com/someone/my-direct-skill')

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('my-direct-skill', '/fake/db.sqlite')

      expect(result).not.toBe('not-installed')
      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object') {
        expect(result.skillId).toBe('https://github.com/someone/my-direct-skill')
      }
      // A raw-URL manifest id is not a registry id -- no API confirmation call.
      expect(mocks.apiClient.getSkill).not.toHaveBeenCalled()
    })

    it('keys the manifest lookup off the install directory, not the caller-supplied argument casing', async () => {
      // `install()` writes the key from the same string it used for the
      // install directory, so a case-insensitively-matched argument
      // ("update Astro" against ~/.claude/skills/astro) must still find it.
      await mockInstalledSkill('astro')
      await setManifestEntry('astro', 'https://github.com/someone/astro')

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('Astro', '/fake/db.sqlite')

      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object') {
        expect(result.skillId).toBe('https://github.com/someone/astro')
      }
      // Resolved from the manifest -- recovery must not have been consulted.
      expect(mocks.recoverOneFn).not.toHaveBeenCalled()
    })

    it("keys the manifest lookup off the install directory, not SKILL.md's front-matter name", async () => {
      // Directory (and therefore manifest key) is `pitch`; the skill's own
      // SKILL.md declares `name: Pitch Deck Builder`, which is what
      // InstalledSkill.name carries. Keying off the front-matter name would
      // miss the entry and fall through to source recovery.
      await mockInstalledSkill('pitch', '1.0.0', 'Pitch Deck Builder')
      await setManifestEntry('pitch', 'https://github.com/someone/pitch')

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('Pitch Deck Builder', '/fake/db.sqlite')

      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object') {
        expect(result.skillId).toBe('https://github.com/someone/pitch')
      }
      expect(mocks.recoverOneFn).not.toHaveBeenCalled()
    })

    it('resolves the (name, client) manifest key that matches the client being asked about (SMI-5894 Wave 1 Step 3)', async () => {
      // Two independent installs of the same skill NAME under two clients,
      // each with a DIFFERENT recorded source -- the exact scenario the
      // plan's cross-cutting Verification requirement targets.
      await mockInstalledSkill('test-repo')
      const { loadManifest } = await import('../src/utils/manifest.js')
      vi.mocked(loadManifest).mockResolvedValue({
        version: '1.0.0',
        installedSkills: {
          'test-repo': {
            id: 'https://github.com/owner-a/test-repo',
            name: 'test-repo',
            version: '1.0.0',
            source: 'github:owner-a/test-repo',
            installPath: join(SKILLS_DIR, 'test-repo'),
            installedAt: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
          'test-repo::cursor': {
            id: 'https://github.com/owner-b/test-repo',
            name: 'test-repo',
            version: '1.0.0',
            source: 'github:owner-b/test-repo',
            installPath: join(homedir(), '.cursor', 'skills', 'test-repo'),
            installedAt: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
        },
      })

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('test-repo', '/fake/db.sqlite', 'claude-code')

      expect(typeof result).toBe('object')
      if (typeof result === 'object') {
        expect(result.skillId).toBe('https://github.com/owner-a/test-repo')
      }
    })
  })

  describe('SourceRecoveryService fallback (manifest entry genuinely missing)', () => {
    it('auto-applies an exact-confidence recovery (git-remote)', async () => {
      await mockInstalledSkill('git-tracked-skill')
      // loadManifest default (beforeEach) returns an empty manifest.
      mocks.recoverOneFn.mockResolvedValue({
        status: 'recovered',
        confidence: 'exact',
        registryId: null,
        recoveredSource: {
          owner: 'someone',
          repo: 'git-tracked-skill',
          url: 'https://github.com/someone/git-tracked-skill',
        },
      })

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('git-tracked-skill', '/fake/db.sqlite')

      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object') {
        expect(result.skillId).toBe('https://github.com/someone/git-tracked-skill')
      }
    })

    it('auto-applies a high-confidence recovery (plugin manifest) and prefers the skill-specific raw URL over the enriched registryId', async () => {
      // SMI-5895 review (D-1): registryId comes from a repo_url-only lookup
      // with no per-skill disambiguation -- a multi-skill plugin/monorepo
      // shares one repo_url across every skill in it, so it can resolve to a
      // DIFFERENT skill's registry row than the one actually being
      // recovered. recoveredSource.url is always populated alongside
      // registryId for this confidence tier and is skill-specific, so it
      // must be preferred.
      await mockInstalledSkill('plugin-tracked-skill')
      mocks.recoverOneFn.mockResolvedValue({
        status: 'recovered',
        confidence: 'high',
        registryId: 'community/some-other-skill-sharing-this-repo-url',
        recoveredSource: {
          owner: 'someone',
          repo: 'plugin-tracked-skill',
          url: 'https://github.com/someone/plugin-tracked-skill',
        },
      })

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('plugin-tracked-skill', '/fake/db.sqlite')

      expect(result).not.toBe('unresolvable')
      if (typeof result === 'object') {
        expect(result.skillId).toBe('https://github.com/someone/plugin-tracked-skill')
      }
    })

    it('does NOT auto-apply a medium-confidence recovery (single registry-name match) — returns unresolvable', async () => {
      await mockInstalledSkill('ambiguous-named-skill')
      mocks.recoverOneFn.mockResolvedValue({
        status: 'recovered',
        confidence: 'medium',
        registryId: 'someauthor/ambiguous-named-skill',
        recoveredSource: {
          owner: 'someauthor',
          repo: 'ambiguous-named-skill',
          url: 'https://github.com/someauthor/ambiguous-named-skill',
        },
      })

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('ambiguous-named-skill', '/fake/db.sqlite')

      expect(result).toBe('unresolvable')
    })

    it('does NOT auto-apply a low-confidence recovery — returns unresolvable', async () => {
      await mockInstalledSkill('hinted-skill')
      mocks.recoverOneFn.mockResolvedValue({
        status: 'recovered',
        confidence: 'low',
        registryId: null,
        recoveredSource: {
          owner: 'someauthor',
          repo: 'hinted-skill',
          url: 'https://github.com/someauthor/hinted-skill',
        },
      })

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('hinted-skill', '/fake/db.sqlite')

      expect(result).toBe('unresolvable')
    })

    it('returns "unresolvable" (not a hard command failure) when recovery itself throws', async () => {
      // The injected recovery deps query the local `skills` cache directly, so
      // a missing/corrupt table throws rather than returning zero candidates.
      await mockInstalledSkill('cache-broken-skill')
      mocks.recoverOneFn.mockRejectedValue(new Error('SQLITE_ERROR: no such table: skills'))

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('cache-broken-skill', '/fake/db.sqlite')

      expect(result).toBe('unresolvable')
    })

    it('returns "unresolvable" when the manifest is missing entirely and recovery finds nothing', async () => {
      await mockInstalledSkill('mystery-skill')
      // loadManifest default (beforeEach) is an empty manifest; recoverOneFn
      // default (beforeEach) is 'unknown'/unresolved.

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('mystery-skill', '/fake/db.sqlite')

      expect(result).toBe('unresolvable')
    })

    it("updateSkill's failure message for an unresolvable skill points to `sklx audit sources`", async () => {
      await mockInstalledSkill('mystery-skill')

      const oraModule = await import('ora')
      const { updateSkill } = await import('../src/commands/manage.js')
      const success = await updateSkill('mystery-skill', '/fake/db.sqlite')

      expect(success).toBe(false)
      // updateSkill() creates its spinner via `ora(...)` at the top of the
      // function -- the mock factory returns a fresh spy object per call, so
      // pull the instance it actually returned (not a separately-called one).
      const oraMock = vi.mocked(oraModule.default)
      expect(oraMock).toHaveBeenCalled()
      const spinnerInstance = oraMock.mock.results[0]?.value as { fail: ReturnType<typeof vi.fn> }
      const failMessage = vi
        .mocked(spinnerInstance.fail)
        .mock.calls.map((c) => String(c[0]))
        .join('\n')
      expect(failMessage).toContain('sklx audit sources')
    })
  })

  describe('manually-deleted skill (stale manifest entry, edge case)', () => {
    it('returns "not-installed" without crashing when the skill directory no longer exists, even if a manifest entry still references it', async () => {
      // readdir on the skills dir throws ENOENT (the skill was manually
      // rm -rf'd) -- getInstalledSkillsForClient() finds nothing, so
      // getSkillDiff must short-circuit to 'not-installed' BEFORE it ever
      // touches the (stale) manifest entry's installPath.
      const { readdir } = await import('fs/promises')
      vi.mocked(readdir).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      await setManifestEntry('deleted-skill', 'someone/deleted-skill')

      const { getSkillDiff } = await import('../src/commands/manage.js')
      const result = await getSkillDiff('deleted-skill', '/fake/db.sqlite')

      expect(result).toBe('not-installed')
    })
  })
})
