/**
 * Tests for endsInShC (SMI-7226), the linear token scan that replaced the
 * SH_C regex in Check 59's shell scanner. The regex had the right meaning but
 * backtracked: exponentially on `-O -x …` (CodeQL js/redos on PR #3257) and,
 * after that fix, quadratically on `bash -c -c -c … x` (PR #3257 delta review).
 * So the regex stays here as the oracle: the scan must agree with it on every
 * input, and must not share its cost.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { endsInShC } from '../audit-shell-npx-cli-sh-c.mjs'
// @ts-expect-error - .mjs helper has no typings
import { scanShellText } from '../audit-shell-npx-cli-helpers.mjs'

// The SH_C regex from the CodeQL js/redos fix on PR #3257, plus the backtick
// in its boundary class: a governance review found `` `bash -c '…'` `` missed,
// although `$(bash -c '…')` was flagged. Only ever run on short inputs here.
const ORACLE =
  /(?:^|[\s;&|(/`])(?:ba|z|da|k)?sh\s+(?:(?:-[oO]\s+[^\s-]\S*|-\S+)\s+)*-[A-Za-z]*c[A-Za-z]*(?:\s+-\S*)*\s*$/

const ROWS: Array<[string, boolean]> = [
  ['sh -c ', true],
  ['bash -lc', true],
  ['/bin/bash -ce ', true],
  ['x;sh -c ', true],
  ['bash -o pipefail -c ', true],
  ['bash -O extglob -e -c -- ', true],
  ['foo -o sh -c ', true], // the shell word can also look like an option value
  ['foo -c -y;sh -c ', true], // the shell word can sit inside a run of flags
  ['bash -c - ', true], // a lone `-` may follow the -c
  ['bash - -c ', false], // but may not precede it
  ['bash - -o x -c ', false], // even with an option pair in between
  ['bash -O -x -c ', true], // `-O` read as a flag, `-x` as another
  ['bash -o x ', false], // no -c
  ['echo bash -c x ', false], // the -c belongs to bash, but `x` follows it
  ['fish -c ', false],
  ['"bash -c ', false],
  ['x=`bash -c ', true], // a backtick opens a command substitution
  ['echo "`sh -lc ', true],
  ['x`bash -c ', true],
  ['bash -c', true],
  ['', false],
]

describe('endsInShC', () => {
  it.each(ROWS)('%j -> %s', (s, want) => {
    expect(ORACLE.test(s)).toBe(want)
    expect(endsInShC(s)).toBe(want)
  })

  it('reads only the text before `end`', () => {
    const s = 'bash -c "npx supabase" tail'
    expect(endsInShC(s, s.indexOf('"'))).toBe(true)
    expect(endsInShC(s)).toBe(false)
  })

  // Shell-shaped token strings, so a good share match: the agreement count
  // below must include positives, or it says nothing about the matching side.
  it('agrees with the regex on 100,000 generated strings', () => {
    const NOISE = ['', 'echo', 'x', 'a;', '-o', '-c', 'env -i']
    const SHELL = [
      'sh',
      'bash',
      '/bin/bash',
      'x;sh',
      '(zsh',
      'a|dash',
      'csh',
      '"bash',
      'shx',
      '-x;sh',
      'bash;',
    ]
    const FLAG = [
      '-c',
      '-c',
      '-lc',
      '-ce',
      '-C',
      '-1c',
      '-csh',
      '-c;sh',
      '-o',
      '-O',
      'pipefail',
      '-',
      '--',
      '-x',
      '-!',
      'x',
      '-o-',
      '-x;bash',
      'sh',
      '"x"',
    ]
    // Newlines, CRLF and Unicode spaces too: the scan must split on exactly
    // the whitespace the regex's \s matches.
    const SEP = [' ', '  ', '\t', '\n', '\r\n', ' ', '\v', ' ']
    // Take the high bits: an LCG's low bits cycle quickly, and `seed % n`
    // never produced some token pairs (a lone `-` right before `-c`).
    let seed = 7226
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return Math.floor((seed / 0x80000000) * n)
    }
    let positives = 0
    const diffs: string[] = []
    for (let k = 0; k < 100_000; k++) {
      let s = NOISE[rnd(NOISE.length)]
      s += (s ? SEP[rnd(SEP.length)] : '') + SHELL[rnd(SHELL.length)]
      for (let j = rnd(7); j > 0; j--) s += SEP[rnd(SEP.length)] + FLAG[rnd(FLAG.length)]
      if (rnd(3) === 0) s += SEP[rnd(SEP.length)]
      const want = ORACLE.test(s)
      if (want) positives++
      if (endsInShC(s) !== want && diffs.length < 5) diffs.push(s)
    }
    expect(diffs).toEqual([])
    expect(positives).toBeGreaterThan(10_000)
  })

  // The regex took ~1.5 s on this shape at 16,000 repeats, ~2.5 s at this
  // size, and grew about 4x per doubling. It is no call: bash runs `x`, not
  // the quoted text.
  it('scans a line of 20,000 -c flags in well under 0.5 s', () => {
    const t0 = performance.now()
    const hits = scanShellText('bash ' + '-c '.repeat(20_000) + 'x "npx supabase status"')
    expect(performance.now() - t0).toBeLessThan(500)
    expect(hits).toEqual([])
  })

  // The regex was fast on this shape, because it matches; this pins that the
  // scan still finds the call, not the speed fix.
  it('still flags the call when the flags end right before the quote', () => {
    const t0 = performance.now()
    const hits = scanShellText('bash ' + '-c '.repeat(20_000) + '"npx supabase status"')
    expect(performance.now() - t0).toBeLessThan(500)
    expect(hits).toHaveLength(1)
  })

  // Hits inside one quote share its opening. Without the per-line memo the
  // scan re-walked the flag run for each: ~1.07 s at 4,000 on a host, and
  // ~6.5 s here in the dev container. With `foo` nothing runs; with `bash`
  // the same line must still be flagged, so the test can't pass by scanning
  // nothing.
  it('scans one quote holding 8,000 hits after 8,000 flags in well under 0.5 s', () => {
    const line = (sh: string) =>
      sh + ' ' + '-c '.repeat(8_000) + '"' + 'npx supabase; '.repeat(8_000) + '"'
    const t0 = performance.now()
    const hits = scanShellText(line('foo'))
    expect(performance.now() - t0).toBeLessThan(500)
    expect(hits).toEqual([])
    expect(scanShellText(line('bash'))).toHaveLength(1)
  })

  // 8,000 nested openings inside one unbroken token (`-"$(-"$(…`), each with a
  // hit. Before the per-line tables, each opening scanned back to the token's
  // start and ran a regex over it: ~1 s on a host at this size.
  it('scans 8,000 nested openings in one long token in well under 0.5 s', () => {
    const line = (sh: string) =>
      sh + ' ' + '-"$('.repeat(8_000) + '-" npx supabase ' + ' " ) npx supabase '.repeat(8_000)
    const t0 = performance.now()
    const hits = scanShellText(line('foo'))
    expect(performance.now() - t0).toBeLessThan(500)
    expect(hits).toEqual([])
    expect(scanShellText(line('bash -c'))).toHaveLength(1)
  })

  // One memo per string, shared across every `end` and visited out of order,
  // as firstCall shares it across a line's openings.
  it('agrees with the regex at every end of a string, with one shared memo', () => {
    const TOK = [
      'sh',
      'bash',
      '/bin/bash',
      'x;sh',
      '-c',
      '-lc',
      '-o',
      '-O',
      'pipefail',
      '-',
      '--',
      '-x',
      '-c;sh',
      '"',
      '"$(',
      '-"',
      '-"$(',
      'npx',
      'supabase',
      'x',
    ]
    const SEP = [' ', '  ', '\t', '', ' ']
    let seed = 4242
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return Math.floor((seed / 0x80000000) * n)
    }
    let positives = 0
    const diffs: string[] = []
    for (let k = 0; k < 3_000; k++) {
      let s = ''
      for (let j = rnd(12); j >= 0; j--) s += TOK[rnd(TOK.length)] + SEP[rnd(SEP.length)]
      const memo = new Map()
      const ends = [...Array(s.length + 1).keys()].sort(() => rnd(3) - 1)
      for (const e of ends) {
        const want = ORACLE.test(s.slice(0, e))
        if (want) positives++
        if (endsInShC(s, e, memo) !== want && diffs.length < 5) diffs.push(`${e}:${s}`)
      }
    }
    expect(diffs).toEqual([])
    expect(positives).toBeGreaterThan(200)
  })

  // A heredoc body's sticky frame has no opening (-1). The old regex call read
  // slice(0, -1), so `npx supabase sh -c x` in a body was flagged although the
  // body is text and never runs.
  it('flags sh -c inside backticks as it does inside $(…)', () => {
    expect(scanShellText("x=`bash -c 'npx supabase status'`")).toHaveLength(1)
    expect(scanShellText('echo "`sh -lc \'npx wrangler deploy\'`"')).toHaveLength(1)
    expect(scanShellText("x=$(bash -c 'npx supabase status')")).toHaveLength(1)
    expect(scanShellText("echo `bash -c 'echo ok'`")).toEqual([])
  })

  // The keyword-position check sliced from the frame start for every `case`
  // or `esac` word: ~1 s on a host at 16,000 words, 4x per doubling.
  it('lexes a line of 16,000 case words in well under 0.5 s', () => {
    for (const unit of ['case ', 'esac ']) {
      const t0 = performance.now()
      const hits = scanShellText(unit.repeat(16_000) + 'npx supabase status')
      expect(performance.now() - t0).toBeLessThan(500)
      // the trailing call is still found (the slicing version agreed: 1)
      expect(hits).toHaveLength(1)
    }
    // the same keywords still open and close a case: the call after `esac`
    // runs and is flagged
    expect(scanShellText('case x in a) ;; esac; npx supabase status')).toHaveLength(1)
  })

  // `domain` ends in `in` but is not the keyword, so this `case` is a plain
  // word and `)` closes the `$(`; the call after it is quoted text. Read as a
  // keyword, `)` would be a case pattern and the text would be flagged.
  it('needs a word boundary before a keyword', () => {
    expect(scanShellText('echo "$(echo domain case a) npx supabase status"')).toEqual([])
  })

  it('treats a negative end as no opening', () => {
    expect(endsInShC('npx supabase sh -c x', -1)).toBe(false)
    expect(ORACLE.test('npx supabase sh -c x'.slice(0, -1))).toBe(true)
    expect(scanShellText('cat <<EOF\nnpx supabase sh -c x\nEOF')).toEqual([])
    expect(scanShellText('cat <<EOF\n$(npx supabase status)\nEOF')).toHaveLength(1)
  })
})
