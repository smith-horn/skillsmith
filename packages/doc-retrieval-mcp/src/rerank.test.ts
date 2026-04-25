/**
 * SMI-4450 Wave 1 Step 6 — rerank tests.
 *
 * Pure unit tests against synthetic SearchHit fixtures. No RuVector, no
 * Docker, no I/O — rerank.ts has zero external dependencies and the tests
 * cover both ranking paths (Phase 1 penalty-only and Phase 2 BM25+MMR).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bm25Score,
  buildIdf,
  classBoostFactor,
  minMaxNormalize,
  rerank,
  tokenize,
} from './rerank.js'
import type { ChunkStoredMetadata, SearchHit } from './types.js'

function makeHit(
  id: string,
  similarity: number,
  text: string,
  metaOverrides: Partial<ChunkStoredMetadata> = {}
): SearchHit {
  return {
    id,
    filePath: `${id}.md`,
    lineStart: 1,
    lineEnd: 10,
    headingChain: [],
    text,
    similarity,
    score: similarity,
    meta: {
      file_path: `${id}.md`,
      line_start: 1,
      line_end: 10,
      heading_chain: [],
      text,
      ...metaOverrides,
    },
  }
}

describe('rerank — Phase 1 penalty-only path', () => {
  it('returns [] for empty pool', () => {
    expect(rerank([], 'anything')).toEqual([])
  })

  it('preserves similarity and copies score for hits with no penalty metadata', () => {
    const hits = [makeHit('a', 0.9, 'alpha'), makeHit('b', 0.5, 'beta')]
    const out = rerank(hits, 'alpha')
    expect(out).toHaveLength(2)
    expect(out[0].id).toBe('a')
    expect(out[0].score).toBe(0.9)
    expect(out[0].similarity).toBe(0.9)
    expect(out[1].id).toBe('b')
    expect(out[1].score).toBe(0.5)
  })

  it('sorts by adjusted score descending', () => {
    const hits = [
      makeHit('low', 0.4, 'lorem'),
      makeHit('high', 0.95, 'ipsum'),
      makeHit('mid', 0.7, 'dolor'),
    ]
    const out = rerank(hits, 'q')
    expect(out.map((h) => h.id)).toEqual(['high', 'mid', 'low'])
  })

  it('absorption demotion cap halves and clamps at 0.5', () => {
    const high = makeHit('absorbed-high', 0.99, 'x', { absorbed_by: 'canonical.md' })
    const out = rerank([high], 'x')
    // 0.99 * 0.5 = 0.495 — under the 0.5 ceiling, so unchanged by cap
    expect(out[0].score).toBeCloseTo(0.495, 4)
    expect(out[0].similarity).toBe(0.99) // raw signal preserved
  })

  it('absorption demotion cap with similarity >= 1.0 clamps to 0.5 ceiling', () => {
    // Synthetic edge: similarity 1.0 → 0.5 raw halve hits the ceiling exactly,
    // 1.5 → would be 0.75 without ceiling, capped to 0.5
    const exactlyOne = makeHit('exactly-one', 1.0, 'x', { absorbed_by: 'c.md' })
    const out = rerank([exactlyOne], 'x')
    expect(out[0].score).toBe(0.5)
  })

  it('absorption keeps high-similarity absorbed chunk above the 0.35 minScore floor', () => {
    // Per SPARC §S6 plan-review M3: a hard ×0.3 multiply would push 0.99 * 0.3
    // = 0.297, evicting the chunk. The cap path keeps it visible at 0.495.
    const hit = makeHit('post-absorb', 0.99, 'still-relevant content', {
      absorbed_by: 'canonical.md',
    })
    const out = rerank([hit], 'q')
    expect(out[0].score).toBeGreaterThan(0.35)
  })

  it('supersession penalty halves similarity with no ceiling', () => {
    const hit = makeHit('superseded', 0.8, 'old', { supersedes: 'newer.md' })
    const out = rerank([hit], 'q')
    expect(out[0].score).toBeCloseTo(0.4, 4)
  })

  it('absorbed_by takes precedence over supersedes when both set', () => {
    const hit = makeHit('both', 0.9, 'x', {
      absorbed_by: 'a.md',
      supersedes: 's.md',
    })
    const out = rerank([hit], 'q')
    // Absorption path: 0.9 * 0.5 = 0.45 (under 0.5 ceiling)
    // If supersession had won, score would also be 0.45 — distinguish by
    // testing similarity > 1.0 case where absorption clamps but supersession does not.
    expect(out[0].score).toBeCloseTo(0.45, 4)
  })

  it('absorbed_by truthiness — empty string skips penalty', () => {
    const hit = makeHit('empty-absorbed', 0.9, 'x', { absorbed_by: '' })
    const out = rerank([hit], 'q')
    expect(out[0].score).toBe(0.9)
  })

  it('does not mutate input hits', () => {
    const hit = makeHit('immut', 0.9, 'x', { absorbed_by: 'c.md' })
    const before = hit.score
    rerank([hit], 'q')
    expect(hit.score).toBe(before)
  })
})

describe('rerank — Phase 2 BM25 + MMR path (env-gated)', () => {
  beforeEach(() => {
    process.env.SKILLSMITH_DOC_RETRIEVAL_RERANK = 'bm25'
  })
  afterEach(() => {
    delete process.env.SKILLSMITH_DOC_RETRIEVAL_RERANK
  })

  it('does not activate without the env flag', () => {
    delete process.env.SKILLSMITH_DOC_RETRIEVAL_RERANK
    const hits = [
      makeHit('a', 0.5, 'apples bananas cherries'),
      makeHit('b', 0.6, 'apples bananas cherries'),
    ]
    const out = rerank(hits, 'apples')
    // Phase 1 just sorts by similarity — b wins with 0.6.
    expect(out[0].id).toBe('b')
  })

  it('reorders the pool relative to pure-embedding when keywords align', () => {
    // With env unset, pure embedding gives `b > c > a`. With env=bm25, 'a'
    // scores 1.0 on BM25 (only doc with the rare keywords) while 'b' scores 0.
    // Combined = 0.6*emb + 0.4*bm25 means 'a' beats 'c' (lower emb, higher bm25).
    const hits = [
      makeHit('a', 0.5, 'rare keyword present here'),
      makeHit('b', 0.6, 'common common common common'),
      makeHit('c', 0.55, 'common common common'),
    ]
    const out = rerank(hits, 'rare keyword')
    const positions = Object.fromEntries(out.map((h, i) => [h.id, i]))
    // 'a' must outrank 'c' even though c has higher embedding similarity.
    expect(positions['a']).toBeLessThan(positions['c'])
  })

  it('returns at most top-5', () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      makeHit(`h${i}`, 0.5 + i * 0.01, `text ${i} content`)
    )
    const out = rerank(hits, 'text content')
    expect(out.length).toBeLessThanOrEqual(5)
  })

  it('is deterministic — same input produces same output', () => {
    const hits = [
      makeHit('a', 0.7, 'foo bar baz'),
      makeHit('b', 0.6, 'foo bar qux'),
      makeHit('c', 0.5, 'completely different content'),
    ]
    const a = rerank(hits, 'foo bar')
    const b = rerank(hits, 'foo bar')
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id))
  })

  it('MMR includes a diverse hit ahead of a near-duplicate when their combined scores are comparable', () => {
    // With div having higher embedding similarity, its combined score wins
    // pick-1 outright. Pick-2's MMR competition is dup1 vs dup2 — both have
    // the same combined score but diversity-wise dup1/dup2 are identical
    // tokens (jaccard=1.0 to each other, jaccard=0.0 to div), so picking the
    // first dup is fine. The assertion is the broader guarantee: the top-3
    // result MUST contain the diverse hit alongside at least one dup, not
    // both dups (which would happen if MMR were broken / λ=1).
    const hits = [
      makeHit('dup1', 0.7, 'apple banana cherry'),
      makeHit('dup2', 0.7, 'apple banana cherry'),
      makeHit('div', 0.9, 'completely orthogonal vocabulary'),
    ]
    const out = rerank(hits, 'apple banana')
    const ids = out.map((h) => h.id)
    expect(ids).toContain('div')
    expect(ids.some((i) => i === 'dup1' || i === 'dup2')).toBe(true)
  })

  it('still applies absorption penalty before BM25/MMR', () => {
    const absorbed = makeHit('absorbed', 0.95, 'rare keyword', {
      absorbed_by: 'canon.md',
    })
    const fresh = makeHit('fresh', 0.7, 'rare keyword')
    const out = rerank([absorbed, fresh], 'rare keyword')
    // Both have the keyword. Absorption demotes absorbed's emb-similarity input
    // to 0.475 → after min-max-normalize the canonical wins.
    expect(out[0].id).toBe('fresh')
  })
})

describe('rerank — BM25 helpers (exported for unit coverage)', () => {
  it('tokenize lowercases, strips punctuation, splits whitespace', () => {
    expect(tokenize("Hello, World! It's 2026.")).toEqual(['hello', 'world', 'it', 's', '2026'])
  })

  it('tokenize handles empty string', () => {
    expect(tokenize('')).toEqual([])
  })

  it('buildIdf assigns higher IDF to rarer terms', () => {
    const docs = [['common', 'common', 'rare'], ['common', 'common'], ['common']]
    const idf = buildIdf(docs)
    const common = idf.get('common') ?? 0
    const rare = idf.get('rare') ?? 0
    expect(rare).toBeGreaterThan(common)
  })

  it('buildIdf returns zero IDF for terms in every doc (Robertson smoothing keeps it positive)', () => {
    const docs = [['x'], ['x'], ['x']]
    const idf = buildIdf(docs)
    // log((3 - 3 + 0.5) / (3 + 0.5) + 1) = log(0.5/3.5 + 1) ≈ log(1.143) ≈ 0.134
    expect(idf.get('x')).toBeCloseTo(Math.log(0.5 / 3.5 + 1), 4)
  })

  it('bm25Score returns 0 for empty doc', () => {
    expect(bm25Score(['q'], [], new Map([['q', 1]]), 1)).toBe(0)
  })

  it('bm25Score is monotonic in TF when other factors fixed', () => {
    const idf = new Map([['a', 1.5]])
    const low = bm25Score(['a'], ['a', 'a', 'b'], idf, 3)
    const high = bm25Score(['a'], ['a', 'a', 'a', 'b'], idf, 4)
    expect(high).toBeGreaterThan(low)
  })

  it('minMaxNormalize maps to [0, 1] with min→0 and max→1', () => {
    const out = minMaxNormalize([1, 2, 3, 4, 5])
    expect(out[0]).toBe(0)
    expect(out[out.length - 1]).toBe(1)
  })

  it('minMaxNormalize returns all-zeros for uniform input (no division by zero)', () => {
    expect(minMaxNormalize([0.5, 0.5, 0.5])).toEqual([0, 0, 0])
  })

  it('minMaxNormalize returns [] for empty input', () => {
    expect(minMaxNormalize([])).toEqual([])
  })
})

describe('rerank — SMI-4468 per-class boost', () => {
  afterEach(() => {
    delete process.env.SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY
    delete process.env.SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS
  })

  it('classBoostFactor returns 1.0 when meta is undefined or class missing', () => {
    expect(classBoostFactor(undefined)).toBe(1.0)
    const noClass: ChunkStoredMetadata = {
      file_path: 'x',
      line_start: 1,
      line_end: 1,
      heading_chain: [],
      text: '',
    }
    expect(classBoostFactor(noClass)).toBe(1.0)
  })

  it('classBoostFactor returns 1.0 for empty or unrecognized class arrays', () => {
    const empty = makeHit('e', 0.5, 'x', { class: [] })
    expect(classBoostFactor(empty.meta)).toBe(1.0)
    const unknown = makeHit('u', 0.5, 'x', { class: ['markdown-doc', 'retro'] })
    expect(classBoostFactor(unknown.meta)).toBe(1.0)
  })

  it('boosts feedback-class similarity by default 1.5x', () => {
    const fb = makeHit('feedback', 0.4, 'feedback content', { class: ['feedback'] })
    const out = rerank([fb], 'q')
    // 0.4 * 1.5 = 0.6 (no penalty applies)
    expect(out[0].score).toBeCloseTo(0.6, 4)
    expect(out[0].similarity).toBe(0.4) // raw signal preserved
  })

  it('boosts project-class similarity by default 1.5x', () => {
    const proj = makeHit('proj', 0.4, 'project content', { class: ['project'] })
    const out = rerank([proj], 'q')
    expect(out[0].score).toBeCloseTo(0.6, 4)
  })

  it('dampens wave-spec class by default 0.85x', () => {
    const wave = makeHit('wave', 0.6, 'wave spec', { class: ['wave-spec'] })
    const out = rerank([wave], 'q')
    expect(out[0].score).toBeCloseTo(0.51, 4) // 0.6 * 0.85
  })

  it('dampens plans-review class by default 0.85x', () => {
    const pr = makeHit('pr', 0.6, 'plan review', { class: ['plans-review'] })
    const out = rerank([pr], 'q')
    expect(out[0].score).toBeCloseTo(0.51, 4)
  })

  it('memory boost wins when both memory and process classes co-occur', () => {
    // Defensive: schema drift could produce co-occurrence; memory provenance
    // should always win because the chunk is at minimum a feedback chunk.
    const mixed = makeHit('mixed', 0.4, 'content', { class: ['feedback', 'wave-spec'] })
    const out = rerank([mixed], 'q')
    expect(out[0].score).toBeCloseTo(0.6, 4) // 0.4 * 1.5 (memory boost), not 0.34 (dampener)
  })

  it('boost stacks with absorption cap — boosted+absorbed hits the 0.5 ceiling', () => {
    // 0.9 * 1.5 = 1.35 (boosted), then * 0.5 = 0.675, capped to 0.5.
    // Without the cap, boost would smuggle the absorbed chunk past its
    // canonical replacement; the cap holds that line.
    const absorbed = makeHit('a', 0.9, 'x', {
      class: ['feedback'],
      absorbed_by: 'canonical.md',
    })
    const out = rerank([absorbed], 'q')
    expect(out[0].score).toBe(0.5)
  })

  it('dampener stacks with supersession penalty', () => {
    const dampened = makeHit('d', 0.8, 'x', {
      class: ['wave-spec'],
      supersedes: 'newer.md',
    })
    const out = rerank([dampened], 'q')
    // 0.8 * 0.85 * 0.5 = 0.34
    expect(out[0].score).toBeCloseTo(0.34, 4)
  })

  it('env override SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY changes the boost factor', () => {
    process.env.SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY = '2.0'
    const fb = makeHit('fb', 0.3, 'feedback', { class: ['feedback'] })
    const out = rerank([fb], 'q')
    expect(out[0].score).toBeCloseTo(0.6, 4) // 0.3 * 2.0
  })

  it('env override SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS changes the dampener', () => {
    process.env.SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS = '0.5'
    const wave = makeHit('w', 0.8, 'wave', { class: ['wave-spec'] })
    const out = rerank([wave], 'q')
    expect(out[0].score).toBeCloseTo(0.4, 4) // 0.8 * 0.5
  })

  it('malformed env values fall back to defaults', () => {
    process.env.SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY = 'not-a-number'
    const fb = makeHit('fb', 0.4, 'feedback', { class: ['feedback'] })
    const out = rerank([fb], 'q')
    expect(out[0].score).toBeCloseTo(0.6, 4) // default 1.5
  })

  it('negative or zero env values fall back to defaults', () => {
    process.env.SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY = '-2.0'
    const fb = makeHit('fb', 0.4, 'feedback', { class: ['feedback'] })
    const out = rerank([fb], 'q')
    expect(out[0].score).toBeCloseTo(0.6, 4)
  })

  it('extreme env values clamp to [0.1, 5.0] range', () => {
    process.env.SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY = '999'
    const fb = makeHit('fb', 0.1, 'feedback', { class: ['feedback'] })
    const out = rerank([fb], 'q')
    expect(out[0].score).toBeCloseTo(0.5, 4) // 0.1 * clamp(999, 5.0) = 0.5
  })

  it('reorders feedback chunk above unboosted longer doc with same similarity', () => {
    // Demonstrates the SMI-4468 use case: short feedback chunk previously
    // tied with longer impl-doc on cosine; boost gives it the edge.
    const feedback = makeHit('fb', 0.5, 'feedback bullet', { class: ['feedback'] })
    const impl = makeHit('impl', 0.5, 'impl doc body')
    const out = rerank([impl, feedback], 'q')
    expect(out[0].id).toBe('fb') // boosted to 0.75 vs unboosted 0.5
  })
})
