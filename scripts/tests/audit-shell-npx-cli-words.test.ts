/**
 * Tests for the SMI-7241 word reader, ANSI-C decoder and fed-heredoc scan
 * (Addendum B of the SMI-7223 plan). Every row of the prototype's case table
 * was run under bash 5.2 with a stub npx first on PATH; the expected count is
 * what bash did (1 when it ran an unpinned supabase/wrangler, else 0), except
 * the rows named in the "accepted"/"known miss" blocks of the helpers test.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { scanShellText } from '../audit-shell-npx-cli-helpers.mjs'
// @ts-expect-error - .mjs helper has no typings
import { lexLine, decodeAnsiC, ARITH } from '../audit-shell-npx-cli-lexer.mjs'

type Hit = { line: number; tool: string; text: string }
const scan = (text: string): Hit[] => scanShellText(text)

const JOINED_WORD_ROWS: Array<[string, number]> = [
  ["bash -c 'np''x supabase status'", 1],
  ['bash -c "np"\'x supabase status\'', 1],
  ["bash -c np'x supabase status'", 1],
  ["bash -c 'n'px\\ supabase\\ status", 1],
  ['bash -c "$(echo)"\'npx supabase status\'', 1],
  ["bash -c ${x}$'npx supabase status'", 1],
  ["bash -c $'\\x6e''px supabase status'", 1],
  ["bash -c $'\\x6epx supabase status'", 1],
  ["bash -c $'echo hi\\nnpx supabase status'", 1],
  ["x=$(bash -c 'np''x supabase status')", 1],
  ['x=$(bash -c "np"\'x supabase status\')', 1],
  ["x=$(bash -c np'x supabase status')", 1],
  ["x=$(bash -c 'n'px\\ supabase\\ status)", 1],
  ['x=$(bash -c "$(echo)"\'npx supabase status\')', 1],
  ["x=$(bash -c ${x}$'npx supabase status')", 1],
  ["x=$(bash -c $'\\x6e''px supabase status')", 1],
  ["x=$(bash -c $'\\x6epx supabase status')", 1],
  ["x=$(bash -c $'echo hi\\nnpx supabase status')", 1],
  ["x=`bash -c 'np''x supabase status'`", 1],
  ['x=`bash -c "np"\'x supabase status\'`', 1],
  ["x=`bash -c np'x supabase status'`", 1],
  ["x=`bash -c 'n'px\\ supabase\\ status`", 1],
  ['x=`bash -c "$(echo)"\'npx supabase status\'`', 1],
  ["x=`bash -c ${x}$'npx supabase status'`", 1],
  ["x=`bash -c $'\\x6e''px supabase status'`", 1],
  ["x=`bash -c $'\\x6epx supabase status'`", 1],
  ["x=`bash -c $'echo hi\\nnpx supabase status'`", 1],
  ["$'\\x6epx' supabase status", 1],
  ["$'\\x6e'px supabase status", 1],
  ["'np'x supabase status", 1],
  ["echo $'x; npx supabase status'", 0],
]

const HEREDOC_ROWS: Array<[string, number]> = [
  ['bash <<EOF\nnpx supabase status\nEOF', 1],
  ["bash <<'EOF'\nnpx supabase status\nEOF", 1],
  ['bash <<"EOF"\nnpx supabase status\nEOF', 1],
  ['bash <<\\EOF\nnpx supabase status\nEOF', 1],
  ['sh <<EOF\nnpx supabase status\nEOF', 1],
  ['dash <<EOF\nnpx supabase status\nEOF', 1],
  ['/bin/bash <<EOF\nnpx supabase status\nEOF', 1],
  ['bash -s <<EOF\nnpx supabase status\nEOF', 1],
  ['bash -s arg1 arg2 <<EOF\nnpx supabase status\nEOF', 1],
  ['bash -x <<EOF\nnpx supabase status\nEOF', 1],
  ['bash -o pipefail <<EOF\nnpx supabase status\nEOF', 1],
  ['bash -e -u <<EOF\nnpx supabase status\nEOF', 1],
  ['bash - <<EOF\nnpx supabase status\nEOF', 1],
  ['bash -- <<EOF\nnpx supabase status\nEOF', 1],
  ['sudo bash <<EOF\nnpx supabase status\nEOF', 1],
  ['sudo -E bash -s <<EOF\nnpx supabase status\nEOF', 1],
  ['env X=1 bash <<EOF\nnpx supabase status\nEOF', 1],
  ['exec bash <<EOF\nnpx supabase status\nEOF', 1],
  ['X=1 bash <<EOF\nnpx supabase status\nEOF', 1],
  ['<<EOF bash\nnpx supabase status\nEOF', 1],
  ['bash <<-EOF\n\tnpx supabase status\n\tEOF', 1],
  ['cat <<EOF | bash\nnpx supabase status\nEOF', 1],
  ["cat <<'EOF' | sudo bash -s\nnpx supabase status\nEOF", 1],
  ['cat <<EOF | sh -s -- a\nnpx supabase status\nEOF', 1],
  ['cat <<EOF | cat | bash\nnpx supabase status\nEOF', 1],
  ['cat <<EOF\nnpx supabase status\nEOF', 0],
  ['bash -c x <<EOF\nnpx supabase status\nEOF', 0],
  ['tee f <<EOF\nnpx supabase status\nEOF', 0],
  ['bash script.sh <<EOF\nnpx supabase status\nEOF', 0],
  ["bash -c 'cat' <<EOF\nnpx supabase status\nEOF", 0],
  ['cat <<EOF | tee f\nnpx supabase status\nEOF', 0],
  ['cat <<EOF | bash -c cat\nnpx supabase status\nEOF', 0],
  ['echo bash <<EOF\nnpx supabase status\nEOF', 0],
  ['bash <<EOF\ncat <<X\nnpx supabase status\nX\nEOF', 0],
  ["bash <<EOF\nbash -c 'np''x supabase status'\nEOF", 1],
  ['bash <<EOF\nnpx supabase@2.111.0 status\nEOF', 0],
  ['bash <<EOF\n# npx supabase status\necho ok\nEOF', 0],
  ['x=$(bash <<EOF\nnpx supabase status\nEOF\n)', 1],
  ['bash <<EOF; echo after\nnpx supabase status\nEOF', 1],
  ['bash <<EOF && echo ok\nnpx wrangler deploy\nEOF', 1],
  ['bash <<-EOF\n\tcat <<X\n\tX\n\tnpx supabase status\n\tEOF', 1],
]

const NOT_FED_ROWS: Array<[string, number]> = [
  ["bash -sc 'cat' <<EOF\nnpx supabase status\nEOF", 0],
  ['bash -c <<EOF\nnpx supabase status\nEOF', 0],
]

const LINE_ROWS: Array<[string, number[]]> = [
  ['echo a\nbash <<EOF\necho hi\nnpx supabase status\nEOF\nnpx wrangler deploy', [4, 6]],
  ["echo a\nbash -c 'np'\\\n'x supabase status'", [2]],
  ['cat <<EOF | bash\necho\n\nnpx supabase status\nEOF', [4]],
  ['bash <<-EOF\n\techo\n\tnpx \\\n\t  supabase status\n\tEOF', [3]],
  ['bash <<EOF\nnpx supabase status', [2]],
]

// Review fixes on 9945f1fe4 (SMI-7241). Every row was run under bash 5.2.15
// (`bash --noprofile --norc -c`, stub npx, no network); the count is what
// bash did. `sudo` rows used a stub sudo that drops its options and execs the
// rest.
const FIX3_ROWS: Array<[string, string, number]> = [
  // F1: an unquoted delimiter lets the outer shell expand the body first, so
  // a substitution runs even inside '…', a # comment or a nested quoted heredoc.
  ['F1', "bash <<EOF\necho '$(npx supabase status)'\nEOF", 1],
  ['F1', "bash <<EOF\necho '`npx supabase status`'\nEOF", 1],
  ['F1', 'bash <<EOF\n# v: $(npx supabase --version)\nEOF', 1],
  ['F1', "bash <<EOF\ncat <<'INNER'\n$(npx supabase status)\nINNER\nEOF", 1],
  ['F1', "bash <<'EOF'\necho '$(npx supabase status)'\nEOF", 0],
  // F2: every o/O in a flag bundle takes the next word as its value.
  ['F2', "bash -euo pipefail <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F2', "bash -eo pipefail <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F2', "bash -oe pipefail <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F2', "bash -oeu pipefail <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F2', "bash -oo pipefail nounset <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F2', "bash -eoO pipefail extglob <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F2', "bash -xeo pipefail -s <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F2', "cat <<'EOF' | bash -euo pipefail\nnpx supabase status\nEOF", 1],
  ['F2', "sudo bash -euo pipefail <<'EOF'\nnpx supabase status\nEOF", 1],
  // F5: ( and ) end a simple command; /dev/stdin is stdin.
  ['F5', "case x in x) bash <<'EOF' ;; esac\nnpx supabase status\nEOF", 1],
  ['F5', "f() { bash <<'EOF'\nnpx supabase status\nEOF\n}; f", 1],
  ['F5', "bash /dev/stdin <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F5', "bash /proc/self/fd/0 <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F5', "source /dev/stdin <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F5', ". /dev/stdin <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F5', "bash -- /dev/stdin <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F5', "bash - /dev/stdin <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F5', "source -- /dev/stdin <<'EOF'\nnpx supabase status\nEOF", 1],
  ['F5', "bash -- /dev/null <<'EOF'\nnpx supabase status\nEOF", 0],
  ['F5', "source /dev/null <<'EOF'\nnpx supabase status\nEOF", 0],
  ['F5', 'x=bash; case $x in bash) cat <<EOF;; esac\nnpx supabase status\nEOF', 0],
  ['F5', 'bash /dev/null <<EOF\nnpx supabase status\nEOF', 0],
  ['F5', 'cat <<EOF | (bash)\nnpx supabase status\nEOF', 1],
  // F8: a digits-only word against the operator is its fd; only fd 0 is stdin.
  ['F8', 'bash 0<<EOF\nnpx supabase status\nEOF', 1],
  ['F8', 'bash 3<<EOF\nnpx supabase status\nEOF', 0],
]

const TOOL_ROWS: Array<[string, string]> = [
  ["npx wrangler deploy; bash -c 'np''x supabase status'", 'wrangler'],
  ["bash -c 'np''x wrangler deploy'; 'np'x supabase status", 'wrangler'],
  ["'np'x wrangler deploy; bash -c 'np''x supabase status'", 'supabase'],
]

describe('word rebuilding and fed heredocs agree with bash', () => {
  describe('joined-word rows', () => {
    it.each(JOINED_WORD_ROWS)('%j -> %i hit(s)', (row, want) => {
      const hits = scan(row)
      expect(hits).toHaveLength(want)
      for (const h of hits) expect(h.tool).toBe('supabase')
    })
  })

  describe('heredoc rows', () => {
    it.each(HEREDOC_ROWS)('%j -> %i hit(s)', (row, want) => {
      const hits = scan(row)
      expect(hits).toHaveLength(want)
      for (const h of hits) expect(['supabase', 'wrangler']).toContain(h.tool)
    })
  })

  // The `-c` rule is observable only with `-s` or no command string: with
  // `-c cat` the shell runs `cat`, so the heredoc is cat's input, not a script.
  describe('heredocs not fed to a shell', () => {
    it.each(NOT_FED_ROWS)('%j -> %i hit(s)', (row, want) => {
      expect(scan(row)).toHaveLength(want)
    })
  })

  it.each(LINE_ROWS)('reports hits at physical lines: %j', (row, want) => {
    expect(scan(row).map((h) => h.line)).toEqual(want)
  })

  // The first pass to find a call wins, so the reported tool is that pass's.
  describe('review fixes on 9945f1fe4', () => {
    it.each(FIX3_ROWS)('%s %j -> %i hit(s)', (_fix, row, want) => {
      const hits = scan(row)
      expect(hits).toHaveLength(want)
      for (const h of hits) expect(h.tool).toBe('supabase')
    })
  })

  // F1: a hit in an expanding fed body is reported at its physical line, once.
  it.each([
    ["echo a\nbash <<EOF\necho '$(npx supabase status)'\nnpx supabase status\nEOF", [3, 4]],
    ['bash <<EOF\nnpx supabase status $(npx supabase --version)\nEOF', [2]],
  ] as Array<[string, number[]]>)('reports F1 hits at physical lines: %j', (row, want) => {
    expect(scan(row).map((h) => h.line)).toEqual(want)
  })

  it.each(TOOL_ROWS)("reports the first pass's tool: %j", (row, want) => {
    expect(scan(row).map((h) => h.tool)).toEqual([want])
  })
})

describe('lexLine contexts (SMI-7241 B.3 step 1)', () => {
  // The quote after the $ must carry the outer (command) context. Pass 3 of
  // scanShellText would mask a missing mark, so this is asserted directly.
  it.each([
    ["$'npx' supabase status", "$'"],
    ['$"npx" supabase status', '"'],
  ])('the quote of %j reads as command context', (line, inner) => {
    const { at } = lexLine(line)
    const i = line.indexOf('$')
    expect(at[i + 1].q).toBeNull()
    // and the body is inside the quote
    expect(at[i + 2].q).toBe(inner)
  })

  it('reads the end of a $(( )) frame: the frame closes after both parens', () => {
    const line = 'x=$((1+2))y npx'
    const { frames } = lexLine(line)
    expect(frames.kind[2]).toBe(ARITH)
    expect(frames.close[2]).toBe(line.indexOf('))'))
    expect(frames.end[2]).toBe(line.indexOf('))') + 2)
  })

  it('reads the end of a bare (( )) frame', () => {
    const line = '((a))b'
    const { frames } = lexLine(line)
    expect(frames.kind[0]).toBe(ARITH)
    expect(frames.end[0]).toBe(5)
  })
})

describe("decodeAnsiC matches bash printf %s $'…' (SMI-7241 B.2)", () => {
  // Expected bytes are bash 5.2's own output (LC_ALL=C.UTF-8), as hex. All 25
  // were re-measured on 2026-11-19 with `printf '%s' $'<body>' | od -An -tx1`
  // under bash 5.2.15 (no network): every row agreed.
  const DECODE_ROWS: Array<[string, string]> = [
    ['\\u006epx supabase status', '6e707820737570616261736520737461747573'],
    ['\\u6epx supabase', '6e7078207375706162617365'],
    ['\\cJnpx supabase', '0a6e7078207375706162617365'],
    ['\\cjx', '0a78'],
    ['\\x6epx supabase status', '6e707820737570616261736520737461747573'],
    ['\\156px supabase status', '6e707820737570616261736520737461747573'],
    ['\\556px supabase status', '6e707820737570616261736520737461747573'],
    ['npx supabase status', '6e707820737570616261736520737461747573'],
    ['\\U0000006epx supabase status', '6e707820737570616261736520737461747573'],
    ['echo hi\\nnpx supabase status', '6563686f2068690a6e707820737570616261736520737461747573'],
    ['echo hi;\\tnpx supabase status', '6563686f2068693b096e707820737570616261736520737461747573'],
    ['\\\\x6epx supabase status', '5c783665707820737570616261736520737461747573'],
    ['\\x6Epx supabase', '6e7078207375706162617365'],
    ['\\x6g', '0667'],
    ['\\x', '5c78'],
    ['\\q\\d\\z', '5c715c645c7a'],
    ['a\\0b', '61'],
    ['a\\x00b', '61'],
    ['\\cA\\c?x', '017f78'],
    ['it\\\'s \\"q\\" \\? \\a\\b\\e\\E\\f\\r\\v', '6974277320227122203f2007081b1b0c0d0b'],
    ['\\1234', '5334'],
    ['\\x6e\\x70\\x78 supabase', '6e7078207375706162617365'],
    ['trailing\\\\', '747261696c696e675c'],
    ['\\u', '5c75'],
    ['echo\\0; npx supabase status', '6563686f'],
  ]

  it.each(DECODE_ROWS)('%j -> %s', (body, hex) => {
    expect(Buffer.from(decodeAnsiC(body), 'utf8').toString('hex')).toBe(hex)
  })

  // \U110000 is outside Unicode: bash emits four non-ASCII bytes (f4908080)
  // and the decoder emits U+FFFD. Neither side is ASCII, so neither can form a
  // call; the claim is agreement on every output that can be ASCII. Not tabled.
  it('is linear: 200,000 escapes decode without a quadratic blow-up', () => {
    expect(decodeAnsiC('\\x41'.repeat(200_000))).toBe('A'.repeat(200_000))
  })
})

// Timing: each input is scanned once untimed (warm-up), then timed 5 times
// at n and at 4n; the ratio of the fastest runs must stay under 8 (linear is
// about 4, quadratic about 16). Noise (GC, JIT) only adds time, so the
// minimum is the stable estimate; a median of 3 without warm-up flaked on
// unmodified code (ratios 8.65 and 9.36 in 5 runs, SMI-7241). No wall-clock
// bound, so a slow CI runner does not flake. `hits` pins that the scanner
// reached the code under test rather than bailing out early.
const nestedSubst = (n: number) => '$('.repeat(n) + 'echo' + ')'.repeat(n)
const nestedShC = (n: number) => '$(bash -c '.repeat(n) + "'np''x supabase status'" + ')'.repeat(n)
const nestedBrace = (n: number) => 'echo ' + '${'.repeat(n) + 'x' + '}'.repeat(n)
// `bash <<E1` … `bash <<En`, the innermost body a call, then En … E1.
function nestedFed(n: number): string {
  const open = Array.from({ length: n }, (_, k) => `bash <<E${k + 1}`)
  const close = Array.from({ length: n }, (_, k) => `E${n - k}`)
  return [...open, 'npx supabase status', ...close].join('\n')
}
function nestedQuotes(depth: number): string {
  // Each level of "…" nesting doubles the backslashes, so depth is log(size).
  let s = "np''x supabase status"
  for (let d = 0; d < depth; d++) s = 'bash -c "' + s.replace(/[\\"$`]/g, '\\$&') + '"'
  return s
}
// Each input ends with a separate line holding one call, so `hits` is a
// presence assertion: an early bail-out returns one hit fewer. The line is
// separate so the earlier line still exercises every pass.
const CALL = '\nnpx supabase status'
const STRESS: Array<[string, (n: number) => string, number, number]> = [
  ['nested $( … ) echo', nestedSubst, 5_000, 0],
  ['nested $(bash -c …) with a call', nestedShC, 2_000, 1],
  ['nested ${ … }', nestedBrace, 40_000, 0],
  ["quoted words 'a'", (n) => "'a' ".repeat(n), 20_000, 0],
  ["quoted words $'\\x6e'", (n) => "$'\\x6e' ".repeat(n), 20_000, 0],
  ["long joined word 'n''n'…", (n) => "'n'".repeat(n) + ' supabase', 20_000, 0],
  ['bash -c + long joined word', (n) => 'bash -c ' + "'n'".repeat(n), 20_000, 0],
  [
    'many -c words, then a joined word',
    (n) => 'bash ' + '-c '.repeat(n) + "'np''x supabase status'",
    20_000,
    1,
  ],
  ['heredoc pipeline stages', (n) => 'cat <<a | '.repeat(n) + 'bash', 5_000, 0],
  [
    'fed heredoc body lines',
    (n) => 'bash <<EOF\n' + "echo 'np''x' a\n".repeat(n) + 'EOF',
    20_000,
    0,
  ],
  [
    'expanding heredoc body $( ) lines',
    (n) => 'cat <<EOF\n' + "$(echo 'a''b')\n".repeat(n) + 'EOF',
    20_000,
    0,
  ],
  ["$'…' with escapes", (n) => "bash -c $'" + '\\x41'.repeat(n) + "'", 50_000, 0],
  // F4: nested fed heredocs, each level's body holding the next.
  ['nested fed heredocs', (n) => nestedFed(n), 200, 1],
]

function fastestOf5(text: string): { ms: number; hits: number } {
  let hits = scan(text).length // warm-up, untimed
  let best = Infinity
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now()
    hits = scan(text).length
    best = Math.min(best, performance.now() - t0)
  }
  return { ms: best, hits }
}

describe('scaling of the word reader (SMI-7241)', () => {
  it.each(STRESS)('%s: 4n costs under 8x n', (_name, make, n, wantHits) => {
    const small = fastestOf5(make(n) + CALL)
    const large = fastestOf5(make(4 * n) + CALL)
    expect(small.hits).toBe(wantHits + 1)
    expect(large.hits).toBe(wantHits + 1)
    expect(large.ms / small.ms).toBeLessThan(8)
  })

  // F4: fed-heredoc recursion had no depth cap, so deep nesting threw a
  // RangeError out of scanShellText and crashed audit:standards.
  it('does not throw on 3,000 nested terminated fed heredocs', () => {
    let hits: Hit[] = []
    expect(() => (hits = scan(nestedFed(3_000)))).not.toThrow()
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it('does not throw on 4,000 unterminated fed heredocs', () => {
    const text = 'bash <<EOF\n'.repeat(4_000) + 'npx supabase status'
    let hits: Hit[] = []
    expect(() => (hits = scan(text))).not.toThrow()
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it.each([4, 8, 12])('nested "…" sh -c of depth %i is still found', (depth) => {
    expect(scan(nestedQuotes(depth))).toHaveLength(1)
  })
})
