/**
 * Phase 0 (SMI-5175) — cross-ecosystem path coverage + true-universe count.
 * @module scripts/tests/indexer/phase0-cross-ecosystem
 *
 * Two surfaces under test:
 *
 * 1. `FALLBACK_PATH_PREFIXES` (subdirectory-search) gains the two 2026
 *    conventions the broad-query fallback was missing: `.agent/skills`
 *    (Antigravity project-local, singular — distinct from `.agents/skills`) and
 *    `.windsurf/skills` (Windsurf native).
 *
 * 2. `countGitHubSkillFiles` (topic-search) derives its authoritative `total`
 *    from a single broad `filename:SKILL.md` query — the DISTINCT universe
 *    (~107k) — instead of summing per-path counts. GitHub code-search `path:`
 *    is a path-COMPONENT match, so the generic `skills` prefix is a superset of
 *    every `.x/skills` entry; summing double-counts. `breakdown` stays as
 *    per-ecosystem diagnostics and is NOT summed into `total`.
 *
 * The fetch layer is mocked at the `_shared/rate-limit` + `_shared/github-auth`
 * boundary so the test asserts query SHAPE + count derivation without network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

const fetchedUrls: string[] = []
// Object reference (not a primitive `let`) so the hoisted vi.mock factory reads
// live state, mirroring the `fetchedUrls` capture pattern.
const ctl = { failBroad: false }

vi.mock('../../indexer/_shared/github-auth.ts', () => ({
  buildGitHubHeaders: vi.fn(async () => ({}) as Record<string, string>),
}))

vi.mock('../../indexer/_shared/rate-limit.ts', () => ({
  GITHUB_API_DELAY: 0,
  delay: vi.fn(async () => undefined),
  withBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRateLimitTracking: vi.fn(async (_telemetry: unknown, url: string) => {
    fetchedUrls.push(url)
    // `path:` survives encodeURIComponent as `path%3A`; the broad query has none.
    const isBroad = !url.includes('path%3A')
    if (isBroad && ctl.failBroad) {
      return {
        ok: false,
        status: 403,
        headers: { get: () => '0' },
        json: async () => ({}),
      }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ total_count: isBroad ? 107_400 : 5_000 }),
    }
  }),
}))

// Imported AFTER the mocks so the SUT binds the stubbed fetch layer.
import { countGitHubSkillFiles } from '../../indexer/topic-search.ts'
import { FALLBACK_PATH_PREFIXES } from '../../indexer/subdirectory-search.ts'

const noTelemetry = {} as RateLimitTelemetry

describe('SMI-5175: FALLBACK_PATH_PREFIXES cross-ecosystem coverage', () => {
  it('includes the two previously-missing 2026 conventions', () => {
    expect(FALLBACK_PATH_PREFIXES).toContain('.agent/skills')
    expect(FALLBACK_PATH_PREFIXES).toContain('.windsurf/skills')
  })

  it('keeps `.agent/skills` and `.agents/skills` as distinct entries', () => {
    expect(FALLBACK_PATH_PREFIXES).toContain('.agent/skills')
    expect(FALLBACK_PATH_PREFIXES).toContain('.agents/skills')
  })

  it('retains every prior convention (no regression)', () => {
    for (const prefix of [
      '.gemini/skills',
      '.github/skills',
      'skills',
      '.agents/skills',
      '.codex/skills',
      '.cursor/skills',
      '.ai/skills',
    ]) {
      expect(FALLBACK_PATH_PREFIXES).toContain(prefix)
    }
  })
})

describe('SMI-5175: countGitHubSkillFiles true-universe count', () => {
  beforeEach(() => {
    fetchedUrls.length = 0
    ctl.failBroad = false
  })

  it('derives total from the broad filename:SKILL.md query, not a path: sum', async () => {
    const { total, breakdown } = await countGitHubSkillFiles(noTelemetry)
    expect(total).toBe(107_400)
    const breakdownSum = Object.values(breakdown).reduce((acc, n) => acc + n, 0)
    // The whole point of the fix: total is the distinct universe, not the sum.
    expect(total).not.toBe(breakdownSum)
  })

  it('issues exactly one broad (no path:) code-search query', async () => {
    await countGitHubSkillFiles(noTelemetry)
    const broad = fetchedUrls.filter((u) => !u.includes('path%3A'))
    expect(broad).toHaveLength(1)
    expect(broad[0]).toContain('filename%3ASKILL.md')
  })

  it('reports per-ecosystem breakdown for all indexed conventions incl. the new ones', async () => {
    const { breakdown } = await countGitHubSkillFiles(noTelemetry)
    for (const prefix of [
      '.claude/skills',
      '.agents/skills',
      '.github/skills',
      '.agent/skills',
      '.codex/skills',
      '.cursor/skills',
      '.gemini/skills',
      '.windsurf/skills',
      '.ai/skills',
    ]) {
      expect(breakdown[prefix]).toBe(5_000)
    }
  })

  it('excludes the generic `skills` superset from the breakdown (no double-count)', async () => {
    const { breakdown } = await countGitHubSkillFiles(noTelemetry)
    expect(breakdown['skills']).toBeUndefined()
  })

  it('degrades gracefully when the broad query fails (total 0, breakdown + error)', async () => {
    ctl.failBroad = true
    const { total, breakdown, error } = await countGitHubSkillFiles(noTelemetry)
    // Broad query 403'd → no authoritative total, but the run does not throw.
    expect(total).toBe(0)
    // The per-ecosystem breakdown phase still runs (the delay/loop are unconditional).
    expect(breakdown['.claude/skills']).toBe(5_000)
    // The failure is surfaced to the caller rather than swallowed.
    expect(error).toBeDefined()
    expect(error).toContain('403')
  })
})
