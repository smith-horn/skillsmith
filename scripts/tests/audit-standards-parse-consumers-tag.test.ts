/**
 * Tests for `parseConsumersTag` in audit-standards-helpers.mjs.
 *
 * Check 47 predicate 5 (SMI-5004) parses the @consumers JSDoc tag from
 * `supabase/functions/_shared/auth.ts` and compares it against the
 * grep-derived set of files that call `isServiceRoleCaller(`. This test
 * file verifies the helper is correct for the full range of expected
 * inputs and edge cases (sort enforcement, invalid tokens, missing tag,
 * multiple tags).
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  parseConsumersTag: (src: string) => {
    found: boolean
    names: string[]
    sorted: boolean
  } | null
}

const { parseConsumersTag } = helpers

describe('parseConsumersTag', () => {
  it('parses a canonical sorted tag with three names', () => {
    const src = [
      '/**',
      ' * Shared helper.',
      ' * @consumers coverage-report, indexer-dispatch, process-pending-subscription',
      ' */',
    ].join('\n')
    expect(parseConsumersTag(src)).toEqual({
      found: true,
      names: ['coverage-report', 'indexer-dispatch', 'process-pending-subscription'],
      sorted: true,
    })
  })

  it('flags an unsorted tag as sorted:false', () => {
    const src = [
      '/**',
      ' * @consumers indexer-dispatch, coverage-report, process-pending-subscription',
      ' */',
    ].join('\n')
    expect(parseConsumersTag(src)).toEqual({
      found: true,
      names: ['indexer-dispatch', 'coverage-report', 'process-pending-subscription'],
      sorted: false,
    })
  })

  it('returns found:false on a file with no @consumers tag', () => {
    const src = [
      '/**',
      ' * Shared helper.',
      ' * Just some prose, no consumers tag.',
      ' */',
      'export function foo() {}',
    ].join('\n')
    expect(parseConsumersTag(src)).toEqual({
      found: false,
      names: [],
      sorted: true,
    })
  })

  it('tolerates extra whitespace and trailing comma', () => {
    const src = ['/**', ' * @consumers   alpha ,  beta  ,   gamma ,', ' */'].join('\n')
    expect(parseConsumersTag(src)).toEqual({
      found: true,
      names: ['alpha', 'beta', 'gamma'],
      sorted: true,
    })
  })

  it('returns null on an invalid token (uppercase / underscore / dot)', () => {
    const upperSrc = ['/**', ' * @consumers Foo_Bar', ' */'].join('\n')
    const dotSrc = ['/**', ' * @consumers name.with.dot', ' */'].join('\n')
    const underscoreSrc = ['/**', ' * @consumers _shared', ' */'].join('\n')
    expect(parseConsumersTag(upperSrc)).toBeNull()
    expect(parseConsumersTag(dotSrc)).toBeNull()
    expect(parseConsumersTag(underscoreSrc)).toBeNull()
  })

  it('first @consumers line wins when multiple are present', () => {
    const src = ['/**', ' * @consumers alpha, beta', ' * @consumers gamma, delta', ' */'].join('\n')
    expect(parseConsumersTag(src)).toEqual({
      found: true,
      names: ['alpha', 'beta'],
      sorted: true,
    })
  })

  it('returns null on an empty @consumers value (degenerate case)', () => {
    // `@consumers` present but with no value — distinct from "tag absent".
    // Treated as a parse failure (null), matching parseBashArray's
    // null-on-fail convention; encourages the author to either add names
    // or remove the tag.
    const src = ['/**', ' * @consumers', ' */'].join('\n')
    expect(parseConsumersTag(src)).toBeNull()
  })
})
