/**
 * ADR-139 (SMI-6274 Wave 4) — GPT-5.6-Sol PR review ROUND 2 confirmation
 * findings, covered with REAL manifest persistence (not mocking
 * `ManifestManager.updateSafely()`/`buildAdoptedManifestEntry()`
 * themselves) — the round-2 reviewer flagged the existing
 * `manage.update.adoption.test.ts` suite as too mock-heavy to actually
 * prove persistence or double-write avoidance.
 *
 * Mirrors `manage-multi-client.test.ts`'s real-end-to-end technique: no
 * `@skillsmith/core` mocking at all, real `SkillInstallationService` /
 * `SkillRepository` / `ManifestManager` against a temp `$HOME`, mocking
 * only `fetch` defensively (neither test here should ever reach it).
 *
 * Three findings (round 3 confirmation review added a second sub-case of
 * finding 2 in a round-4 pass — see test 3):
 *   1. `getSkillDiff()` used to adopt ONLY inside its manifest-fallback
 *      branch, reached AFTER a bare-name local-cache match had already
 *      returned early — so an untracked skill whose front-matter author
 *      happened to match a cache row of the same name silently skipped
 *      adoption. Fixed by moving the adopt-if-untracked step before BOTH
 *      resolution paths. Test 1 proves the manifest still ends up with a
 *      real (adopted) entry even when the cache-match path answers the diff.
 *   2. The `updateSafely()` callback used to write the guessed entry
 *      unconditionally, without re-checking the FRESH, lock-acquired state
 *      it was handed — trusting the caller's own stale, unlocked read
 *      instead. Test 2 proves that when a concurrent writer (e.g. a real
 *      `install()`) tracks the SAME skill between that outer read and the
 *      locked write, the concurrent REAL entry wins and the guess is
 *      discarded — using the REAL `ManifestManager.updateSafely()`
 *      lock+fresh-read+save cycle, not a captured-and-manually-invoked
 *      callback.
 *   3. (Round 4) Even after (2)'s manifest WRITE was made race-safe, the
 *      cache-match branch that answers the DIFF still resolved `skillId`
 *      purely from the local SQLite cache, ignoring whatever the adoption
 *      step just discovered (a fresh guess, OR a concurrent writer's real,
 *      non-guessed entry). Test 3 proves that when BOTH a cache-match
 *      candidate AND a concurrent real manifest write are present, the
 *      trustworthy manifest entry wins — not the unrelated cache-matched id.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']

let homeDir: string
let dbPath: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi6274-adoption-real-'))
  process.env['HOME'] = homeDir
  process.env['USERPROFILE'] = homeDir
  dbPath = path.join(homeDir, 'skills.db')

  // Neither test below should ever reach the network (cache-match and
  // manifest-id trust both resolve without SourceRecoveryService/fetch),
  // but stub defensively so a regression fails loudly instead of hanging.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Not found', { status: 404 }))
  )

  // CLIENT_NATIVE_PATHS / DEFAULT_MANIFEST_PATH compute homedir() at module
  // import time — reset modules so each test sees its own $HOME (same
  // technique as manage-multi-client.test.ts).
  vi.resetModules()

  // ADR-139: install/list/update/remove auto-detect an EXISTING workspace
  // marker above cwd — mock cwd to a distinct non-existent subdirectory
  // (not homeDir itself, not the real repo checkout) so these tests resolve
  // to GLOBAL scope deterministically. See manage-multi-client.test.ts's
  // identical, fuller comment on why.
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(homeDir, 'no-such-workspace'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (ORIGINAL_HOME === undefined) delete process.env['HOME']
  else process.env['HOME'] = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
  await rm(homeDir, { recursive: true, force: true })
})

const SKILL_MD_BODY =
  '\n# Test Skill\n\nThis is a valid skill file with enough content to pass the ' +
  '100-character minimum validation threshold real callers check. Plain prose.\n'

describe('ADR-139 (SMI-6274 Wave 4): getSkillDiff adoption — real manifest persistence', () => {
  it('ADR-139 finding 1: adopts an untracked skill even when a bare-name local-cache match resolves the diff', async () => {
    // Plant the skill directly on disk — NOT via install() — so it starts
    // with no manifest entry at all (the exact untracked state).
    const skillDir = path.join(homeDir, '.claude', 'skills', 'cache-matched-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: cache-matched-skill\nauthor: matching-author\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )

    // Seed the LOCAL REGISTRY CACHE with a row whose author agrees with the
    // installed skill's own front-matter claim — this is exactly what makes
    // getSkillDiff()'s bare-name cache-match branch fire and return early.
    const { openCliDatabase } = await import('../src/utils/open-database.js')
    const { SkillRepository } = await import('@skillsmith/core')
    const db = await openCliDatabase(dbPath)
    new SkillRepository(db).create({
      id: 'matching-author/cache-matched-skill',
      name: 'cache-matched-skill',
      author: 'matching-author',
      trustTier: 'community',
    })
    db.close()

    const { getSkillDiff } = await import('../src/commands/manage.js')
    const result = await getSkillDiff('cache-matched-skill', dbPath, 'claude-code')

    // The cache-match path answered the diff (not the manifest/adoption path).
    expect(result).not.toBe('not-installed')
    expect(result).not.toBe('unresolvable')
    expect(result).not.toBe('adopted-unresolvable')
    expect(typeof result).toBe('object')
    if (typeof result === 'object' && !('adoptionError' in result)) {
      expect(result.skillId).toBe('matching-author/cache-matched-skill')
    }

    // Despite the diff resolving via the cache-match path, the skill must now
    // be TRACKED in the real, on-disk manifest — adoption ran first,
    // unconditionally, before either resolution branch.
    const manifestRaw = await readFile(path.join(homeDir, '.skillsmith', 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestRaw) as {
      installedSkills: Record<string, { id: string; version: string; source: string }>
    }
    const entry = manifest.installedSkills['cache-matched-skill']
    expect(entry).toBeDefined()
    expect(entry?.version).toBe('unknown')
    expect(entry?.source).toBe('unknown')
  })

  it('ADR-139 finding 2 (race safety): a concurrent writer that tracks the skill under lock wins over the guessed adoption entry', async () => {
    const skillDir = path.join(homeDir, '.claude', 'skills', 'race-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: race-skill\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )

    const manifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    const { ManifestManager } = await import('@skillsmith/core')

    // Wrap the REAL updateSafely() (never mocking its own logic) so that, on
    // its first real invocation from getSkillDiff()'s adoption path, a
    // SEPARATE ManifestManager instance performs a genuine concurrent write
    // (simulating a real install() landing between getSkillDiff()'s own
    // outer, unlocked manifest read and this locked write) — using the SAME
    // real acquireLock/load/save cycle — before delegating to the real
    // implementation. This exercises the REAL lock + fresh-read mechanism,
    // not a captured-and-manually-invoked callback.
    const realUpdateSafely = ManifestManager.prototype.updateSafely
    let injectedConcurrentWrite = false
    vi.spyOn(ManifestManager.prototype, 'updateSafely').mockImplementation(async function (
      this: InstanceType<typeof ManifestManager>,
      updateFn: Parameters<typeof realUpdateSafely>[0]
    ) {
      if (!injectedConcurrentWrite) {
        injectedConcurrentWrite = true
        const concurrentWriter = new ManifestManager(manifestPath)
        await realUpdateSafely.call(concurrentWriter, (current) => ({
          ...current,
          installedSkills: {
            ...current.installedSkills,
            'race-skill': {
              // A raw GitHub URL id (a real direct-URL install's manifest
              // shape) so the assertion below proves the concurrent entry
              // resolved the diff directly, without depending on a mocked
              // registry-API response for a bare author/name id.
              id: 'https://github.com/realauthor/race-skill',
              name: 'race-skill',
              version: '2.0.0',
              source: 'github:realauthor/race-skill',
              installPath: skillDir,
              installedAt: new Date().toISOString(),
              lastUpdated: new Date().toISOString(),
            },
          },
        }))
      }
      return realUpdateSafely.call(this, updateFn)
    })

    const { getSkillDiff } = await import('../src/commands/manage.js')
    const result = await getSkillDiff('race-skill', dbPath, 'claude-code')

    // The concurrent REAL entry (a genuine github: source) must win — its id
    // trusted as registry-authoritative, resolving the diff directly, NOT the
    // guessed 'unknown'-source adoption entry landing on 'adopted-unresolvable'.
    expect(result).not.toBe('adopted-unresolvable')
    expect(result).not.toBe('unresolvable')
    expect(typeof result).toBe('object')
    if (typeof result === 'object' && !('adoptionError' in result)) {
      expect(result.skillId).toBe('https://github.com/realauthor/race-skill')
    }

    // The manifest ON DISK reflects ONLY the concurrent real entry — never
    // clobbered by the guessed adoption one racing behind it.
    const manifestRaw = await readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(manifestRaw) as {
      installedSkills: Record<string, { id: string; version: string; source: string }>
    }
    const entry = manifest.installedSkills['race-skill']
    expect(entry?.id).toBe('https://github.com/realauthor/race-skill')
    expect(entry?.version).toBe('2.0.0')
    expect(entry?.source).toBe('github:realauthor/race-skill')
  })

  it('ADR-139 finding 2 (round 4 — cache-match consistency): the cache-match branch prefers a non-guessed concurrent manifest entry over an unrelated cache-matched id', async () => {
    const skillDir = path.join(homeDir, '.claude', 'skills', 'cache-and-race-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: cache-and-race-skill\nauthor: matching-author\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )

    // Seed a cache row that WOULD win the bare-name+author cache-match
    // branch on its own — this is the exact condition round 4's finding 1
    // fix already covers (adoption runs regardless). This test instead
    // proves the SIBLING round-4 finding: once adoption discovers a
    // concurrent, non-guessed, real manifest entry, the cache-match branch
    // must prefer THAT id over this cache row's, even though the cache-match
    // condition (same name, same claimed author) is independently satisfied.
    const { openCliDatabase } = await import('../src/utils/open-database.js')
    const { SkillRepository, ManifestManager } = await import('@skillsmith/core')
    const db = await openCliDatabase(dbPath)
    new SkillRepository(db).create({
      id: 'matching-author/cache-and-race-skill',
      name: 'cache-and-race-skill',
      author: 'matching-author',
      trustTier: 'community',
    })
    db.close()

    const manifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    const realUpdateSafely = ManifestManager.prototype.updateSafely
    let injectedConcurrentWrite = false
    vi.spyOn(ManifestManager.prototype, 'updateSafely').mockImplementation(async function (
      this: InstanceType<typeof ManifestManager>,
      updateFn: Parameters<typeof realUpdateSafely>[0]
    ) {
      if (!injectedConcurrentWrite) {
        injectedConcurrentWrite = true
        const concurrentWriter = new ManifestManager(manifestPath)
        await realUpdateSafely.call(concurrentWriter, (current) => ({
          ...current,
          installedSkills: {
            ...current.installedSkills,
            'cache-and-race-skill': {
              // Deliberately a DIFFERENT id than the seeded cache row's
              // 'matching-author/cache-and-race-skill' — proves the
              // assertion below is exercising id SELECTION, not a
              // coincidental match.
              id: 'https://github.com/realauthor/cache-and-race-skill',
              name: 'cache-and-race-skill',
              version: '3.0.0',
              source: 'github:realauthor/cache-and-race-skill',
              installPath: skillDir,
              installedAt: new Date().toISOString(),
              lastUpdated: new Date().toISOString(),
            },
          },
        }))
      }
      return realUpdateSafely.call(this, updateFn)
    })

    const { getSkillDiff } = await import('../src/commands/manage.js')
    const result = await getSkillDiff('cache-and-race-skill', dbPath, 'claude-code')

    expect(typeof result).toBe('object')
    if (typeof result === 'object' && !('adoptionError' in result)) {
      // The concurrent, non-guessed manifest entry wins — NOT the unrelated
      // cache-matched registry id, even though the cache-match condition
      // (same name, same claimed author) is satisfied.
      expect(result.skillId).toBe('https://github.com/realauthor/cache-and-race-skill')
      expect(result.skillId).not.toBe('matching-author/cache-and-race-skill')
    }

    const manifestRaw = await readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(manifestRaw) as {
      installedSkills: Record<string, { id: string; version: string; source: string }>
    }
    const entry = manifest.installedSkills['cache-and-race-skill']
    expect(entry?.id).toBe('https://github.com/realauthor/cache-and-race-skill')
  })
})
