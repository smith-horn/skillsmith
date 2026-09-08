/**
 * SMI-6441: unit tests for scripts/gen-weak-password-lexicon.mjs.
 * @module scripts/tests/gen-weak-password-lexicon
 *
 * Exercises every sanity gate the generator specifies
 * (docs/internal/implementation/smi-6441-weak-password-veto.md, Wave 1 Step
 * 3) against small synthetic fixtures — not the real ~7k-entry vendored
 * snapshot, so these stay fast and independent of upstream data size. The
 * generator's own pure functions are imported directly; `detectDrift` and
 * `renderModule` are exercised with injected fakes rather than real repo
 * paths, matching the file's own testability design.
 */

import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain ESM module, no .d.ts (same pattern as
// scripts/tests/gen-docs-folder-index.test.ts)
import {
  sha256Hex,
  verifySourcesIntegrity,
  truncateToRankLimit,
  filterShapeTokens,
  parseKeeplist,
  parseProseStopwords,
  subtractKeeplist,
  findStopwordCollisions,
  findEncodingUnsafeEntries,
  assertEntryCountInRange,
  wrapPayload,
  computeLexicon,
  renderModule,
  assertEmittedLineBudget,
  detectDrift,
  generateAll,
  MIN_ENTRIES,
  MAX_ENTRIES,
  MAX_EMITTED_LINES,
  SOURCE_RANK_LIMIT,
} from '../gen-weak-password-lexicon.mjs'

/** Minimal PROSE_STOPWORDS fixture matching the real file's anchor shape. */
function proseLexiconFixture(words: string[]): string {
  const body = words.map((w) => (w.includes("'") ? `"${w}"` : `'${w}'`)).join(',\n  ')
  return `export const PROSE_STOPWORDS = new Set([\n  ${body}\n])\n`
}

/**
 * `count` unique lowercase-alphabetic filler tokens (a base-26 suffix over
 * `prefix`) that pass the generator's `/^[a-z]{3,19}$/` shape filter — used
 * to pad a synthetic snapshot up over MIN_ENTRIES. A NUMERIC suffix (e.g.
 * `entry${i}`) would NOT pass the shape filter, since it requires the whole
 * token to be lowercase letters only.
 */
function letterFillerTokens(count: number, prefix = 'zzq'): string[] {
  const tokens: string[] = []
  for (let i = 0; i < count; i++) {
    let n = i
    let suffix = ''
    do {
      suffix = String.fromCharCode(97 + (n % 26)) + suffix
      n = Math.floor(n / 26)
    } while (n > 0)
    tokens.push(prefix + suffix)
  }
  return tokens
}

describe('sha256Hex', () => {
  it('matches the known SHA-256 digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('verifySourcesIntegrity — SHA-256 mismatch hard-fails', () => {
  it('throws when the computed digest does not match the recorded one', () => {
    const sources = { files: [{ file: 'x.txt', sha256: 'deadbeef', commit: 'abc123' }] }
    expect(() => verifySourcesIntegrity(sources, () => Buffer.from('real content'))).toThrow(
      /integrity check failed for x\.txt/
    )
  })

  it('does not throw when the digest matches', () => {
    const content = Buffer.from('real content')
    const sources = { files: [{ file: 'x.txt', sha256: sha256Hex(content), commit: 'abc123' }] }
    expect(() => verifySourcesIntegrity(sources, () => content)).not.toThrow()
  })
})

describe('filterShapeTokens', () => {
  it('keeps only lowercase 3-19 char alphabetic tokens, lowercased and deduped', () => {
    const raw = [
      'Password',
      'ab',
      '123456',
      'ok',
      'horsestaplebattery1234567890extra',
      'Horse',
      'horse',
    ]
    const result = filterShapeTokens(raw.join('\n'))
    expect(result).toEqual(new Set(['password', 'horse']))
  })
})

describe('parseKeeplist', () => {
  it('parses whitespace-separated tokens across multiple lines, stripping # comments', () => {
    const text = '# a comment\naccess admin\n\nmaster # inline comment\nkey\n'
    expect(parseKeeplist(text)).toEqual(new Set(['access', 'admin', 'master', 'key']))
  })
})

describe('parseProseStopwords', () => {
  it('extracts a flat Set literal, including double-quoted entries with an apostrophe', () => {
    const src = proseLexiconFixture(['the', 'a', "can't", 'never'])
    expect(parseProseStopwords(src)).toEqual(new Set(['the', 'a', "can't", 'never']))
  })

  it('throws when the anchor is missing', () => {
    expect(() => parseProseStopwords('export const SOMETHING_ELSE = []\n')).toThrow(
      /anchor not found/
    )
  })
})

describe('subtractKeeplist', () => {
  it('removes every keeplist member from the token set', () => {
    const result = subtractKeeplist(new Set(['horse', 'access', 'monkey']), new Set(['access']))
    expect(result).toEqual(new Set(['horse', 'monkey']))
  })
})

describe('findStopwordCollisions', () => {
  it('returns colliding tokens sorted', () => {
    expect(
      findStopwordCollisions(['horse', 'please', 'monkey', 'never'], new Set(['please', 'never']))
    ).toEqual(['never', 'please'])
  })

  it('returns an empty array when disjoint', () => {
    expect(findStopwordCollisions(['horse', 'monkey'], new Set(['please']))).toEqual([])
  })
})

describe('findEncodingUnsafeEntries — M-1, independent of the shape regex', () => {
  it('flags backtick, backslash, and dollar-sign entries', () => {
    expect(findEncodingUnsafeEntries(['safe', 'has`tick', 'has\\slash', 'has$dollar'])).toEqual([
      'has$dollar',
      'has\\slash',
      'has`tick',
    ])
  })

  it('returns empty for entries with none of the three unsafe characters', () => {
    expect(findEncodingUnsafeEntries(['horse', 'monkey', 'dragon'])).toEqual([])
  })
})

describe('assertEntryCountInRange — M-2 [2000, 6000] bound', () => {
  it('throws below the floor (the "silently disabled detector" case)', () => {
    expect(() => assertEntryCountInRange(0, MIN_ENTRIES, MAX_ENTRIES)).toThrow(
      /outside the sanity bound/
    )
    expect(() => assertEntryCountInRange(1999, MIN_ENTRIES, MAX_ENTRIES)).toThrow(
      /outside the sanity bound/
    )
  })

  it('throws above the ceiling', () => {
    expect(() => assertEntryCountInRange(6001, MIN_ENTRIES, MAX_ENTRIES)).toThrow(
      /outside the sanity bound/
    )
  })

  it('does not throw inside the bound', () => {
    expect(() => assertEntryCountInRange(4500, MIN_ENTRIES, MAX_ENTRIES)).not.toThrow()
  })
})

describe('SOURCE_RANK_LIMIT (M-2a)', () => {
  it('is 5000, per the plan doc\'s "Sizing the corpus" derivation', () => {
    expect(SOURCE_RANK_LIMIT).toBe(5000)
  })
})

describe('truncateToRankLimit — rank-order cut, must run before shape filtering (M-2a)', () => {
  it('keeps exactly the first `limit` lines, in file order', () => {
    const raw = ['a', 'b', 'c', 'd', 'e'].join('\n')
    expect(truncateToRankLimit(raw, 3)).toBe('a\nb\nc')
  })

  it('is a no-op when limit exceeds the line count', () => {
    const raw = ['a', 'b'].join('\n')
    expect(truncateToRankLimit(raw, 100)).toBe('a\nb')
  })

  it('drops everything when limit is 0', () => {
    expect(truncateToRankLimit('a\nb\nc', 0)).toBe('')
  })
})

describe('computeLexicon — SOURCE_RANK_LIMIT truncation boundary, both directions (M-2a)', () => {
  // Per the plan: "Testing only that the fixtures survive would pass even
  // if truncation silently never ran, so the exclusion half is the
  // load-bearing half." This test asserts BOTH a survivor at the boundary
  // AND the immediately-next, correctly-excluded token — a regression that
  // removes or raises the truncation step would turn the excluded token
  // green and fail this test.
  const proseLexicon = proseLexiconFixture(['the', 'a'])

  it('keeps a token exactly at the limit and drops the very next rank', () => {
    const limit = MIN_ENTRIES + 5
    const filler = letterFillerTokens(limit - 1) // occupies ranks 1..limit-1
    const raw = [...filler, 'survivor', 'excluded'].join('\n') // ranks limit, limit+1
    const entries = computeLexicon({
      snapshotText: raw,
      keeplistText: '',
      proseLexiconText: proseLexicon,
      sourceRankLimit: limit,
    })
    expect(entries).toContain('survivor')
    expect(entries).not.toContain('excluded')
  })

  it('a smaller sourceRankLimit excludes tokens the untruncated pipeline would have kept', () => {
    const filler = letterFillerTokens(MIN_ENTRIES + 5)
    const raw = [...filler, 'onlyuntrunc'].join('\n')
    // Untruncated (limit covers the whole raw text): the extra token survives.
    const untruncated = computeLexicon({
      snapshotText: raw,
      keeplistText: '',
      proseLexiconText: proseLexicon,
      sourceRankLimit: raw.split('\n').length,
    })
    expect(untruncated).toContain('onlyuntrunc')
    // Truncated one rank short of the extra token: it must be excluded.
    const truncated = computeLexicon({
      snapshotText: raw,
      keeplistText: '',
      proseLexiconText: proseLexicon,
      sourceRankLimit: MIN_ENTRIES + 5,
    })
    expect(truncated).not.toContain('onlyuntrunc')
  })
})

describe('computeLexicon — end-to-end gate composition on synthetic fixtures', () => {
  const proseLexicon = proseLexiconFixture(['the', 'a', 'please', 'never'])

  it('hard-fails on an empty/all-filtered snapshot (silently-disabled-detector case)', () => {
    expect(() =>
      computeLexicon({
        snapshotText: '123456\nab\n!!!\n',
        keeplistText: '',
        proseLexiconText: proseLexicon,
      })
    ).toThrow(/outside the sanity bound/)
  })

  it('hard-fails when a survivor collides with PROSE_STOPWORDS, naming the token', () => {
    // 'please' passes the shape filter and is not in the (empty) keeplist,
    // so it collides with the stopword fixture above. The disjointness
    // check runs BEFORE the count-range gate in computeLexicon, so this
    // throws regardless of overall entry count.
    expect(() =>
      computeLexicon({
        snapshotText: 'please\nhorse\nmonkey\n',
        keeplistText: '',
        proseLexiconText: proseLexicon,
      })
    ).toThrow(/PROSE_STOPWORDS disjointness violated by: please/)
  })

  it('succeeds and returns a sorted array once all gates are satisfied', () => {
    const filler = letterFillerTokens(MIN_ENTRIES + 10).join('\n')
    const entries = computeLexicon({
      snapshotText: `horse\nmonkey\ndragon\naccess\n${filler}\n`,
      keeplistText: 'access',
      proseLexiconText: proseLexicon,
    })
    expect(entries).toContain('horse')
    expect(entries).toContain('monkey')
    expect(entries).not.toContain('access')
    expect(entries).toEqual([...entries].sort())
    expect(entries.length).toBeGreaterThanOrEqual(MIN_ENTRIES)
    expect(entries.length).toBeLessThanOrEqual(MAX_ENTRIES)
  })
})

describe('renderModule — records sourceRankLimit in WEAK_PASSWORD_LEXICON_SOURCE (M-2a)', () => {
  it('emits the literal sourceRankLimit value passed in `source`', () => {
    const source = {
      upstream: 'https://example.test/repo',
      path: 'fixture.txt',
      license: 'MIT',
      commit: 'a'.repeat(40),
      sha256: 'b'.repeat(64),
      sourceRankLimit: 5000,
      entries: 2,
    }
    const text = renderModule({
      moduleLine: '@module fixture',
      source,
      version: '2026-01-01.1',
      payloadLines: ['horse monkey'],
    })
    expect(text).toMatch(/sourceRankLimit: 5000,/)
  })

  it('generateAll defaults to the real SOURCE_RANK_LIMIT constant when the caller omits it', () => {
    const proseLexicon = proseLexiconFixture(['the', 'a'])
    const filler = letterFillerTokens(MIN_ENTRIES + 10)
    const inputs = {
      snapshotText: filler.join('\n'),
      keeplistText: '',
      proseLexiconText: proseLexicon,
      sourceMeta: {
        upstream: 'https://example.test/repo',
        path: 'fixture.txt',
        license: 'MIT',
        commit: 'a'.repeat(40),
        sha256: 'b'.repeat(64),
      },
    }
    const result = generateAll(inputs)
    for (const r of result.rendered) {
      expect(r.text).toMatch(new RegExp(`sourceRankLimit: ${SOURCE_RANK_LIMIT},`))
    }
  })
})

describe('renderModule + assertEmittedLineBudget — M-2 480-line gate', () => {
  const source = {
    upstream: 'https://example.test/repo',
    path: 'fixture.txt',
    license: 'MIT',
    commit: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    sourceRankLimit: 5000,
    entries: 3,
  }

  it('throws when the emitted file exceeds MAX_EMITTED_LINES, naming the front-coding lever', () => {
    // A payload wide enough to force many wrapped lines under a tiny width.
    const manyLines = Array.from({ length: MAX_EMITTED_LINES + 20 }, (_, i) => `line${i}`)
    const text = renderModule({
      moduleLine: '@module fixture',
      source,
      version: '2026-01-01.1',
      payloadLines: manyLines,
    })
    expect(() => assertEmittedLineBudget(text, 'fixture')).toThrow(/front-coding/)
    expect(() => assertEmittedLineBudget(text, 'fixture')).toThrow(/check-file-length\.ignore/)
  })

  it('does not throw for a small payload', () => {
    const text = renderModule({
      moduleLine: '@module fixture',
      source,
      version: '2026-01-01.1',
      payloadLines: ['horse monkey dragon'],
    })
    expect(() => assertEmittedLineBudget(text, 'fixture')).not.toThrow()
  })
})

describe('renderModule — three renders differ ONLY in the @module line', () => {
  it('is the single differing line across three module-line variants', () => {
    const source = {
      upstream: 'https://example.test/repo',
      path: 'fixture.txt',
      license: 'MIT',
      commit: 'a'.repeat(40),
      sha256: 'b'.repeat(64),
      sourceRankLimit: 5000,
      entries: 2,
    }
    const payloadLines = ['horse monkey']
    const variants = [
      '@module @skillsmith/core/security/scanner/SecurityScanner.weak-passwords',
      '@module scripts/indexer/_shared/security-scanner-edge.weak-passwords (Node port)',
      '@module _shared/security-scanner-edge.weak-passwords',
    ]
    const texts = variants.map((moduleLine) =>
      renderModule({ moduleLine, source, version: '2026-01-01.1', payloadLines })
    )
    const linesByVariant = texts.map((t) => t.split('\n'))
    const lineCount = linesByVariant[0].length
    for (const lines of linesByVariant) expect(lines.length).toBe(lineCount)

    const differingLineIndexes: number[] = []
    for (let i = 0; i < lineCount; i++) {
      const values = new Set(linesByVariant.map((lines) => lines[i]))
      if (values.size > 1) differingLineIndexes.push(i)
    }
    expect(differingLineIndexes).toHaveLength(1)
    for (const lines of linesByVariant) {
      expect(lines[differingLineIndexes[0]]).toMatch(/@module/)
    }
  })
})

describe('determinism — two consecutive generations produce byte-identical output', () => {
  it('computeLexicon + renderModule are pure functions of their inputs', () => {
    const proseLexicon = proseLexiconFixture(['the', 'a'])
    const filler = letterFillerTokens(MIN_ENTRIES + 10).join('\n')
    const inputs = {
      snapshotText: `horse\nmonkey\ndragon\n${filler}\n`,
      keeplistText: '',
      proseLexiconText: proseLexicon,
    }
    const entriesA = computeLexicon(inputs)
    const entriesB = computeLexicon(inputs)
    expect(entriesA).toEqual(entriesB)

    const source = {
      upstream: 'x',
      path: 'y',
      license: 'MIT',
      commit: 'c',
      sha256: 's',
      sourceRankLimit: 5000,
      entries: entriesA.length,
    }
    const payloadLines = wrapPayload(entriesA)
    const textA = renderModule({
      moduleLine: '@module fixture',
      source,
      version: '2026-01-01.1',
      payloadLines,
    })
    const textB = renderModule({
      moduleLine: '@module fixture',
      source,
      version: '2026-01-01.1',
      payloadLines,
    })
    expect(textA).toBe(textB)
  })
})

describe('detectDrift — --check exits with drift after a one-character hand edit', () => {
  it('reports "stale" when on-disk content differs by one character', () => {
    const rendered = [{ label: 'fixture', path: '/fake/fixture.ts', text: 'export const X = 1\n' }]
    const statuses = detectDrift(rendered, {
      exists: () => true,
      readOnDisk: () => 'export const X = 2\n', // one-character hand edit
    })
    expect(statuses[0].status).toBe('stale')
  })

  it('reports "fresh" when on-disk content matches exactly', () => {
    const rendered = [{ label: 'fixture', path: '/fake/fixture.ts', text: 'export const X = 1\n' }]
    const statuses = detectDrift(rendered, {
      exists: () => true,
      readOnDisk: () => 'export const X = 1\n',
    })
    expect(statuses[0].status).toBe('fresh')
  })

  it('reports "missing" when the file does not exist on disk', () => {
    const rendered = [{ label: 'fixture', path: '/fake/fixture.ts', text: 'export const X = 1\n' }]
    const statuses = detectDrift(rendered, { exists: () => false })
    expect(statuses[0].status).toBe('missing')
  })
})
