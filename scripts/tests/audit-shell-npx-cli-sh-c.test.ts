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
// although `$(bash -c '…')` was flagged. Since SMI-7241 a letters-only bundle
// holding o or O (`-eo`, `-euo`) takes a value, as bash reads it, with `+`
// as well as `-` (`+o posix`, `+eo posix`; review round 2). A `+` then
// letters with no o/O (`+e`, `+eu`, a lone `+`) is a flag before or after the
// -c, and a c in a `+` bundle is the -c (`bash +c '…'`), as bash 5.2 reads
// them (review round 3). Only ever run on short inputs here: the bundle
// alternative backtracks.
const ORACLE =
  /(?:^|[\s;&|(/`])(?:ba|z|da|k)?sh\s+(?:(?:[-+][A-Za-z]*[oO][A-Za-z]*\s+[^\s-]\S*|-\S+|\+[A-NP-Za-np-z]*)\s+)*[-+][A-Za-z]*c[A-Za-z]*(?:\s+(?:-\S*|\+[A-NP-Za-np-z]*))*\s*$/

// SMI-7241 F11: floors on the two generators' distinct-string counts. With
// Math.imul they produce 88,147 and 2,842; with the old float multiply 1,317
// and 147, which these floors reject.
const DISTINCT_100K_FLOOR = 80_000
const DISTINCT_3K_FLOOR = 2_500

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
  ['bash -c $', false], // a bare $ after -c is not an argument: the $'...' form is read by the word reader
  // A letters-only bundle holding o/O takes the next word as its value (SMI-7241 F3).
  ['bash -euo pipefail -c ', true],
  ['bash -eo pipefail -c ', true],
  ['bash -oe pipefail -c ', true],
  ['bash --noprofile --norc -eo pipefail -c ', true],
  ['bash -xO extglob -c ', true],
  ['bash -ex pipefail -c ', false], // no o: `pipefail` is a script operand
  ['bash -e1o pipefail -c ', false], // not letters only
  // A `+` bundle holding o/O takes a value too (review round 2, R9).
  ['bash +o posix -c ', true],
  ['bash +O extglob -c ', true],
  ['bash +eo posix -c ', true],
  ['bash +xo posix -c ', true],
  ['bash -e +o posix -c ', true],
  ['bash +o posix ', false], // no -c
  ['bash +o -c ', false], // `+o` takes `-c` as its value; bash ran nothing (measured)
  ['bash +e1o posix -c ', false], // not letters only
  // A `+` flag without o, before or after the -c, and a c in a `+` bundle
  // (review round 3, R12).
  ['bash +e -c ', true],
  ['bash -c +e ', true],
  ['bash +eu -c ', true],
  ['bash -e +x -c ', true],
  ['bash -c +eu -- ', true],
  ['bash + -c ', true], // a lone `+` is a flag, unlike a lone `-`
  ['bash -c + ', true],
  ['bash +c ', true],
  ['bash +ec ', true],
  ['bash -o posix +c ', true],
  ['bash +e ', false], // no c
  ['bash +1 -c ', false], // not letters only
  ['echo +e -c ', false],
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
      '-eo',
      '-euo',
      '-xo',
      '-oe',
      '-xO',
      '+o',
      '+O',
      '+eo',
      '+xO',
      '+e',
      '+x',
      '+eu',
      '+c',
      '+ec',
      '+',
      '+1',
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
    // Math.imul keeps the multiply exact: a plain `*` passes 2^53 and loses
    // precision, which cut the state to a 10,466-step cycle and this loop to
    // 1,317 distinct strings out of 100,000 (SMI-7241).
    let seed = 7226
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return Math.floor((seed / 0x80000000) * n)
    }
    let positives = 0
    const diffs: string[] = []
    const distinct = new Set<string>()
    for (let k = 0; k < 100_000; k++) {
      let s = NOISE[rnd(NOISE.length)]
      s += (s ? SEP[rnd(SEP.length)] : '') + SHELL[rnd(SHELL.length)]
      for (let j = rnd(7); j > 0; j--) s += SEP[rnd(SEP.length)] + FLAG[rnd(FLAG.length)]
      if (rnd(3) === 0) s += SEP[rnd(SEP.length)]
      distinct.add(s)
      const want = ORACLE.test(s)
      if (want) positives++
      if (endsInShC(s) !== want && diffs.length < 5) diffs.push(s)
    }
    expect(diffs).toEqual([])
    expect(positives).toBeGreaterThan(10_000)
    // The generator must explore, not cycle.
    expect(distinct.size).toBeGreaterThan(DISTINCT_100K_FLOOR)
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

  // The two absolute bounds above cannot kill a memo-less scan in bounded
  // time: that scan is a synchronous quadratic, so at 8,000 it runs for
  // minutes and no timeout interrupts it. A timing ratio at smaller sizes
  // flaked under load (its small input took well under a millisecond), so
  // this test counts instead: every call on one line, sharing one memo, must
  // build the per-line tables once, and must answer as a call without the memo.
  it('builds the per-line tables once for every call that shares a memo', () => {
    let builds = 0
    class CountingMap extends Map<string, unknown> {
      set(key: string, value: unknown) {
        if (key === 'tables') builds++
        return super.set(key, value)
      }
    }
    const s = 'bash -c -c "npx supabase" "a" sh -c "b" "c"'
    const ends = [...s].flatMap((ch, i) => (ch === '"' ? [i] : []))
    const memo = new CountingMap()
    const shared = ends.map((end) => endsInShC(s, end, memo))
    expect(shared).toEqual(ends.map((end) => endsInShC(s, end)))
    expect(shared).toContain(true) // the scan answers both ways on this line
    expect(shared).toContain(false)
    expect(ends.length).toBeGreaterThan(4)
    expect(builds).toBe(1)
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
      '+o',
      '+eo',
      '+e',
      '+eu',
      '+c',
      '+',
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
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return Math.floor((seed / 0x80000000) * n)
    }
    let positives = 0
    const diffs: string[] = []
    const distinct = new Set<string>()
    for (let k = 0; k < 3_000; k++) {
      let s = ''
      for (let j = rnd(12); j >= 0; j--) s += TOK[rnd(TOK.length)] + SEP[rnd(SEP.length)]
      distinct.add(s)
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
    expect(distinct.size).toBeGreaterThan(DISTINCT_3K_FLOOR)
  })

  // SMI-7241 F3: each row run under bash 5.2.15 (stub npx, no network): bash
  // ran npx for all four.
  it.each([
    ["bash -euo pipefail -c 'npx supabase status'"],
    ["bash -eo pipefail -c 'npx supabase status'"],
    ["bash --noprofile --norc -eo pipefail -c 'npx supabase status'"],
    ["bash -euo pipefail -c 'np''x supabase status'"],
  ])('flags a bundled -o before -c: %j', (row) => {
    expect(scanShellText(row)).toHaveLength(1)
  })

  // Review round 2, R9: each row run under bash 5.2.15 (`bash --noprofile
  // --norc -c`, stub npx first on PATH, no network); the count is what bash did.
  it.each([
    ["bash +o posix -c 'npx supabase status'", 1],
    ["bash +o posix -c 'np''x supabase status'", 1],
    ["bash +O extglob -c 'npx supabase status'", 1],
    ["bash +O extglob -c 'np''x supabase status'", 1],
    ["bash -e +o posix -c 'npx supabase status'", 1],
    ["bash +eo posix -c 'npx supabase status'", 1],
    ["bash +xo posix -c 'npx supabase status'", 1],
    ["bash +o posix 'npx supabase status'", 0],
    // Review round 3, R12, measured the same way.
    ["bash +e -c 'npx supabase status'", 1],
    ["bash -c +e 'npx supabase status'", 1],
    ["bash +eu -c 'npx supabase status'", 1],
    ["bash -e +x -c 'npx supabase status'", 1],
    ["bash +x -c 'np''x supabase status'", 1],
    ["bash -c +eu -- 'npx supabase status'", 1],
    ["bash +e +o posix -c 'npx supabase status'", 1],
    ["bash + -c 'npx supabase status'", 1],
    ["bash -c + 'npx supabase status'", 1],
    ["bash +c 'npx supabase status'", 1],
    ["bash +ec 'npx supabase status'", 1],
    ["bash -o posix +c 'npx supabase status'", 1],
    ["bash +c +e 'npx supabase status'", 1],
    ["bash +e 'npx supabase status'", 0],
    ["bash +x 'npx supabase status'", 0],
    ["bash + 'npx supabase status'", 0],
    ["echo +e -c 'npx supabase status'", 0],
    ["bash +1 -c 'npx supabase status'", 0],
    ["bash +o -c 'npx supabase status'", 0],
  ] as Array<[string, number]>)(
    'reads a + bundle before -c as bash does: %j -> %i',
    (row, want) => {
      expect(scanShellText(row)).toHaveLength(want)
    }
  )

  it('flags sh -c inside backticks as it does inside $(…)', () => {
    expect(scanShellText("x=`bash -c 'npx supabase status'`")).toHaveLength(1)
    expect(scanShellText('echo "`sh -lc \'npx wrangler deploy\'`"')).toHaveLength(1)
    expect(scanShellText("x=$(bash -c 'npx supabase status')")).toHaveLength(1)
    expect(scanShellText("echo `bash -c 'echo ok'`")).toEqual([])
  })

  // Accepted over-approximations (owner decision, PR #3257): the boundary
  // ignores backslashes and does not tell an opening backtick from a closing
  // one, so these lines are flagged although bash runs no npx. Flagging is the
  // safe side. An escaped `\$(` or `\;` was already flagged the same way.
  it('flags escaped and closing backticks before sh -c (accepted)', () => {
    expect(scanShellText("echo \\`bash -c 'npx supabase status'\\`")).toHaveLength(1)
    expect(scanShellText("echo \\$(bash -c 'npx supabase status')")).toHaveLength(1)
    expect(scanShellText("`echo hi`bash -c 'npx supabase status'")).toHaveLength(1)
    expect(scanShellText("$(echo hi)bash -c 'npx supabase status'")).toEqual([])
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

  // A heredoc body's sticky frame has no opening (-1). The old regex call read
  // slice(0, -1), so `npx supabase sh -c x` in a body was flagged although the
  // body is text and never runs.
  it('treats a negative end as no opening', () => {
    expect(endsInShC('npx supabase sh -c x', -1)).toBe(false)
    expect(ORACLE.test('npx supabase sh -c x'.slice(0, -1))).toBe(true)
    expect(scanShellText('cat <<EOF\nnpx supabase sh -c x\nEOF')).toEqual([])
    expect(scanShellText('cat <<EOF\n$(npx supabase status)\nEOF')).toHaveLength(1)
  })
})
