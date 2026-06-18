/**
 * Unit tests for trees-enumerate.ts (SMI-5286 Wave 1a)
 *
 * Exercises enumerateRepoSkillPaths through a stubbed fetchSkillPathsFromTree:
 *   - Ancestor-only denylist: the key false-positive guard (Edit D)
 *   - Per-repo cap: first N by path-sort + truncatedByCap flag
 *   - Truncation policy (b): API-truncated tree → EMPTY entries + truncatedByApi flag
 *   - Happy path: valid entries pass through unchanged
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

// ---------------------------------------------------------------------------
// Mock fetchSkillPathsFromTree (and the rate-limit layer it uses internally)
// ---------------------------------------------------------------------------

// We need to control what fetchSkillPathsFromTree returns. Because
// trees-enumerate.ts imports it directly, we mock the whole module.
const mockFetchSkillPathsFromTree = vi.fn()

vi.mock('../../indexer/trees-search.ts', () => ({
  fetchSkillPathsFromTree: (...args: unknown[]) => mockFetchSkillPathsFromTree(...args),
}))

// trees-enumerate.ts does NOT call withRateLimitTracking directly (it delegates
// to fetchSkillPathsFromTree), so no rate-limit mock is required here.

// Imported AFTER mocks so the SUT binds the stub.
import { enumerateRepoSkillPaths, type EnumerateTelemetry } from '../../indexer/trees-enumerate.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noTelemetry: RateLimitTelemetry = {} as RateLimitTelemetry

function makeEntry(path: string, blobSha = 'abc123') {
  return { path, blobSha }
}

function freshEnumerateTelemetry(): EnumerateTelemetry {
  return {}
}

// ---------------------------------------------------------------------------
// Ancestor-only denylist (Edit D — the key false-positive guard)
// ---------------------------------------------------------------------------

describe('enumerateRepoSkillPaths — ancestor-only denylist (SMI-5286 Edit D)', () => {
  beforeEach(() => {
    mockFetchSkillPathsFromTree.mockReset()
  })

  /**
   * Tree contains:
   *   DROPPED — denylisted word IS an ancestor:
   *     examples/foo           ← "examples" is ancestor of "foo"
   *     a/templates/b          ← "templates" is ancestor of "b"
   *     x/fixtures             ← one segment and it IS the skill's own leaf? No —
   *                              "fixtures" is the only segment (the leaf), so
   *                              the rule says: check segments EXCEPT the last.
   *                              Wait: x/fixtures has two segments ("x","fixtures")
   *                              — last is "fixtures" (leaf, skipped), first is "x"
   *                              (not in denylist) → should be KEPT.
   *     pkg/test               ← "test" is ancestor of nothing (leaf) → KEPT
   *
   * Re-reading the spec carefully:
   *   "examples/foo"         → segments ["examples","foo"] → check [0..-2] = ["examples"] → DROPPED
   *   "a/templates/b"        → segments ["a","templates","b"] → check ["a","templates"] → DROPPED
   *   "x/fixtures/SKILL.md" input means skillPath = "x/fixtures"
   *                          → segments ["x","fixtures"] → check ["x"] → NOT denylist → KEPT
   *   "pkg/test/SKILL.md"   → skillPath = "pkg/test"
   *                          → segments ["pkg","test"] → check ["pkg"] → NOT denylist → KEPT
   *
   * So for paths the spec task says should be DROPPED:
   *   examples/foo               → ancestor "examples" → DROPPED
   *   a/templates/b              → ancestor "templates" → DROPPED
   *   x/fixtures (one level up)  → need "fixtures" to be an ANCESTOR not the leaf
   *     → use path "x/fixtures/real" so "fixtures" is an ancestor → DROPPED
   *   pkg/test (one level up)    → use "test/pkg/real" so "test" is ancestor → DROPPED
   *
   * KEPT (denylisted word is the skill's own leaf dir, NOT an ancestor):
   *   .agents/skills/test-runner        → leaf is "test-runner", ancestors: ".agents","skills"
   *   .claude/skills/examples-helper    → leaf is "examples-helper", ancestors: ".claude","skills"
   *   src/real                          → no denylist ancestors
   */
  it('drops entries where a denylist word is a strict ANCESTOR dir, keeps entries where it is the leaf or a non-ancestor substring', async () => {
    // These FOUR should be dropped (denylist word appears as ancestor):
    const dropped = [
      makeEntry('examples/foo'), // "examples" is ancestor
      makeEntry('a/templates/b'), // "templates" is ancestor
      makeEntry('x/fixtures/real'), // "fixtures" is ancestor
      makeEntry('test/pkg/real'), // "test" is ancestor
    ]

    // These THREE should be kept (denylist word is the LEAF or a non-ancestor substring):
    const kept = [
      makeEntry('.agents/skills/test-runner'), // leaf = "test-runner", ancestors have no denylist
      makeEntry('.claude/skills/examples-helper'), // leaf = "examples-helper", no denylist ancestor
      makeEntry('src/real'), // no denylist word at all
    ]

    mockFetchSkillPathsFromTree.mockResolvedValue({
      entries: [...dropped, ...kept],
      truncated: false,
    })

    const tel = freshEnumerateTelemetry()
    const result = await enumerateRepoSkillPaths('owner', 'repo', 'main', noTelemetry, tel)

    // All 3 kept paths survive
    const paths = result.entries.map((e) => e.path)
    expect(paths).toContain('.agents/skills/test-runner')
    expect(paths).toContain('.claude/skills/examples-helper')
    expect(paths).toContain('src/real')

    // All 4 dropped paths are absent
    expect(paths).not.toContain('examples/foo')
    expect(paths).not.toContain('a/templates/b')
    expect(paths).not.toContain('x/fixtures/real')
    expect(paths).not.toContain('test/pkg/real')

    expect(result.entries).toHaveLength(3)

    // Telemetry: denylistSkipped = 4
    expect(tel.denylistSkipped).toBe(4)
    expect(tel.denylistSkippedSample).toBeDefined()
    expect(tel.denylistSkippedSample!.length).toBe(4)
    // Sample entries contain owner/repo:path format
    expect(tel.denylistSkippedSample![0]).toMatch(/^owner\/repo:/)

    // No cap/truncation
    expect(result.truncatedByCap).toBe(false)
    expect(result.truncatedByApi).toBe(false)
  })

  it('accumulates denylistSkipped across multiple calls into the same telemetry object', async () => {
    const tel = freshEnumerateTelemetry()

    mockFetchSkillPathsFromTree.mockResolvedValue({
      entries: [makeEntry('examples/one'), makeEntry('examples/two')],
      truncated: false,
    })
    await enumerateRepoSkillPaths('o', 'r1', 'main', noTelemetry, tel)

    mockFetchSkillPathsFromTree.mockResolvedValue({
      entries: [makeEntry('templates/three')],
      truncated: false,
    })
    await enumerateRepoSkillPaths('o', 'r2', 'main', noTelemetry, tel)

    expect(tel.denylistSkipped).toBe(3)
    expect(tel.denylistSkippedSample!.length).toBe(3)
  })

  it('does not exceed DENYLIST_SAMPLE_LIMIT (20) in the sample even with many drops', async () => {
    const lotsOfDropped = Array.from({ length: 30 }, (_, i) => makeEntry(`examples/skill-${i}`))
    mockFetchSkillPathsFromTree.mockResolvedValue({
      entries: lotsOfDropped,
      truncated: false,
    })

    const tel = freshEnumerateTelemetry()
    await enumerateRepoSkillPaths('o', 'r', 'main', noTelemetry, tel)

    expect(tel.denylistSkipped).toBe(30)
    // Sample is capped at 20
    expect(tel.denylistSkippedSample!.length).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Per-repo cap
// ---------------------------------------------------------------------------

describe('enumerateRepoSkillPaths — per-repo cap', () => {
  beforeEach(() => {
    mockFetchSkillPathsFromTree.mockReset()
  })

  it('with cap=2 and 5 valid entries returns the first 2 by path-sort and sets truncatedByCap', async () => {
    // Deliberately out of order — path-sort determines which 2 survive
    const entries = [
      makeEntry('z/skill'),
      makeEntry('a/skill'),
      makeEntry('m/skill'),
      makeEntry('b/skill'),
      makeEntry('c/skill'),
    ]
    mockFetchSkillPathsFromTree.mockResolvedValue({ entries, truncated: false })

    const tel = freshEnumerateTelemetry()
    const result = await enumerateRepoSkillPaths('o', 'r', 'main', noTelemetry, tel, 2)

    expect(result.entries).toHaveLength(2)
    // First two alphabetically
    expect(result.entries[0].path).toBe('a/skill')
    expect(result.entries[1].path).toBe('b/skill')
    expect(result.truncatedByCap).toBe(true)
    expect(result.truncatedByApi).toBe(false)
    expect(tel.cappedRepoCount).toBe(1)
  })

  it('does NOT set truncatedByCap when entry count equals cap exactly', async () => {
    const entries = [makeEntry('a/skill'), makeEntry('b/skill')]
    mockFetchSkillPathsFromTree.mockResolvedValue({ entries, truncated: false })

    const tel = freshEnumerateTelemetry()
    const result = await enumerateRepoSkillPaths('o', 'r', 'main', noTelemetry, tel, 2)

    expect(result.entries).toHaveLength(2)
    expect(result.truncatedByCap).toBe(false)
    expect(tel.cappedRepoCount).toBeUndefined()
  })

  it('uses default cap of 50 when none provided', async () => {
    const entries = Array.from({ length: 51 }, (_, i) =>
      makeEntry(`skill-${String(i).padStart(3, '0')}/foo`)
    )
    mockFetchSkillPathsFromTree.mockResolvedValue({ entries, truncated: false })

    const tel = freshEnumerateTelemetry()
    const result = await enumerateRepoSkillPaths('o', 'r', 'main', noTelemetry, tel)

    expect(result.entries).toHaveLength(50)
    expect(result.truncatedByCap).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Truncation policy (b): API-truncated → EMPTY + truncatedByApi
// ---------------------------------------------------------------------------

describe('enumerateRepoSkillPaths — truncation policy (b) (SMI-5286 §#4)', () => {
  beforeEach(() => {
    mockFetchSkillPathsFromTree.mockReset()
  })

  it('when Trees API is truncated: entries is EMPTY and truncatedByApi is true (no partial set)', async () => {
    // Even if the API returned some entries (partial), policy (b) emits none.
    mockFetchSkillPathsFromTree.mockResolvedValue({
      entries: [makeEntry('a/skill'), makeEntry('b/skill')],
      truncated: true,
    })

    const tel = freshEnumerateTelemetry()
    const result = await enumerateRepoSkillPaths('o', 'r', 'main', noTelemetry, tel)

    expect(result.entries).toHaveLength(0)
    expect(result.truncatedByApi).toBe(true)
    expect(result.truncatedByCap).toBe(false)
    expect(tel.truncatedRepoCount).toBe(1)
  })

  it('accumulates truncatedRepoCount across calls', async () => {
    mockFetchSkillPathsFromTree.mockResolvedValue({
      entries: [],
      truncated: true,
    })

    const tel = freshEnumerateTelemetry()
    await enumerateRepoSkillPaths('o', 'r1', 'main', noTelemetry, tel)
    await enumerateRepoSkillPaths('o', 'r2', 'main', noTelemetry, tel)

    expect(tel.truncatedRepoCount).toBe(2)
  })

  it('when not truncated: truncatedByApi is false and entries are returned normally', async () => {
    mockFetchSkillPathsFromTree.mockResolvedValue({
      entries: [makeEntry('foo/bar')],
      truncated: false,
    })

    const tel = freshEnumerateTelemetry()
    const result = await enumerateRepoSkillPaths('o', 'r', 'main', noTelemetry, tel)

    expect(result.truncatedByApi).toBe(false)
    expect(result.entries).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('enumerateRepoSkillPaths — happy path', () => {
  beforeEach(() => {
    mockFetchSkillPathsFromTree.mockReset()
  })

  it('returns 3 distinct entries with correct path and blobSha from a clean tree', async () => {
    const entries = [
      { path: '.agents/skills/foo', blobSha: 'sha1' },
      { path: '.agents/skills/bar', blobSha: 'sha2' },
      { path: '.claude/skills/baz', blobSha: 'sha3' },
    ]
    mockFetchSkillPathsFromTree.mockResolvedValue({ entries, truncated: false })

    const tel = freshEnumerateTelemetry()
    const result = await enumerateRepoSkillPaths('o', 'r', 'main', noTelemetry, tel)

    expect(result.entries).toHaveLength(3)
    expect(result.entries[0]).toEqual({ path: '.agents/skills/foo', blobSha: 'sha1' })
    expect(result.entries[1]).toEqual({ path: '.agents/skills/bar', blobSha: 'sha2' })
    expect(result.entries[2]).toEqual({ path: '.claude/skills/baz', blobSha: 'sha3' })
    expect(result.truncatedByCap).toBe(false)
    expect(result.truncatedByApi).toBe(false)
    expect(tel.denylistSkipped).toBeUndefined()
    expect(tel.cappedRepoCount).toBeUndefined()
    expect(tel.truncatedRepoCount).toBeUndefined()
  })

  it('passes owner, repo, branch and telemetry through to fetchSkillPathsFromTree', async () => {
    mockFetchSkillPathsFromTree.mockResolvedValue({ entries: [], truncated: false })

    const tel = freshEnumerateTelemetry()
    await enumerateRepoSkillPaths('myorg', 'myrepo', 'develop', noTelemetry, tel)

    expect(mockFetchSkillPathsFromTree).toHaveBeenCalledWith(
      'myorg',
      'myrepo',
      'develop',
      noTelemetry
    )
  })
})
