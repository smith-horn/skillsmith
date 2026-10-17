/**
 * SMI-7121: the autochain's safety halts (pure functions).
 */
import { describe, it, expect } from 'vitest'
import {
  applyAcknowledgements,
  evaluateHalts,
  parseAcknowledgedHalts,
  parseNdbMax,
  type Halt,
  type HaltCheckpoint,
} from '../../indexer/backfill-autochain-halts.ts'

const counters = (over: Partial<Record<string, number>> = {}) => ({
  admitted: 4,
  no_default_branch: 0,
  license_filtered: 0,
  ranges_crawled: 3,
  ...over,
})

const clean = (over: Record<string, unknown> = {}): HaltCheckpoint => ({
  dispatch_counters: counters(),
  resumed_from: { run_id: 'prev', path: '.claude/skills' },
  dispatch_inputs: { pathPrefix: '.claude/skills' },
  ...over,
})

const names = (halts: Halt[]) => halts.map((h) => h.name)

describe('evaluateHalts', () => {
  it('CONTROL: a clean checkpoint has no halts', () => {
    expect(evaluateHalts(clean(), { ndbMax: 50 })).toEqual([])
  })

  describe('no_default_branch', () => {
    it('== ndbMax passes', () => {
      const cp = clean({ dispatch_counters: counters({ no_default_branch: 50 }) })
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual([])
    })
    it('ndbMax + 1 halts, naming the observed value and threshold', () => {
      const cp = clean({ dispatch_counters: counters({ no_default_branch: 51 }) })
      const halts = evaluateHalts(cp, { ndbMax: 50 })
      expect(names(halts)).toEqual(['no_default_branch'])
      expect(halts[0].detail).toContain('51')
      expect(halts[0].detail).toContain('50')
    })
  })

  describe('license_filtered', () => {
    it('0 passes', () => {
      expect(names(evaluateHalts(clean(), { ndbMax: 50 }))).toEqual([])
    })
    it('1 halts', () => {
      const cp = clean({ dispatch_counters: counters({ license_filtered: 1 }) })
      const halts = evaluateHalts(cp, { ndbMax: 50 })
      expect(names(halts)).toEqual(['license_filtered'])
      expect(halts[0].detail).toContain('license_filtered=1')
    })
  })

  describe('counters_missing', () => {
    it('halts when dispatch_counters is absent, and evaluates no counter halt', () => {
      const cp = clean()
      delete cp.dispatch_counters
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual(['counters_missing'])
    })
    it('halts when the resumed_from KEY is absent', () => {
      const cp = clean()
      delete cp.resumed_from
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual(['counters_missing'])
    })
    it('resumed_from: null (cold start) is present, not missing', () => {
      expect(names(evaluateHalts(clean({ resumed_from: null }), { ndbMax: 50 }))).toEqual([])
    })
    it('a malformed counter is missing, never zero', () => {
      const cp = clean({ dispatch_counters: { ...counters(), license_filtered: '0' } })
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual(['counters_missing'])
    })
    it('does not evaluate the counter halts when counters are missing', () => {
      const cp = clean({ dispatch_counters: { no_default_branch: 999, license_filtered: 9 } })
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual(['counters_missing'])
    })
    it('still evaluates b1 when counters are missing', () => {
      const cp = clean({ resumed_from: { run_id: 'x', path: '' } })
      delete cp.dispatch_counters
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual([
        'counters_missing',
        'b1_foreign_cursor',
      ])
    })
  })

  describe('b1_foreign_cursor', () => {
    it("'' (broad prefix) resumed under '.claude/skills' halts", () => {
      const cp = clean({ resumed_from: { run_id: 'x', path: '' } })
      const halts = evaluateHalts(cp, { ndbMax: 50 })
      expect(names(halts)).toEqual(['b1_foreign_cursor'])
      expect(halts[0].detail).toContain('.claude/skills')
    })
    it("'.claude/skills' resumed under the broad prefix '' halts", () => {
      const cp = clean({
        resumed_from: { run_id: 'x', path: '.claude/skills' },
        dispatch_inputs: { pathPrefix: '' },
      })
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual(['b1_foreign_cursor'])
    })
    it("'' matches only ''", () => {
      const cp = clean({
        resumed_from: { run_id: 'x', path: '' },
        dispatch_inputs: { pathPrefix: '' },
      })
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual([])
    })
    it('fails closed when dispatch_inputs is missing and resumed_from is non-null', () => {
      const cp = clean()
      delete cp.dispatch_inputs
      const halts = evaluateHalts(cp, { ndbMax: 50 })
      expect(names(halts)).toEqual(['b1_foreign_cursor'])
      expect(halts[0].detail).toMatch(/missing or unusable/)
    })
    it('fails closed when pathPrefix is not a string (numeric) and resumed_from is non-null', () => {
      const cp = clean({ dispatch_inputs: { pathPrefix: 7 } })
      const halts = evaluateHalts(cp, { ndbMax: 50 })
      expect(names(halts)).toEqual(['b1_foreign_cursor'])
      expect(halts[0].detail).toMatch(/missing or unusable/)
    })
    it('an unusable pathPrefix with resumed_from null (cold start) does not halt', () => {
      const cp = clean({ resumed_from: null, dispatch_inputs: { pathPrefix: 7 } })
      expect(evaluateHalts(cp, { ndbMax: 50 })).toEqual([])
    })
    it('a non-string resumed_from.path halts', () => {
      const cp = clean({ resumed_from: { run_id: 'x' } })
      expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual(['b1_foreign_cursor'])
    })
    it('a cold start (null) with 0 ranges crawled and a done cursor does NOT halt (R1-3)', () => {
      const cp = clean({
        resumed_from: null,
        dispatch_counters: counters({ ranges_crawled: 0, admitted: 0 }),
        cursor: { path: '', facet: 'done' },
      } as Record<string, unknown>)
      expect(evaluateHalts(cp, { ndbMax: 50 })).toEqual([])
    })
  })

  it('reports every halt that fired, in order', () => {
    const cp = clean({
      resumed_from: { run_id: 'x', path: '' },
      dispatch_counters: counters({ no_default_branch: 60, license_filtered: 2 }),
    })
    expect(names(evaluateHalts(cp, { ndbMax: 50 }))).toEqual([
      'b1_foreign_cursor',
      'no_default_branch',
      'license_filtered',
    ])
  })
})

describe('parseNdbMax', () => {
  it.each([
    [undefined, 50],
    ['', 50],
    ['0', 0],
    ['50', 50],
    ['007', 7],
    ['1000', 1000],
  ])('%j -> %i', (raw, expected) => {
    expect(parseNdbMax(raw as string | undefined)).toBe(expected)
  })
  it.each(['-1', '+5', '1.5', ' 5', '5 ', '5a', 'abc', '1e3', '99999999999999999999'])(
    '%j throws',
    (raw) => {
      expect(() => parseNdbMax(raw)).toThrow(/BACKFILL_NDB_MAX/)
    }
  )
})

describe('parseAcknowledgedHalts', () => {
  it.each([undefined, ''])('%j -> empty', (raw) => {
    expect(parseAcknowledgedHalts(raw).size).toBe(0)
  })
  it('parses a trimmed comma list', () => {
    expect([...parseAcknowledgedHalts(' license_filtered , counters_missing ')].sort()).toEqual([
      'counters_missing',
      'license_filtered',
    ])
  })
  it('an unknown name throws', () => {
    expect(() => parseAcknowledgedHalts('license_filtered,bogus')).toThrow(/unknown halt/)
  })
  it('an empty element throws', () => {
    expect(() => parseAcknowledgedHalts('license_filtered,')).toThrow(/unknown halt/)
  })
  it('no_progress_record throws with the reason', () => {
    expect(() => parseAcknowledgedHalts('no_progress_record')).toThrow(
      /cannot be acknowledged: there is nothing to resume from/
    )
  })
})

describe('applyAcknowledgements', () => {
  const both: Halt[] = [
    { name: 'no_default_branch', detail: 'a' },
    { name: 'license_filtered', detail: 'b' },
  ]
  it('acknowledging license_filtered does not silence no_default_branch', () => {
    expect(names(applyAcknowledgements(both, parseAcknowledgedHalts('license_filtered')))).toEqual([
      'no_default_branch',
    ])
  })
  it('acknowledging nothing keeps everything', () => {
    expect(applyAcknowledgements(both, new Set())).toEqual(both)
  })
})
