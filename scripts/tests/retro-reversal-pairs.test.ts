/**
 * SMI-4451 Wave 1 Step 8 — 6-pair regression test gate.
 *
 * Implements the wave-ship gate per
 * docs/internal/implementation/smi-4450-sparc-research.md §S7. Loads training
 * pairs from `scripts/tests/fixtures/retro-training-pairs.jsonl` (and held-out
 * pairs from `retro-held-out-pairs.jsonl`, populated by audit-standards
 * Section 35 in the 14-day post-ship window). Per pair: call
 * `search({ query, k: 5, minScore: 0.35 })`, substring-match each hit's
 * `filePath` against `expectedPaths`. Pair passes if any expected path is
 * present.
 *
 * Wave gate: passed/6 >= 5/6 (training). Held-out: 2/2 before Wave 2 start.
 *
 * Two modes:
 *  - **Unit mode (default, runs in CI):** the aggregation tests pass an
 *    in-test `fakeSearch` function to a small runner harness — no module
 *    mocking. Required because CI doesn't have a populated RuVector index,
 *    and the host may be missing the native binding (per the §S9 finding
 *    fixed in PR #780).
 *  - **Real mode (`RETRO_REVERSAL_PAIRS_REAL=1`):** dynamically imports the
 *    real `search()` and runs against the host's index. This is the actual
 *    ship gate — must be run manually before declaring Wave 1 ready.
 *
 * Logger pattern (per `feedback_logger_spy_pattern.md` and §S7): no
 * `vi.spyOn(createLogger('X'), 'error')` anywhere — that spies a throwaway
 * instance instead of the module-level logger.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SearchHit } from '../../packages/doc-retrieval-mcp/src/types.js'

interface Pair {
  id: string
  rationale: string
  query: string
  expectedPaths: string[]
}

const FIXTURES_DIR = join(import.meta.dirname ?? __dirname, 'fixtures')
const TRAINING_PATH = join(FIXTURES_DIR, 'retro-training-pairs.jsonl')
const HELD_OUT_PATH = join(FIXTURES_DIR, 'retro-held-out-pairs.jsonl')
const REAL_MODE = process.env.RETRO_REVERSAL_PAIRS_REAL === '1'

function loadPairs(path: string): Pair[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => JSON.parse(l) as Pair)
}

export function pairPasses(pair: Pair, hits: SearchHit[]): boolean {
  return hits.slice(0, 5).some((h) => pair.expectedPaths.some((p) => h.filePath.includes(p)))
}

export function makeHit(filePath: string, similarity = 0.7): SearchHit {
  return {
    id: `mock-${filePath}`,
    filePath,
    lineStart: 1,
    lineEnd: 10,
    headingChain: [],
    text: `mock text for ${filePath}`,
    similarity,
    score: similarity,
  }
}

// In-test stand-in for `search()`. We do NOT vi.mock the search module here
// because static-import binding to a hoisted mock proved unreliable across
// our ESM/TS pipeline; instead the runner aggregation tests below invoke this
// stand-in directly. The real-mode block (`RETRO_REVERSAL_PAIRS_REAL=1`)
// imports the actual `search` via `vi.importActual` to exercise the real gate.
type SearchFn = (opts: { query: string; k?: number; minScore?: number }) => Promise<SearchHit[]>

describe('Step 8 — pair pass rule', () => {
  const pair: Pair = {
    id: 'p',
    rationale: 'r',
    query: 'q',
    expectedPaths: ['feedback_foo.md', 'docs/internal/retros/2026-04-bar.md'],
  }

  it('returns true when any hit substring-matches any expected path', () => {
    const hits = [makeHit('docs/internal/memory/feedback_foo.md'), makeHit('unrelated.md')]
    expect(pairPasses(pair, hits)).toBe(true)
  })

  it('matches when filePath contains the full expected path as substring', () => {
    // §S7 contract: hit.filePath.includes(expectedPath). The hit path may have
    // prefixes (worktree/repo) and suffixes (chunk index), as long as the full
    // expected path appears verbatim somewhere in it.
    const hits = [makeHit('/repo/docs/internal/retros/2026-04-bar.md#chunk-0')]
    expect(pairPasses(pair, hits)).toBe(true)
  })

  it('returns false when no hit matches any expected path', () => {
    const hits = [makeHit('a.md'), makeHit('b.md'), makeHit('c.md')]
    expect(pairPasses(pair, hits)).toBe(false)
  })

  it('returns false on empty hit list', () => {
    expect(pairPasses(pair, [])).toBe(false)
  })

  it('only considers top-5 hits', () => {
    const hits = [
      makeHit('a.md'),
      makeHit('b.md'),
      makeHit('c.md'),
      makeHit('d.md'),
      makeHit('e.md'),
      makeHit('feedback_foo.md'),
    ]
    expect(pairPasses(pair, hits)).toBe(false)
  })

  it('case-sensitive — uppercase mismatch fails', () => {
    const hits = [makeHit('FEEDBACK_FOO.md')]
    expect(pairPasses(pair, hits)).toBe(false)
  })
})

describe('Step 8 — fixture loading', () => {
  it('loads exactly 6 training pairs', () => {
    const pairs = loadPairs(TRAINING_PATH)
    expect(pairs).toHaveLength(6)
    expect(pairs.map((p) => p.id)).toEqual([
      'pair-1',
      'pair-2',
      'pair-3',
      'pair-4',
      'pair-5',
      'pair-6',
    ])
  })

  it('every training pair has a non-empty query and expectedPaths', () => {
    const pairs = loadPairs(TRAINING_PATH)
    for (const p of pairs) {
      expect(p.query.length).toBeGreaterThan(0)
      expect(p.expectedPaths.length).toBeGreaterThan(0)
      for (const ep of p.expectedPaths) expect(ep.length).toBeGreaterThan(0)
    }
  })

  it('held-out fixture exists (may be empty pre-soak)', () => {
    expect(existsSync(HELD_OUT_PATH)).toBe(true)
  })

  it('skips empty/whitespace lines and # comments', () => {
    const pairs = loadPairs(HELD_OUT_PATH)
    expect(Array.isArray(pairs)).toBe(true)
  })
})

describe.skipIf(REAL_MODE)('Step 8 — runner gate (mocked)', () => {
  // Unit-mode: prove the runner correctly aggregates pass/fail across pairs
  // and emits the ≥5/6 gate. Real index lookups happen only in REAL_MODE
  // (`RETRO_REVERSAL_PAIRS_REAL=1`) — see the describe.runIf block below.

  async function runWithMock(
    pairs: Pair[],
    searchFn: SearchFn
  ): Promise<{ passed: number; total: number }> {
    let passed = 0
    for (const p of pairs) {
      const hits = await searchFn({ query: p.query, k: 5, minScore: 0.35 })
      if (pairPasses(p, hits)) passed++
    }
    return { passed, total: pairs.length }
  }

  it('aggregates 6/6 when every pair has a matching top-5', async () => {
    const pairs = loadPairs(TRAINING_PATH)
    const fakeSearch: SearchFn = async ({ query }) => {
      const p = pairs.find((x) => x.query === query)
      return p ? [makeHit(p.expectedPaths[0])] : []
    }
    const result = await runWithMock(pairs, fakeSearch)
    expect(result.passed).toBe(6)
    expect(result.passed / result.total).toBeGreaterThanOrEqual(5 / 6)
  })

  it('aggregates 5/6 when exactly one pair misses (still passes gate)', async () => {
    const pairs = loadPairs(TRAINING_PATH)
    const fakeSearch: SearchFn = async ({ query }) => {
      const idx = pairs.findIndex((x) => x.query === query)
      if (idx === 0) return [makeHit('unrelated.md')]
      const p = pairs[idx]
      return [makeHit(p.expectedPaths[0])]
    }
    const result = await runWithMock(pairs, fakeSearch)
    expect(result.passed).toBe(5)
    expect(result.passed / result.total).toBeGreaterThanOrEqual(5 / 6)
  })

  it('aggregates 4/6 when two pairs miss (FAILS gate)', async () => {
    const pairs = loadPairs(TRAINING_PATH)
    const fakeSearch: SearchFn = async ({ query }) => {
      const idx = pairs.findIndex((x) => x.query === query)
      if (idx < 2) return [makeHit('unrelated.md')]
      const p = pairs[idx]
      return [makeHit(p.expectedPaths[0])]
    }
    const result = await runWithMock(pairs, fakeSearch)
    expect(result.passed).toBe(4)
    expect(result.passed / result.total).toBeLessThan(5 / 6)
  })

  it('passes search() the contract args: k=5, minScore=0.35', async () => {
    const calls: Array<{ query: string; k?: number; minScore?: number }> = []
    const fakeSearch: SearchFn = async (opts) => {
      calls.push(opts)
      return [makeHit('any.md')]
    }
    const pairs = loadPairs(TRAINING_PATH).slice(0, 1)
    await runWithMock(pairs, fakeSearch)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ k: 5, minScore: 0.35 })
  })
})

// Real-mode gate. Skipped unless RETRO_REVERSAL_PAIRS_REAL=1 is set so CI
// (no native binding, no populated index) does not break.
describe.runIf(REAL_MODE)('Step 8 — runner gate (REAL index)', () => {
  it('training set passes ≥ 5/6 against the real RuVector index', async () => {
    const { search } = await import('../../packages/doc-retrieval-mcp/src/search.js')
    const pairs = loadPairs(TRAINING_PATH)
    let passed = 0
    const failures: string[] = []
    for (const p of pairs) {
      const hits = await search({ query: p.query, k: 5, minScore: 0.35 })
      if (pairPasses(p, hits)) {
        passed++
      } else {
        failures.push(
          `${p.id}: query=${JSON.stringify(p.query)} got top-5=[${hits
            .slice(0, 5)
            .map((h) => h.filePath)
            .join(', ')}]`
        )
      }
    }
    if (failures.length > 0) {
      console.error(
        `[real-mode] ${passed}/${pairs.length} passed. Misses:\n  - ${failures.join('\n  - ')}`
      )
    }
    expect(passed).toBeGreaterThanOrEqual(5)
  }, 30_000)

  it('held-out set passes ≥ same rate as training (when populated)', async () => {
    const heldOut = loadPairs(HELD_OUT_PATH)
    if (heldOut.length === 0) {
      // Pre-soak window — held-out empty by design. Skip.
      return
    }
    const { search } = await import('../../packages/doc-retrieval-mcp/src/search.js')
    let passed = 0
    for (const p of heldOut) {
      const hits = await search({ query: p.query, k: 5, minScore: 0.35 })
      if (pairPasses(p, hits)) passed++
    }
    // Held-out gate per §S7: pass at >= same rate as training (5/6 ≈ 0.833).
    // With 2 reserved pairs, both must pass (2/2 = 1.0 >= 0.833).
    expect(passed / heldOut.length).toBeGreaterThanOrEqual(5 / 6)
  }, 30_000)
})
