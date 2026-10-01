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

import { flattenSubWords } from '../lib/shell-command-normalize.mjs'
import {
  nestedGroupAlternatives,
  stripTransparentHeadWords,
  transparentHeadReadings,
} from '../lib/shell-command-readings.mjs'
import { tokenize } from '../lib/shell-command-tokenize.mjs'
import {
  globGroupAlternativeReadings,
  groupingOpSubRuns,
  inputRedirectSources,
  SEGMENT_SEPARATOR_OPS,
  shellBodySegmentArgvs,
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

  // SMI-6903 round 21 F4: this row previously asserted `[]` for a nested
  // group -- it PINNED the limitation that left the H1 fix bypassable by one
  // extra paren, so the fix turned it red. Re-pointed rather than reverted:
  // zsh nests glob alternations and zsh 5.9 invokes a decoy executable through
  // all three nested spellings (measured). The rebuild FLATTENS instead of
  // computing the real cross product, which is sound only because the reading
  // is additive -- see `nestedGroupAlternatives`.
  it('flattens a group containing a nested paren (zsh nests alternations)', () => {
    expect(readingWords('./((a|node_modules)|y)/.bin/ruflo')).toContainEqual([
      './node_modules/.bin/ruflo',
    ])
    expect(readingWords('./(y|(a|node_modules))/.bin/ruflo')).toContainEqual([
      './node_modules/.bin/ruflo',
    ])
    expect(readingWords('./(a(x|node_modules))/.bin/ruflo')).toContainEqual([
      './node_modules/.bin/ruflo',
    ])
  })

  // The flattening's own stated residue, pinned so it is a recorded decision
  // rather than a silent one: the words of a nested group are not necessarily
  // path components, so a reading zsh would never form can appear. That can
  // only ADD a denial, which is the whole reason the approximation is allowed.
  it('the flattened reading is an over-approximation, not the cross product', () => {
    expect(readingWords('echo ((a|b)|c)')).toEqual([
      ['echo', 'a'],
      ['echo', 'b'],
      ['echo', 'c'],
    ])
  })

  // Finding 6 (round 21): the GROUP cap had no row of its own. The five-group
  // row below it is 32 readings, so MAX_GLOB_READINGS abandons that one too --
  // raising MAX_GLOB_GROUPS to 99 left every row green (mutant M23). One
  // alternative per group is ONE reading, so only the group cap can abandon it.
  it('abandons past the GROUP cap even when the reading count is 1', () => {
    expect(globGroupAlternativeReadings(tokenize('./(a)/(b)/(c)/(d)/(e)/x'))).toEqual([])
    // Four groups is at the cap, so this one IS expanded -- the pair isolates
    // the boundary rather than asserting one side of it.
    expect(globGroupAlternativeReadings(tokenize('./(a)/(b)/(c)/(d)/x'))).toHaveLength(1)
  })

  // Finding 7 (round 21): the `adjacent` weld branch of `weldChains` had no
  // row of its own -- no `)(` shape existed anywhere in the four guard suites,
  // and deleting the branch left every row green (mutant M20). Two groups
  // welded with NO word between them form one zsh word.
  it('welds two DIRECTLY adjacent groups into one word', () => {
    expect(readingWords('./(node|x)(_modules|y)/.bin/ruflo')).toContainEqual([
      './node_modules/.bin/ruflo',
    ])
    expect(readingWords('echo (a|b)(c|d)')).toEqual([
      ['echo', 'ac'],
      ['echo', 'ad'],
      ['echo', 'bc'],
      ['echo', 'bd'],
    ])
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

// Finding 9 (round 21): `inputRedirectSources` is the SMI-6903 C1 fix's core
// and had no direct unit row -- only end-to-end `decide()` arms. Dropping the
// `(?![<&])` lookahead changed this function's output on 16 of 60 redirect
// spellings with nothing to catch it (mutant M2); no verdict moved, because
// every string the mutant extracts carries a leading `&`/`<` that cannot
// classify protected, so the gap was at the function level only.
describe('inputRedirectSources() — SMI-6903 C1 / round 21 finding 9', () => {
  const sources = (command: string) =>
    inputRedirectSources(splitCommandSegments(tokenize(command))[0] ?? [])

  it('reads an INPUT redirect source, glued and space-separated', () => {
    expect(sources('cat < .env')).toEqual(['.env'])
    expect(sources('cat <.env')).toEqual(['.env'])
    expect(sources('cat 0< .env')).toEqual(['.env'])
    expect(sources('cat 3<.env')).toEqual(['.env'])
    expect(sources('cat <> .env')).toEqual(['.env'])
    expect(sources('< .env cat')).toEqual(['.env'])
  })

  it('names NO source for an fd duplication or a here-string', () => {
    // `<&`/`<&3`/`<&-` name a descriptor, not a file; `<<<` carries TEXT --
    // `cat <<< .env` prints those four characters (measured, all three shells).
    // This is the row the `(?![<&])` lookahead exists for.
    expect(sources('cat <& .env')).toEqual([])
    expect(sources('cat <&3 .env')).toEqual([])
    expect(sources('cat <&- .env')).toEqual([])
    expect(sources('cat <<< .env')).toEqual([])
  })

  it('names NO source for an OUTPUT redirect', () => {
    for (const command of ['echo hi > .env', 'echo hi >> .env', 'echo hi >| .env', 'cat x 2>&1']) {
      expect(sources(command)).toEqual([])
    }
  })

  it('expands a substitution source only when given a flatten (F2)', () => {
    const segment = splitCommandSegments(tokenize('cat < $(echo .env)'))[0]
    expect(inputRedirectSources(segment)).toEqual(['$(echo .env)'])
    expect(inputRedirectSources(segment, flattenSubWords)).toContain('.env')
  })
})

// SMI-6903 round 21 F1/F3/F4 helpers, at the unit level.
describe('shell-command-readings.mjs — SMI-6903 round 21', () => {
  it('strips leading transparent head words, iteratively and by identity', () => {
    expect(stripTransparentHeadWords(['then', 'command', 'cat', '.env'])).toEqual(['cat', '.env'])
    expect(stripTransparentHeadWords(['do', 'cat'])).toEqual(['cat'])
    const untouched = ['cat', '.env']
    expect(stripTransparentHeadWords(untouched)).toBe(untouched)
  })

  it('yields one extra segment per transparent-headed segment, and none otherwise', () => {
    const seg = (c: string) => splitCommandSegments(tokenize(c))
    expect(shape(transparentHeadReadings(seg('if true; then cat .env; fi')))).toEqual([
      ['true'],
      ['cat', '.env'],
    ])
    expect(transparentHeadReadings(seg('cat .env'))).toEqual([])
    // A segment that is ENTIRELY transparent words has no command to judge.
    expect(transparentHeadReadings(seg('then; cat .env'))).toEqual([])
  })

  it('the combined reading keeps the transparent-head segments', () => {
    const combined = shape(splitCommandSegmentsWithSubRuns(tokenize('if true; then cat .env; fi')))
    expect(combined).toContainEqual(['cat', '.env'])
  })

  it('reads the argv of each segment of a shell body (F3)', () => {
    expect(shellBodySegmentArgvs(tokenize, 'cat')).toEqual([['cat']])
    expect(shellBodySegmentArgvs(tokenize, 'echo hi; grep -q K')).toEqual([
      ['echo', 'hi'],
      ['grep', '-q', 'K'],
    ])
    // Redirect words are excluded, so a body's own redirect cannot become argv.
    expect(shellBodySegmentArgvs(tokenize, 'cat < f')).toEqual([['cat']])
    expect(shellBodySegmentArgvs(tokenize, '')).toEqual([])
  })

  it('flattens a nested group to one single-word alternative per word (F4)', () => {
    const tokens = tokenize('echo ((a|b)|c)')
    const open = tokens.findIndex((t) => t.type === 'op' && t.value === '(')
    const close = tokens.length - 1
    const alts = nestedGroupAlternatives(tokens, open, close)
    expect(alts?.map((a) => a.map((t) => t.value))).toEqual([['a'], ['b'], ['c']])
    // No word in the span means nothing to read, and the caller skips it.
    expect(nestedGroupAlternatives(tokenize('echo (())'), 1, 4)).toBeNull()
  })
})
