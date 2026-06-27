/**
 * Unit tests for src/services/manifestReader.ts (SMI-5412).
 *
 * All filesystem access is exercised through vi.mock so no real disk I/O
 * occurs. fetch is replaced with a vi.fn() stub. AbortSignal.timeout is
 * available in Node 18+ (the project minimum) and is not mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── node:fs/promises mock ─────────────────────────────────────────────────────
const readFile = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', () => ({ readFile }))

// ── node:os mock ──────────────────────────────────────────────────────────────
vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }))

// ── SUT ───────────────────────────────────────────────────────────────────────
import {
  buildRawGitHubUrl,
  fetchRawSkillMd,
  readManifestEntry,
} from '../../services/manifestReader.js'

// ── Global fetch stub ─────────────────────────────────────────────────────────
const mockFetch = vi.fn()

// ─────────────────────────────────────────────────────────────────────────────
// buildRawGitHubUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRawGitHubUrl', () => {
  it('converts a bare github.com repo URL to a raw main-branch URL', () => {
    expect(buildRawGitHubUrl('https://github.com/owner/repo')).toBe(
      'https://raw.githubusercontent.com/owner/repo/main/SKILL.md'
    )
  })

  it('honours an explicit /tree/<branch> in the source URL', () => {
    expect(buildRawGitHubUrl('https://github.com/owner/repo/tree/my-branch')).toBe(
      'https://raw.githubusercontent.com/owner/repo/my-branch/SKILL.md'
    )
  })

  it('uses the caller-supplied branch when the URL has no /tree/<ref>', () => {
    expect(buildRawGitHubUrl('https://github.com/owner/repo', 'master')).toBe(
      'https://raw.githubusercontent.com/owner/repo/master/SKILL.md'
    )
  })

  it('passes through an already-raw githubusercontent URL unchanged', () => {
    const raw = 'https://raw.githubusercontent.com/owner/repo/main/SKILL.md'
    expect(buildRawGitHubUrl(raw)).toBe(raw)
  })

  it('returns null for non-GitHub URLs', () => {
    expect(buildRawGitHubUrl('https://gitlab.com/owner/repo')).toBeNull()
    expect(buildRawGitHubUrl('https://example.com')).toBeNull()
    expect(buildRawGitHubUrl('')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// readManifestEntry
// ─────────────────────────────────────────────────────────────────────────────

const ENTRY_A = {
  id: 'uuid-aaa',
  name: 'My Skill',
  source: 'https://github.com/owner/my-skill',
  installPath: '/home/testuser/.claude/skills/my-skill',
}

const ENTRY_B = {
  id: 'uuid-bbb',
  name: 'Another Skill',
  source: 'https://github.com/owner/another',
  installPath: '/home/testuser/.claude/skills/another',
}

const MANIFEST_JSON = JSON.stringify({
  installedSkills: {
    'my-skill': ENTRY_A,
    another: ENTRY_B,
  },
})

describe('readManifestEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches by installPath (highest priority)', async () => {
    readFile.mockResolvedValue(MANIFEST_JSON)
    const result = await readManifestEntry({
      name: 'My Skill',
      id: 'uuid-aaa',
      path: '/home/testuser/.claude/skills/my-skill',
    })
    expect(result).toEqual(ENTRY_A)
  })

  it('falls back to name match when installPath does not match', async () => {
    readFile.mockResolvedValue(MANIFEST_JSON)
    const result = await readManifestEntry({
      name: 'Another Skill',
      id: 'different-id',
      path: '/completely/different/path',
    })
    expect(result).toEqual(ENTRY_B)
  })

  it('falls back to id match when neither installPath nor name match', async () => {
    readFile.mockResolvedValue(MANIFEST_JSON)
    const result = await readManifestEntry({
      name: 'Unknown Name',
      id: 'uuid-aaa',
      path: '/completely/different/path',
    })
    expect(result).toEqual(ENTRY_A)
  })

  it('returns null when no entry matches any field', async () => {
    readFile.mockResolvedValue(MANIFEST_JSON)
    const result = await readManifestEntry({
      name: 'No Match',
      id: 'no-match-id',
      path: '/no/match/path',
    })
    expect(result).toBeNull()
  })

  it('returns null when the manifest file does not exist (ENOENT)', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const result = await readManifestEntry({ name: 'Any', id: 'any', path: '/any' })
    expect(result).toBeNull()
  })

  it('returns null when the manifest JSON is malformed', async () => {
    readFile.mockResolvedValue('not-valid-json{{{')
    const result = await readManifestEntry({ name: 'Any', id: 'any', path: '/any' })
    expect(result).toBeNull()
  })

  it('reads from ~/.skillsmith/manifest.json', async () => {
    readFile.mockResolvedValue(MANIFEST_JSON)
    await readManifestEntry({ name: 'My Skill', id: 'uuid-aaa', path: '/some/path' })
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining('.skillsmith/manifest.json'),
      'utf-8'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fetchRawSkillMd
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchRawSkillMd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches from main branch and returns text on success', async () => {
    const SKILL_MD = '# My Skill\n\nLatest content.'
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(SKILL_MD),
    })

    const result = await fetchRawSkillMd('https://github.com/owner/repo')

    expect(result).toBe(SKILL_MD)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
      expect.objectContaining({ headers: { Accept: 'text/plain' } })
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to master on a 404 from main', async () => {
    const SKILL_MD = '# Master Branch Skill'
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(SKILL_MD),
    })

    const result = await fetchRawSkillMd('https://github.com/owner/repo')

    expect(result).toBe(SKILL_MD)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://raw.githubusercontent.com/owner/repo/master/SKILL.md',
      expect.anything()
    )
  })

  it('returns null when both main and master return 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 })
    const result = await fetchRawSkillMd('https://github.com/owner/repo')
    expect(result).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns null immediately on a non-404 server error (no master retry)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 })
    const result = await fetchRawSkillMd('https://github.com/owner/repo')
    expect(result).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns null when fetch throws a network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    const result = await fetchRawSkillMd('https://github.com/owner/repo')
    expect(result).toBeNull()
  })

  it('returns null without fetching for a non-GitHub source URL', async () => {
    const result = await fetchRawSkillMd('https://gitlab.com/owner/repo')
    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
