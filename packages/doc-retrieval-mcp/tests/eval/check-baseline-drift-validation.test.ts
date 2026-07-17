/**
 * SMI-5708 Item #3 -- Unit + integration tests for validateBaselineFile()
 * (check-baseline-drift-validation.ts) and its wiring into evaluateDrift().
 *
 * Split out of check-baseline-drift.test.ts to keep that file under the
 * 500-line standard (audit:standards Check 3), mirroring the same-reason
 * split of the source file itself (check-baseline-drift-validation.ts).
 */

import { describe, it, expect } from 'vitest'
import { evaluateDrift, validateBaselineFile } from '../../eval/check-baseline-drift.js'
import type { BaselineFile, BaselineByCategory } from '../../eval/check-baseline-drift.js'

const populatedBaseline = (prior: number | null, current: number | null): BaselineFile => ({
  prior,
  current,
  generated: '2026-05-05',
  corpus: { filesScanned: 1080, chunksUpserted: 26089 },
  knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
  metrics: { recallAt5: current },
})

const TODAY_PRIOR: Record<string, number> = {
  'memory-recall': 0.286,
  'implementation-lookup': 0.25,
  'adr-lookup': 0.5,
  'skill-discovery': 0.6,
  'retro-lookup': 0.5,
  'script-header': 0.625,
}
const TODAY_COUNTS: Record<string, number> = {
  'memory-recall': 14,
  'implementation-lookup': 12,
  'adr-lookup': 6,
  'skill-discovery': 5,
  'retro-lookup': 10,
  'script-header': 8,
}

const hybridBaseline = (
  overallPrior: number,
  overallCurrent: number,
  currentByCat: Record<string, number>,
  priorByCat: Record<string, number> | null = TODAY_PRIOR
): BaselineFile => {
  const byCategory: BaselineByCategory = {
    recallAt5: currentByCat,
    recallAt5Prior: priorByCat,
    count: TODAY_COUNTS,
  }
  return {
    prior: overallPrior,
    current: overallCurrent,
    generated: '2026-05-06',
    corpus: { filesScanned: 1325, chunksUpserted: 28432 },
    knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
    metrics: { recallAt5: overallCurrent },
    byCategory,
  }
}

describe('validateBaselineFile', () => {
  it('accepts a well-formed populated baseline (non-null prior in range)', () => {
    const result = validateBaselineFile(populatedBaseline(0.8, 0.81))
    expect(result.ok).toBe(true)
  })

  // Opus round-3 review finding (LOW, in-scope): a top-level `null` (or
  // any other non-object JSON value) is syntactically valid, so without
  // this guard, both the CI reader (loadBaseline -> evaluateDrift) and the
  // writer's existing-file check would crash with an uncaught TypeError
  // reading `.prior` off a non-object instead of returning this item's
  // whole point: a clean, ACTIONABLE `{ ok: false, error }`. Guarded once
  // here, in the shared validator, rather than duplicated at each caller.
  it.each([
    [null, 'null'],
    [[], 'array'],
    [42, 'number'],
    ['not an object', 'string'],
  ])('rejects a top-level %p baseline (not an object) cleanly, not a crash', (value, label) => {
    const result = validateBaselineFile(value as unknown as BaselineFile)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('baseline.json must be a JSON object')
      expect(result.error).toContain(label)
    }
  })

  it('accepts prior: null when bootstrapped: true', () => {
    const result = validateBaselineFile({ ...populatedBaseline(null, 0.5), bootstrapped: true })
    expect(result.ok).toBe(true)
  })

  it('rejects prior: null WITHOUT bootstrapped: true', () => {
    const result = validateBaselineFile(populatedBaseline(null, 0.5))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('bootstrapped')
    }
  })

  it('rejects prior: null with bootstrapped: false explicitly (not just missing)', () => {
    const result = validateBaselineFile({ ...populatedBaseline(null, 0.5), bootstrapped: false })
    expect(result.ok).toBe(false)
  })

  it('rejects prior === 0 -- the original silent-skip loophole', () => {
    const result = validateBaselineFile(populatedBaseline(0, 0.5))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('prior')
      expect(result.error).toMatch(/range \(0, 1]/)
    }
  })

  it('rejects prior of the wrong type (string)', () => {
    const bad = { ...populatedBaseline(0.5, 0.5), prior: 'bad' } as unknown as BaselineFile
    const result = validateBaselineFile(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('prior')
    }
  })

  it('rejects prior: NaN', () => {
    const result = validateBaselineFile({ ...populatedBaseline(0.5, 0.5), prior: NaN })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('finite')
    }
  })

  it('rejects prior out of (0,1] range (1.5)', () => {
    const result = validateBaselineFile(populatedBaseline(1.5, 0.5))
    expect(result.ok).toBe(false)
  })

  it('rejects current: null -- never a legitimate state, unlike prior', () => {
    const result = validateBaselineFile(populatedBaseline(0.5, null))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('current')
    }
  })

  it('rejects current of the wrong type', () => {
    const bad = { ...populatedBaseline(0.5, 0.5), current: 'nope' } as unknown as BaselineFile
    const result = validateBaselineFile(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('current')
    }
  })

  it('a non-null prior is validated on its own merits -- bootstrapped: true does NOT bypass it', () => {
    // Critical design constraint: bootstrapped: true must never become a
    // general "skip validation" escape hatch -- it only ever legitimizes
    // prior === null.
    const bad = { ...populatedBaseline(0, 0.5), bootstrapped: true }
    const result = validateBaselineFile(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('prior')
    }
  })

  it('accepts null metrics fields (not yet computed) alongside a valid prior/current', () => {
    const baseline: BaselineFile = {
      prior: 0.5,
      current: 0.6,
      metrics: { recallAt5: 0.6, recallAt10: null, mrr: null, ndcgAt10: null },
    }
    expect(validateBaselineFile(baseline).ok).toBe(true)
  })

  it('rejects an out-of-range metrics field', () => {
    const baseline: BaselineFile = { prior: 0.5, current: 0.6, metrics: { recallAt5: 1.2 } }
    const result = validateBaselineFile(baseline)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('metrics.recallAt5')
    }
  })

  it('accepts byCategory.recallAt5Prior entries of exactly 0 (already-handled per-category state)', () => {
    const baseline = hybridBaseline(0.5, 0.5, TODAY_PRIOR, {
      ...TODAY_PRIOR,
      'skill-discovery': 0,
    })
    expect(validateBaselineFile(baseline).ok).toBe(true)
  })

  it('rejects a NaN byCategory.recallAt5Prior entry', () => {
    const baseline = hybridBaseline(0.5, 0.5, TODAY_PRIOR, {
      ...TODAY_PRIOR,
      'skill-discovery': NaN,
    })
    const result = validateBaselineFile(baseline)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('byCategory.recallAt5Prior.skill-discovery')
    }
  })

  // Opus review finding F1/F3 -- out-of-range and NaN `current` were only
  // exercised indirectly via the shared invalidRequiredMetric path (the
  // metrics.recallAt5 test); add direct coverage for `current` itself.
  it('rejects current out of [0, 1] range (1.5)', () => {
    const result = validateBaselineFile(populatedBaseline(0.5, 1.5))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('current')
      expect(result.error).toContain('range [0, 1]')
    }
  })

  it('rejects current: NaN', () => {
    const result = validateBaselineFile({ ...populatedBaseline(0.5, 0.5), current: NaN })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('current')
      expect(result.error).toContain('finite')
    }
  })

  // Opus review finding F2 -- the CURRENT per-category snapshot
  // (byCategory.recallAt5) was not validated, only its `*Prior`
  // counterpart. A NaN here would silently disable that category's
  // regression check in checkHybridDrift (a NaN comparison is always
  // false, so the category never trips) -- exactly the "invisible
  // success" failure mode this whole item targets, one level down.
  it('rejects a NaN byCategory.recallAt5 entry (the CURRENT snapshot, not just its prior)', () => {
    const baseline = hybridBaseline(
      0.5,
      0.5,
      { ...TODAY_PRIOR, 'skill-discovery': NaN },
      TODAY_PRIOR
    )
    const result = validateBaselineFile(baseline)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('byCategory.recallAt5.skill-discovery')
    }
  })

  it('accepts byCategory.recallAt5 entries of exactly 0 (a category can legitimately score 0)', () => {
    const baseline = hybridBaseline(0.5, 0.5, { ...TODAY_PRIOR, 'skill-discovery': 0 }, TODAY_PRIOR)
    expect(validateBaselineFile(baseline).ok).toBe(true)
  })

  it('rejects a negative byCategory.count entry', () => {
    const baseline = hybridBaseline(0.5, 0.5, TODAY_PRIOR, TODAY_PRIOR)
    baseline.byCategory!.count = { ...TODAY_COUNTS, 'skill-discovery': -1 }
    const result = validateBaselineFile(baseline)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('byCategory.count.skill-discovery')
    }
  })

  it('rejects a non-integer byCategory.count entry', () => {
    const baseline = hybridBaseline(0.5, 0.5, TODAY_PRIOR, TODAY_PRIOR)
    baseline.byCategory!.count = { ...TODAY_COUNTS, 'skill-discovery': 5.5 }
    const result = validateBaselineFile(baseline)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('byCategory.count.skill-discovery')
    }
  })

  it('accepts byCategory.count of exactly 0 (checkHybridDrift already skips these categories)', () => {
    const baseline = hybridBaseline(0.5, 0.5, TODAY_PRIOR, TODAY_PRIOR)
    baseline.byCategory!.count = { ...TODAY_COUNTS, 'skill-discovery': 0 }
    expect(validateBaselineFile(baseline).ok).toBe(true)
  })

  // Codex round-2 review finding (High): the per-entry checks above were
  // previously gated on truthiness alone, so a malformed shape like
  // byCategory: {} silently skipped the missing sub-object's checks
  // instead of being flagged as invalid, letting corruption pass
  // validation on any unrelated diff.
  it('rejects byCategory: {} (empty object -- recallAt5/count are required whenever byCategory is present)', () => {
    const baseline = populatedBaseline(0.5, 0.5)
    baseline.byCategory = {} as unknown as BaselineByCategory
    const result = validateBaselineFile(baseline)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('byCategory.recallAt5 must be an object')
      expect(result.error).toContain('byCategory.count must be an object')
    }
  })

  it('rejects byCategory with recallAt5 present but count entirely missing', () => {
    const baseline = populatedBaseline(0.5, 0.5)
    baseline.byCategory = {
      recallAt5: { 'skill-discovery': 0.5 },
    } as unknown as BaselineByCategory
    const result = validateBaselineFile(baseline)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('byCategory.count must be an object')
    }
  })

  it('rejects byCategory.recallAt5Prior of the wrong type (a string, not null or an object)', () => {
    const baseline = hybridBaseline(0.5, 0.5, TODAY_PRIOR, TODAY_PRIOR)
    baseline.byCategory!.recallAt5Prior = 'not-an-object' as unknown as Record<string, number>
    const result = validateBaselineFile(baseline)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('byCategory.recallAt5Prior must be null or an object')
    }
  })

  it('accepts byCategory.recallAt5Prior: null (legitimate first run with byCategory present)', () => {
    const baseline = hybridBaseline(0.5, 0.5, TODAY_PRIOR, null)
    expect(validateBaselineFile(baseline).ok).toBe(true)
  })

  // Codex round-3 review finding: the PARENT guard (`if (baseline.byCategory)`)
  // was itself truthiness-based, so a present-but-falsy-and-wrong-typed
  // byCategory (null, false, 0, "") silently passed as though the
  // optional field were genuinely absent -- the same class of bug one
  // level up from the structural checks above. `undefined` is the only
  // value the `byCategory?:` type actually permits for "absent".
  it.each([null, false, 0, ''])(
    'rejects byCategory: %p (falsy but present -- not the same as absent/undefined)',
    (falsyValue) => {
      const baseline = populatedBaseline(0.5, 0.5)
      baseline.byCategory = falsyValue as unknown as BaselineByCategory
      const result = validateBaselineFile(baseline)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('byCategory must be an object when present')
      }
    }
  )

  it('accepts byCategory: undefined (genuinely absent, unlike null/false/0/"")', () => {
    const baseline = populatedBaseline(0.5, 0.5)
    expect(baseline.byCategory).toBeUndefined()
    expect(validateBaselineFile(baseline).ok).toBe(true)
  })
})

describe('evaluateDrift schema hardening integration (SMI-5708 Item #3)', () => {
  const BASELINE_JSON_CHANGED = ['packages/doc-retrieval-mcp/eval/baseline.json']

  it('(a) prior: 0 causes a HARD FAIL via evaluateDrift, not a skip', () => {
    const result = evaluateDrift(BASELINE_JSON_CHANGED, populatedBaseline(0, 0.5))
    expect(result.pass).toBe(false)
    expect(result.message).toContain('::error::')
    expect(result.message).toContain('schema validation')
  })

  it('(b) prior: "bad" (wrong type) causes a HARD FAIL via evaluateDrift', () => {
    const bad = { ...populatedBaseline(0.5, 0.5), prior: 'bad' } as unknown as BaselineFile
    const result = evaluateDrift(BASELINE_JSON_CHANGED, bad)
    expect(result.pass).toBe(false)
    expect(result.message).toContain('::error::')
    expect(result.message).toContain('schema validation')
  })

  it('(c) prior: NaN causes a HARD FAIL via evaluateDrift', () => {
    const result = evaluateDrift(BASELINE_JSON_CHANGED, {
      ...populatedBaseline(0.5, 0.5),
      prior: NaN,
    })
    expect(result.pass).toBe(false)
    expect(result.message).toContain('::error::')
  })

  it('(c2) prior out-of-range (1.5) causes a HARD FAIL via evaluateDrift', () => {
    const result = evaluateDrift(BASELINE_JSON_CHANGED, populatedBaseline(1.5, 0.5))
    expect(result.pass).toBe(false)
    expect(result.message).toContain('::error::')
  })

  it('(e) prior: null WITHOUT bootstrapped: true is now INVALID -- no longer silently treated as a valid bootstrap', () => {
    const result = evaluateDrift(BASELINE_JSON_CHANGED, populatedBaseline(null, 0.1))
    expect(result.pass).toBe(false)
    expect(result.message).toContain('::error::')
    expect(result.message).toContain('bootstrapped')
  })

  it('(d) prior: null WITH bootstrapped: true still correctly skips the regression check', () => {
    const result = evaluateDrift(BASELINE_JSON_CHANGED, {
      ...populatedBaseline(null, 0.1),
      bootstrapped: true,
    })
    expect(result.pass).toBe(true)
    expect(result.message).toContain('prior is null')
    expect(result.message).not.toContain('::error::')
  })

  // Codex review finding (Medium): validation must run UNCONDITIONALLY,
  // not only when baseline.json itself is in the diff. A baseline.json
  // that's already corrupted in the tree -- from before this fix landed,
  // or via any other path -- must be caught on every CI run, including one
  // whose diff touches neither ranking files, gold-set.json, nor
  // baseline.json. Before this fix, such a diff would hit the final
  // "nothing to check" fallback without ever inspecting the committed
  // baseline's validity.
  it('(f) a corrupted baseline.json is caught even when NO relevant file changed in this diff', () => {
    const unrelatedChangedFiles = ['docs/internal/architecture/index.md']
    const result = evaluateDrift(unrelatedChangedFiles, populatedBaseline(0, 0.5))
    expect(result.pass).toBe(false)
    expect(result.message).toContain('::error::')
    expect(result.message).toContain('schema validation')
  })

  it('(g) a VALID baseline.json still passes cleanly when no relevant file changed', () => {
    const unrelatedChangedFiles = ['docs/internal/architecture/index.md']
    const result = evaluateDrift(unrelatedChangedFiles, populatedBaseline(0.5, 0.55))
    expect(result.pass).toBe(true)
    expect(result.message).toContain('nothing to check')
  })
})
