/**
 * ROIDashboardService coverage sidecar — SMI-4317 validation tightening.
 *
 * Split from `ROIDashboardService.test.ts` to keep the main suite under the
 * 500-line pre-commit cap (SMI-3493 / SMI-4285). Covers the strict ISO-8601
 * regex + the `getDateRange` positive-integer `days` guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabaseSync } from '../src/db/createDatabase.js'
import type { Database } from '../src/db/database-interface.js'
import { initializeAnalyticsSchema } from '../src/analytics/schema.js'
import { ISO_8601_STRICT, ROIDashboardService } from '../src/analytics/ROIDashboardService.js'
import { ValidationError } from '../src/validation/validation-error.js'

describe('ROIDashboardService validation (SMI-4317)', () => {
  let db: Database
  let service: ROIDashboardService

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'))
    db = createDatabaseSync(':memory:')
    initializeAnalyticsSchema(db)
    service = new ROIDashboardService(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (db) db.close()
  })

  describe('strict ISO-8601 regex', () => {
    // Table-driven valid cases: each must pass through regex AND Date.parse.
    const validCases: ReadonlyArray<[string, string]> = [
      ['date-only', '2026-04-19'],
      ['Jan edge date-only', '2026-01-01'],
      ['Dec edge date-only', '2026-12-31'],
      ['date + time Z', '2026-04-19T00:00:00Z'],
      ['upper-bound time Z', '2026-04-19T23:59:59Z'],
      ['3-digit fraction Z', '2026-04-19T12:00:00.000Z'],
      ['6-digit fraction Z', '2026-04-19T12:00:00.123456Z'],
      ['explicit UTC offset', '2026-04-19T12:00:00+00:00'],
      ['IST offset', '2026-04-19T12:00:00+05:30'],
      ['PST offset', '2026-04-19T12:00:00-08:00'],
    ]

    it.each(validCases)('accepts valid ISO-8601 (%s: %s)', (_label, input) => {
      expect(ISO_8601_STRICT.test(input)).toBe(true)
      // Pair the input with a strictly-later valid end date so ordering passes.
      expect(() =>
        service.getDashboard({
          userId: 'user-1',
          startDate: input,
          endDate: '2027-01-01T00:00:00.000Z',
        })
      ).not.toThrow()
    })

    // Table-driven invalid cases: every one must throw ValidationError.
    const invalidCases: ReadonlyArray<[string, string]> = [
      ['RFC-2822-ish text', 'Jan 1 2026'],
      ['slash separators', '2026/01/01'],
      ['space separator', '2026-01-01 00:00:00'],
      ['RFC-2822', 'Wed, 01 Jan 2026 00:00:00 GMT'],
      ['date + time without offset', '2026-04-19T12:00:00'],
      ['invalid month', '2026-13-01'],
      ['empty string', ''],
      ['string "null"', 'null'],
      ['year only', '2026'],
      ['year-month only', '2026-04'],
    ]

    it.each(invalidCases)(
      'rejects non-strict input (%s: %s) with ValidationError',
      (_label, input) => {
        expect(() =>
          service.getDashboard({
            userId: 'user-1',
            startDate: input,
            endDate: '2027-01-01T00:00:00.000Z',
          })
        ).toThrow(ValidationError)
      }
    )

    it('Date.parse guard fires for shape-valid but semantically invalid dates', () => {
      // `2026-13-01` passes the regex (\d{2} matches "13") but Date.parse
      // returns NaN for it — covering the second validation layer. Note:
      // V8's Date.parse normalizes some invalid calendar dates (e.g.,
      // `2026-02-30` -> March 2), so we pick an invalid month to exercise
      // the NaN path deterministically.
      expect(ISO_8601_STRICT.test('2026-13-01')).toBe(true)
      expect(Number.isNaN(Date.parse('2026-13-01'))).toBe(true)
      expect(() =>
        service.getDashboard({
          userId: 'user-1',
          startDate: '2026-13-01',
          endDate: '2027-01-01T00:00:00.000Z',
        })
      ).toThrow(/parseable ISO-8601/)
    })

    it('rejects 5-digit year (regex anchors \\d{4} exactly)', () => {
      expect(ISO_8601_STRICT.test('99999-01-01')).toBe(false)
      expect(() =>
        service.getDashboard({
          userId: 'user-1',
          startDate: '99999-01-01',
          endDate: '2027-01-01T00:00:00.000Z',
        })
      ).toThrow(/strict ISO-8601/)
    })
  })

  describe('getDateRange days validation', () => {
    it('accepts positive integer days', () => {
      // Uses the frozen clock (2026-01-15T12:00:00Z) established in beforeEach.
      expect(() => service.getUserROI('user-1', 30)).not.toThrow()
    })

    it.each<[string, number]>([
      ['negative', -5],
      ['zero', 0],
      ['non-integer', 3.14],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('rejects %s days (%s) with ValidationError', (_label, value) => {
      expect(() => service.getUserROI('user-1', value)).toThrow(ValidationError)
      expect(() => service.getUserROI('user-1', value)).toThrow(/positive integer/)
    })

    it('also guards getStakeholderROI', () => {
      expect(() => service.getStakeholderROI(-5)).toThrow(ValidationError)
    })

    it('also guards exportROIDashboard', () => {
      expect(() => service.exportROIDashboard('user-1', 'json', -5)).toThrow(ValidationError)
    })
  })
})
