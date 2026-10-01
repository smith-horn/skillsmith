/**
 * Unit tests for `scripts/lib/shell-command-segments.mjs` (SMI-6903).
 *
 * Two readings live here that exist because the single separator reading was
 * wrong for one real shell:
 *
 *   - `splitCommandSegmentsParensGrouping` (C3) reads `(`/`)` as GROUPING, so
 *     zsh's glob group `cat (.env|zzz)` -- one word to that shell -- is not
 *     torn into three segments with the protected path as a harmless-looking
 *     `argv[0]`.
 *   - `globGroupAlternativeReadings` (H1) rebuilds the single word a glob
 *     group forms with the words welded to it, so an `argv[0]`-keyed check
 *     can see `./(node_modules|x)/.bin/ruflo` for the path it really is.
 *
 * Both are ADDITIVE by construction: a caller keeps its own primary reading
 * and only adds verdicts from these, so an approximate rebuild can only ever
 * over-block. That direction is the whole design, because the alternative --
 * changing the primary reading -- was measured moving 21 real repository
 * command lines from deny to allow.
 *
 * Every shell claim cited below was measured in bash 3.2 (host), bash 5.2
 * (container) and zsh 5.9 (host, the shell Claude Code's Bash tool runs on
 * this machine), with a decoy file or executable actually read or invoked.
 */
import { describe, expect, it } from 'vitest'

import { tokenize } from '../lib/shell-command-tokenize.mjs'
import {
  globGroupAlternativeReadings,
  groupingOpSubRuns,
  SEGMENT_SEPARATOR_OPS,
  splitCommandSegments,
  splitCommandSegmentsParensGrouping,
  splitCommandSegmentsWithSubRuns,
} from '../lib/shell-command-segments.mjs'

/** The word values of each segment, for readable assertions. */
function shape(segments: Array<Array<{ type: string; value?: string }>>) {
  return segments.map((seg) => seg.filter((t) => t.type === 'word').map((t) => t.value))
}

/** Every word value of every rebuilt reading, flattened. */
function readingWords(command: string) {
  return globGroupAlternativeReadings(tokenize(command)).map((r) =>
    r.filter((t) => t.type === 'word').map((t) => t.value)
  )
}

describe('SEGMENT_SEPARATOR_OPS', () => {
  it('contains the real separators AND the parens, but not the braces', () => {
    for (const op of [';', '&&', '||', '|', '&', '\n', '(', ')']) {
      expect(SEGMENT_SEPARATOR_OPS.has(op)).toBe(true)
    }
    // `{`/`}` are bash RESERVED WORDS, not separators: splitting on them is
    // what let `cat ${HOME}/.env` reach allow (round 15).
    expect(SEGMENT_SEPARATOR_OPS.has('{')).toBe(false)
    expect(SEGMENT_SEPARATOR_OPS.has('}')).toBe(false)
  })
})

describe('splitCommandSegmentsParensGrouping() — SMI-6903 C3', () => {
  it('keeps a reader and its glob-group argument in ONE segment', () => {
    // The separator reading yields cat / .env / zzz; this one must not.
    expect(shape(splitCommandSegments(tokenize('cat (.env|zzz)')))).toEqual([
      ['cat'],
      ['.env'],
      ['zzz'],
    ])
    expect(shape(splitCommandSegmentsParensGrouping(tokenize('cat (.env|zzz)')))).toEqual([
      ['cat', '.env', 'zzz'],
    ])
  })

  it('a `|` inside a WORD-position group is not a pipe', () => {
    expect(shape(splitCommandSegmentsParensGrouping(tokenize('cat (zzz|.env)')))).toEqual([
      ['cat', 'zzz', '.env'],
    ])
  })

  it("a real subshell's `|` IS a pipe and still splits", () => {
    expect(shape(splitCommandSegmentsParensGrouping(tokenize('(echo x) | cat f')))).toEqual([
      ['echo', 'x'],
      ['cat', 'f'],
    ])
  })

  it('an ordinary pipeline is unchanged', () => {
    expect(shape(splitCommandSegmentsParensGrouping(tokenize('echo a | cat f')))).toEqual([
      ['echo', 'a'],
      ['cat', 'f'],
    ])
  })

  it('the combined reading is a SUPERSET of each individual one (additive)', () => {
    const tokens = tokenize('cat (.env|zzz)')
    const combined = splitCommandSegmentsWithSubRuns(tokens)
    for (const produced of [
      splitCommandSegments(tokens),
      groupingOpSubRuns(tokens),
      splitCommandSegmentsParensGrouping(tokens),
    ]) {
      for (const seg of shape(produced)) {
        expect(shape(combined)).toContainEqual(seg)
      }
    }
  })
})

describe('globGroupAlternativeReadings() — SMI-6903 H1', () => {
  it('returns [] when there is no word-position group (costs nothing)', () => {
    expect(globGroupAlternativeReadings(tokenize('npx ruflo memory store'))).toEqual([])
    expect(globGroupAlternativeReadings(tokenize('(cat f)'))).toEqual([])
    expect(globGroupAlternativeReadings(tokenize('echo a | cat f'))).toEqual([])
  })

  it('rebuilds the single welded word for each alternative', () => {
    // Measured: zsh 5.9 runs `./(node_modules|x)/.bin/tool`.
    expect(readingWords('./(node_modules|x)/.bin/ruflo memory store')).toEqual([
      ['./node_modules/.bin/ruflo', 'memory', 'store'],
      ['./x/.bin/ruflo', 'memory', 'store'],
    ])
  })

  it('welds on the left only, and on the right only', () => {
    expect(readingWords('./node_modules/.bin/(ruflo|x)')).toEqual([
      ['./node_modules/.bin/ruflo'],
      ['./node_modules/.bin/x'],
    ])
    // `echo (a|b)tail`, NOT `(a|b)tail`: a line-leading `(` is COMMAND
    // position, so it is a subshell and never expanded. Measured in zsh 5.9,
    // which agrees -- `(./node_modules|x)/.bin/tool` is a parse error there.
    expect(readingWords('echo (a|b)tail')).toEqual([
      ['echo', 'atail'],
      ['echo', 'btail'],
    ])
  })

  it('a line-leading `(` is a subshell, not a glob group, and is not expanded', () => {
    expect(globGroupAlternativeReadings(tokenize('(a|b)tail'))).toEqual([])
  })

  it('welds TWO groups that share the word between them', () => {
    // Measured: zsh 5.9 runs `./(a|node_modules)/(x|.bin)/tool`. Treating the
    // groups independently made their spans overlap and consumed the shared
    // `/` twice, producing no usable reading at all.
    expect(readingWords('./(a|node_modules)/(x|.bin)/ruflo')).toEqual([
      ['./a/x/ruflo'],
      ['./a/.bin/ruflo'],
      ['./node_modules/x/ruflo'],
      ['./node_modules/.bin/ruflo'],
    ])
  })

  it('leaves a space-separated group unwelded', () => {
    expect(readingWords('echo (a|b)')).toEqual([
      ['echo', 'a'],
      ['echo', 'b'],
    ])
  })

  it('never expands a MULTI-WORD alternative (an array assignment, not a glob)', () => {
    // No zsh glob alternative can hold an unquoted blank -- a blank ends the
    // word. The repository's own `compose_profile_args+=(--profile "$p")` was
    // the single corpus difference this rule removed.
    expect(globGroupAlternativeReadings(tokenize('a=(1 2)'))).toEqual([])
    expect(
      globGroupAlternativeReadings(tokenize('compose_profile_args+=(--profile "$profile")'))
    ).toEqual([])
  })

  it('skips a group containing a nested paren rather than guessing', () => {
    expect(globGroupAlternativeReadings(tokenize('echo ((a|b)|c)'))).toEqual([])
  })

  it('abandons the expansion past the group cap instead of truncating it', () => {
    // A partial cross product would check some alternatives and not others,
    // which reads as coverage it did not give. Five groups exceeds the cap.
    expect(globGroupAlternativeReadings(tokenize('./(a|b)/(c|d)/(e|f)/(g|h)/(i|j)/x'))).toEqual([])
  })

  it('abandons the expansion past the reading cap', () => {
    // Four groups of four alternatives is 256 readings, past MAX_GLOB_READINGS.
    const many = './(a|b|c|d)/(e|f|g|h)/(i|j|k|l)/(m|n|o|p)/x'
    expect(globGroupAlternativeReadings(tokenize(many))).toEqual([])
  })

  it('a reading preserves the tokens outside the group untouched', () => {
    const readings = globGroupAlternativeReadings(tokenize('echo (a|b) && cat f'))
    expect(readings).toHaveLength(2)
    for (const r of readings) {
      expect(r.filter((t) => t.type === 'op').map((t) => t.value)).toEqual(['&&'])
    }
  })
})
