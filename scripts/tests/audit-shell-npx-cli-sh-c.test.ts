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

// The shipped regex as of the CodeQL fix (cabaa428d). Only ever run on short
// inputs here.
const ORACLE =
  /(?:^|[\s;&|(/])(?:ba|z|da|k)?sh\s+(?:(?:-[oO]\s+[^\s-]\S*|-\S+)\s+)*-[A-Za-z]*c[A-Za-z]*(?:\s+-\S*)*\s*$/

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
    const SEP = [' ', '  ', '\t']
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
      s += (s ? SEP[rnd(3)] : '') + SHELL[rnd(SHELL.length)]
      for (let j = rnd(7); j > 0; j--) s += SEP[rnd(3)] + FLAG[rnd(FLAG.length)]
      if (rnd(3) === 0) s += SEP[rnd(3)]
      const want = ORACLE.test(s)
      if (want) positives++
      if (endsInShC(s) !== want && diffs.length < 5) diffs.push(s)
    }
    expect(diffs).toEqual([])
    expect(positives).toBeGreaterThan(10_000)
  })

  // The regex took ~1.5 s on this shape at 16,000 repeats and grew 4x per
  // doubling (~2.3 s here). It is no call: bash runs `x`, not the quoted text.
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
})
