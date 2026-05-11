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
 * for values written via the JS-side path (which always emits millisecond
 * precision). The actual prod skip-gate uses byte-string equality between
 * the stored value and the new GitHub `updated_at` — JS Date round-trip is
 * a strong subset of that guarantee. Any code path that type-casts through
 * `::timestamptz` produces postgres text form which fails round-trip and
 * silently disables the skip-gate.
 *
 * GitHub's REST API emits the no-millisecond form `YYYY-MM-DDTHH:MM:SSZ`,
 * which Date.toISOString() will normalize to `.000Z`. For prod data that
 * comes straight from GitHub, the runbook
 * (scripts/runbooks/verify-repo-updated-at-format.mjs) handles both shapes
 * via a tolerant comparator; this test pins the JS-emitted form.
 */

import { describe, it, expect } from 'vitest'

const PASSING_FIXTURES = [
  '2026-05-01T12:34:56.000Z',
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
