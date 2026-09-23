/**
 * SMI-6744 (PR #2923 post-merge retro, G3/G4): tests for `buildHighlights()`.
 *
 * Two defects, each with a red arm that was watched to fail:
 *   G3 -- an empty term (trailing space, lone `*`, empty query) built the
 *         alternation `(foo|)` or `()`, which matches the empty string at
 *         every character boundary and wraps the whole name in <mark></mark>.
 *         Red arm: remove `.filter((t) => t.length > 0)` in buildHighlights.
 *   G4 -- one global-flag regex served both `.test()` calls. The shipped
 *         sequence never saw a leaked `lastIndex`, for three different reasons
 *         (a falsy name short-circuits; a failing name test resets it itself;
 *         only on a matching name did the interleaved `.replace()` reset it),
 *         measured against 63ebf831b over 11 reachable paths. Any reordering,
 *         or a second object, exposes the hazard.
 *         Red arm: make `matcher` global (`new RegExp(source, 'gi')`).
 *   F1 -- (governance on the first commit) the snippet window was placed at
 *         `indexOf()` on a lowercased copy of the description, which
 *         `toLowerCase()` can shift (U+0130 grows) or lose (Greek final sigma),
 *         so the window could exclude the match and drop the highlight.
 *         Red arm: restore the `indexOf` line in place of `match.index`.
 */

import { describe, expect, it } from 'vitest'
import type { Skill } from '../types/skill.js'
import { buildHighlights } from './SearchService.helpers.js'

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'acme/foo-tool',
    name: 'foo tool',
    description: 'A tool that does foo things',
    author: 'acme',
    repoUrl: null,
    qualityScore: null,
    trustTier: 'community',
    tags: [],
    installable: true,
    riskScore: null,
    securityFindingsCount: 0,
    securityScannedAt: null,
    securityPassed: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('buildHighlights -- empty terms (G3)', () => {
  it('treats a trailing space exactly like no trailing space', () => {
    const s = skill()
    expect(buildHighlights(s, 'foo ')).toEqual(buildHighlights(s, 'foo'))
    expect(buildHighlights(s, 'foo').name).toBe('<mark>foo</mark> tool')
  })

  it('never emits an empty <mark></mark> pair', () => {
    const s = skill()
    for (const query of ['foo ', ' foo', 'foo  bar', '*', '', '  ', '""', 'AND', 'foo *']) {
      const h = buildHighlights(s, query)
      expect(h.name ?? '', `query ${JSON.stringify(query)}`).not.toContain('<mark></mark>')
      expect(h.description ?? '', `query ${JSON.stringify(query)}`).not.toContain('<mark></mark>')
    }
  })

  it('returns no highlights when every term is empty', () => {
    const s = skill()
    for (const query of ['*', '', '  ', '""', 'AND OR NOT', '* *']) {
      expect(buildHighlights(s, query), `query ${JSON.stringify(query)}`).toEqual({})
    }
  })
})

describe('buildHighlights -- matcher state (G4)', () => {
  it('highlights the description after a name match', () => {
    // The name match must land at an offset >= the description's match offset
    // so a leaked lastIndex would skip past it: "foo" at name[4], description[2].
    const s = skill({ name: 'the foo', description: 'a foo tool' })
    const h = buildHighlights(s, 'foo')
    expect(h.name).toBe('the <mark>foo</mark>')
    expect(h.description).toBe('a <mark>foo</mark> tool')
  })

  it('highlights every occurrence, not just the first', () => {
    const s = skill({ name: 'foo foo', description: 'foo and foo' })
    const h = buildHighlights(s, 'foo')
    expect(h.name).toBe('<mark>foo</mark> <mark>foo</mark>')
    expect(h.description).toBe('<mark>foo</mark> and <mark>foo</mark>')
  })

  it('is deterministic across repeated calls with the same skill', () => {
    const s = skill({ name: 'the foo', description: 'a foo tool' })
    const first = buildHighlights(s, 'foo')
    const second = buildHighlights(s, 'foo')
    expect(second).toEqual(first)
  })
})

describe('buildHighlights -- case insensitivity', () => {
  it('highlights a capitalised occurrence of a lower-cased term', () => {
    const s = skill({ name: 'FOO Tool', description: 'Contains FOO and Foo' })
    const h = buildHighlights(s, 'foo')
    expect(h.name).toBe('<mark>FOO</mark> Tool')
    expect(h.description).toBe('Contains <mark>FOO</mark> and <mark>Foo</mark>')
  })
})

describe('buildHighlights -- snippet window', () => {
  it('windows 50 characters either side and marks both truncated ends', () => {
    const s = skill({ name: 'n/a', description: 'x'.repeat(80) + ' needle ' + 'y'.repeat(80) })
    expect(buildHighlights(s, 'needle').description).toBe(
      '...' + 'x'.repeat(49) + ' <mark>needle</mark> ' + 'y'.repeat(49) + '...'
    )
  })

  it('windows around the real match offset, not a lowercased-copy offset', () => {
    // 'Σ' lowercases to the final sigma 'ς' inside "ΟΔΟΣ", so indexOf() on a
    // lowercased copy returns -1 and the window silently excludes the match.
    const s = skill({ name: 'n/a', description: 'x'.repeat(80) + ' ΟΔΟΣ ' + 'y'.repeat(80) })
    expect(buildHighlights(s, 'σ').description).toContain('<mark>Σ</mark>')
  })
})

describe('buildHighlights -- escaping', () => {
  it('treats regex metacharacters in a term literally', () => {
    const s = skill({ name: 'c++ helper', description: 'for c++ and c.' })
    const h = buildHighlights(s, 'c++')
    expect(h.name).toBe('<mark>c++</mark> helper')
    expect(h.description).toBe('for <mark>c++</mark> and c.')
  })
})
