/**
 * Format round-trip pure-unit test (Hard Rule 2 / Issue #5a)
 * @module scripts/indexer/tests/format-roundtrip
 *
 * SMI-4852: Asserts the `repo_updated_at` skip-gate format invariant against
 * fixture strings. This test is CI-safe (no DB, no network). The live-data
 * companion `scripts/runbooks/verify-repo-updated-at-format.mjs` runs
 * pre-merge + post-deploy, NOT on every push.
 *
 * The invariant: any value written to skills.repo_updated_at must satisfy
 *   new Date(s).toISOString() === s
 * GitHub's REST API already emits ISO strings in this shape; any code path
 * that type-casts through `::timestamptz` breaks the round-trip and silently
 * disables the skip-gate.
 */

import { describe, it, expect } from 'vitest'

const PASSING_FIXTURES = [
  '2026-05-01T12:34:56Z',
  '2026-01-01T00:00:00.000Z',
  '2026-12-31T23:59:59.123Z',
]

const FAILING_FIXTURES = [
  '2026-05-01 12:34:56+00', // postgres timestamptz text form
  '2026-05-01T08:34:56-04:00', // tz-shifted (not UTC)
  '2026-05-01', // date-only
]

describe('repo_updated_at format round-trip', () => {
  for (const fixture of PASSING_FIXTURES) {
    it(`passes round-trip: ${fixture}`, () => {
      const parsed = new Date(fixture)
      expect(parsed.toISOString()).toBe(fixture)
    })
  }

  for (const fixture of FAILING_FIXTURES) {
    it(`fails round-trip (expected): ${fixture}`, () => {
      const parsed = new Date(fixture)
      // Either parses but doesn't round-trip, or fails to parse entirely.
      const result = parsed.toISOString()
      expect(result).not.toBe(fixture)
    })
  }
})
