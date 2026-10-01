/**
 * `scripts/lib/shell-command-launchers.mjs` and the launcher-aware half of
 * `scripts/lib/shell-command-readings.mjs` (SMI-6903 round 22 F1).
 *
 * The launcher table moved here from the ruflo guard's own wrappers module
 * so the env guard's transparent-head reading can consume a launcher's own
 * flags and positionals before peeling on. Every arm below fails on
 * `827a0b910` (the table was not reachable from the readings module there);
 * the mutation that kills each is named beside it. End-to-end `decide()` arms
 * live in `env-read-guard.test.ts` ("round 22 F1").
 */

import { describe, expect, it } from 'vitest'

import {
  LAUNCHER_TABLE,
  launcherDashCCommand,
  peelOneLauncher,
  stripLauncher,
} from '../lib/shell-command-launchers.mjs'
import { normalizeWrappers } from '../lib/shell-command-normalize.mjs'
import {
  stripTransparentHeadWords,
  transparentHeadReadings,
} from '../lib/shell-command-readings.mjs'
import { tokenize } from '../lib/shell-command-tokenize.mjs'
import { splitCommandSegments } from '../lib/shell-command-segments.mjs'

const entry = (name: string) => {
  const e = LAUNCHER_TABLE.get(name)
  if (e === undefined) throw new Error(`no launcher row for ${name}`)
  return e
}

describe('LAUNCHER_TABLE — the shared launcher rows', () => {
  // Every launcher measured printing a decoy file in at least one of the three
  // shells has a row (killed by deleting any row).
  it.each([
    'timeout',
    'nice',
    'nohup',
    'setsid',
    'stdbuf',
    'ionice',
    'caffeinate',
    'taskset',
    'flock',
    'chroot',
    'script',
    'exec',
    'command',
    'builtin',
    'xargs',
    'time',
    'arch',
    'xcrun',
  ])('has a row for %s', (name) => {
    expect(LAUNCHER_TABLE.has(name)).toBe(true)
  })

  it('every row carries a positional count, a value-flag set and a stop-flag set', () => {
    for (const [name, row] of LAUNCHER_TABLE) {
      expect(typeof row.positionals, name).toBe('number')
      expect(row.valueFlags, name).toBeInstanceOf(Set)
      expect(row.stopFlags, name).toBeInstanceOf(Set)
    }
    expect(entry('command').stopFlags.has('-v')).toBe(true)
  })

  // The arity model each measured shape depends on (killed by changing the
  // named row's positionals or value flags).
  it.each<[string, string[], string[]]>([
    ['timeout', ['5', 'cat', '.env'], ['cat', '.env']],
    ['timeout', ['--foreground', '-k', '2', '5', 'cat', '.env'], ['cat', '.env']],
    ['timeout', ['-s', 'TERM', '5', 'cat', '.env'], ['cat', '.env']],
    ['nice', ['cat', '.env'], ['cat', '.env']],
    ['nice', ['-n', '5', 'cat', '.env'], ['cat', '.env']],
    ['nice', ['-n5', 'cat', '.env'], ['cat', '.env']],
    ['nice', ['-5', 'cat', '.env'], ['cat', '.env']],
    ['nice', ['--adjustment=5', 'cat', '.env'], ['cat', '.env']],
    ['nice', ['--adjustment', '5', 'cat', '.env'], ['cat', '.env']],
    ['stdbuf', ['-oL', 'cat', '.env'], ['cat', '.env']],
    ['stdbuf', ['-o', 'L', 'cat', '.env'], ['cat', '.env']],
    ['ionice', ['-c3', '-n7', 'cat', '.env'], ['cat', '.env']],
    ['ionice', ['-c', '3', 'cat', '.env'], ['cat', '.env']],
    ['caffeinate', ['-t', '5', 'cat', '.env'], ['cat', '.env']],
    ['caffeinate', ['-i', 'cat', '.env'], ['cat', '.env']],
    ['taskset', ['-c', '0', 'cat', '.env'], ['cat', '.env']],
    ['taskset', ['1', 'cat', '.env'], ['cat', '.env']],
    ['flock', ['-n', '/tmp/l', 'cat', '.env'], ['cat', '.env']],
    ['flock', ['-w', '5', '/tmp/l', 'cat', '.env'], ['cat', '.env']],
    ['chroot', ['/', 'cat', '.env'], ['cat', '.env']],
    ['chroot', ['--userspec', 'u:g', '/', 'cat', '.env'], ['cat', '.env']],
    ['script', ['-q', '/dev/null', 'cat', '.env'], ['cat', '.env']],
    ['exec', ['-a', 'x', 'cat', '.env'], ['cat', '.env']],
    ['command', ['-p', 'cat', '.env'], ['cat', '.env']],
    ['xargs', ['-I', '{}', 'cat', '{}'], ['cat', '{}']],
    // Round 23: the full synopsis, separated long forms included.
    ['script', ['-q', '-t', '1', '/dev/null', 'cat', '.env'], ['cat', '.env']],
    ['script', ['-F', '/tmp/p', '/dev/null', 'cat', '.env'], ['cat', '.env']],
    ['stdbuf', ['--output', 'L', 'cat', '.env'], ['cat', '.env']],
    ['stdbuf', ['--error', 'L', '--input', '0', 'cat', '.env'], ['cat', '.env']],
    ['ionice', ['--class', '3', 'cat', '.env'], ['cat', '.env']],
    ['ionice', ['--classdata', '7', 'cat', '.env'], ['cat', '.env']],
    ['ionice', ['-c', '2', '--classdata', '7', 'cat', '.env'], ['cat', '.env']],
    ['flock', ['--wait', '5', '/tmp/l', 'cat', '.env'], ['cat', '.env']],
    ['flock', ['--timeout', '5', '/tmp/l', 'cat', '.env'], ['cat', '.env']],
    ['chrt', ['-d', '-T', '1000', '-P', '2000', '-D', '3000', '0', 'cat', '.env'], ['cat', '.env']],
    ['chrt', ['--sched-runtime', '1000', '0', 'cat', '.env'], ['cat', '.env']],
    ['xargs', ['--max-args', '1', 'cat'], ['cat']],
    ['doas', ['-a', 'style', 'cat', '.env'], ['cat', '.env']],
    // SMI-6908 F-3 and F-4: BSD time's `-o FILE`, and the two macOS launchers.
    ['time', ['-o', '/tmp/t', 'cat', '.env'], ['cat', '.env']],
    ['time', ['-p', '-o', '/tmp/t', 'cat', '.env'], ['cat', '.env']],
    ['time', ['-f', '%e', 'cat', '.env'], ['cat', '.env']],
    ['arch', ['-arm64', 'cat', '.env'], ['cat', '.env']],
    ['arch', ['-arch', 'arm64', 'cat', '.env'], ['cat', '.env']],
    ['xcrun', ['cat', '.env'], ['cat', '.env']],
    ['xcrun', ['--sdk', 'macosx', 'cat', '.env'], ['cat', '.env']],
    ['xcrun', ['--toolchain', 'default', 'cat', '.env'], ['cat', '.env']],
    // SMI-6908 round 27 F-17: xcrun's own spelling is single-dash (each row
    // measured printing a decoy in bash 3.2 and zsh 5.9; the first three
    // left `macosx`/`default` as argv[0] on 4552e41a7).
    ['xcrun', ['-sdk', 'macosx', 'cat', '.env'], ['cat', '.env']],
    ['xcrun', ['-toolchain', 'default', 'cat', '.env'], ['cat', '.env']],
    ['xcrun', ['-sdk', 'macosx', '-toolchain', 'default', 'cat', '.env'], ['cat', '.env']],
    ['xcrun', ['-sdk', 'macosx', '--', 'cat', '.env'], ['cat', '.env']],
    ['xcrun', ['-sdk', 'macosx', '-log', 'cat', '.env'], ['cat', '.env']],
    ['xcrun', ['-log', 'cat', '.env'], ['cat', '.env']],
    ['xargs', ['-a', 'list', '--delimiter', ',', 'cat'], ['cat']],
    // `--` ends the launcher's own options.
    ['nice', ['--', 'cat', '.env'], ['cat', '.env']],
    // Nothing after the launcher's own operands: nothing is left.
    ['timeout', ['5'], []],
    ['nice', ['-n', '5'], []],
  ])('stripLauncher(%s, %j) -> %j', (name, argv, expected) => {
    expect(stripLauncher(argv, entry(name))).toEqual(expected)
  })

  it('peelOneLauncher matches the head by basename and returns null otherwise', () => {
    expect(peelOneLauncher(['/usr/bin/timeout', '5', 'cat', '.env'])).toEqual(['cat', '.env'])
    expect(peelOneLauncher(['cat', '.env'])).toBeNull()
    expect(peelOneLauncher([])).toBeNull()
  })
})

describe('stripTransparentHeadWords — launchers and transparent words, iteratively', () => {
  it.each<[string[], string[]]>([
    [
      ['timeout', '5', 'cat', '.env'],
      ['cat', '.env'],
    ],
    [
      ['then', 'timeout', '5', 'cat', '.env'],
      ['cat', '.env'],
    ],
    [
      ['timeout', '5', 'nice', '-n', '5', 'cat', '.env'],
      ['cat', '.env'],
    ],
    [
      ['nohup', 'nice', '-n', '5', 'cat', '.env'],
      ['cat', '.env'],
    ],
    [
      ['exec', '-a', 'x', 'cat', '.env'],
      ['cat', '.env'],
    ],
    [
      ['do', 'cat', '.env'],
      ['cat', '.env'],
    ],
  ])('%j -> %j', (argv, expected) => {
    expect(stripTransparentHeadWords(argv)).toEqual(expected)
  })

  it('returns the same array identity when nothing is peeled', () => {
    const untouched = ['cat', '.env']
    expect(stripTransparentHeadWords(untouched)).toBe(untouched)
  })
})

const readingWords = (command: string, peel: typeof normalizeWrappers | null = null) =>
  transparentHeadReadings(splitCommandSegments(tokenize(command)), peel, splitCommandSegments).map(
    (r) => r.map((t) => (t.redirect === true ? `<${t.value}>` : t.value))
  )

describe('transparentHeadReadings — a launcher head, with and without a wrapper peel', () => {
  it('consumes a launcher with its flags and positionals (killed by dropping the table branch)', () => {
    expect(readingWords('timeout --foreground -k 2 5 cat .env')).toEqual([['cat', '.env']])
    expect(readingWords('nice -n 5 cat .env')).toEqual([['cat', '.env']])
  })

  it('keeps redirect words passed over, in order, in front of the remainder', () => {
    // `<` and its target are redirect-marked words; the reading must still
    // carry them so `inputRedirectSources` sees the source.
    expect(readingWords('timeout 5 cat < .env')).toEqual([['cat', '<<>', '<.env>']])
    expect(readingWords('timeout < .env 5 cat')).toEqual([['<<>', '<.env>', 'cat']])
  })

  it('reads through a wrapper only when the caller passes its peel (killed by ignoring the argument)', () => {
    expect(readingWords('sudo timeout 5 cat .env')).toEqual([])
    expect(readingWords('sudo timeout 5 cat .env', normalizeWrappers)).toEqual([['cat', '.env']])
    expect(readingWords('docker exec c timeout 5 cat /app/.env', normalizeWrappers)).toEqual([
      ['cat', '/app/.env'],
    ])
    expect(readingWords('X=1 timeout 5 cat .env', normalizeWrappers)).toEqual([['cat', '.env']])
  })

  it('stops at a nested shell body and KEEPS the reading reached so far', () => {
    // Nothing peeled before the body: no reading (the primary one recurses it).
    expect(readingWords("bash -c 'cat .env'", normalizeWrappers)).toEqual([])
    // A launcher peeled before the body: the reading is the wrapper command,
    // which the caller's own wrapper arm pairs with any kept redirect words
    // (`timeout 5 bash -c cat < .env` leaked while this returned nothing).
    expect(readingWords("timeout 5 bash -c 'cat .env'", normalizeWrappers)).toEqual([
      ['bash', '-c', 'cat .env'],
    ])
    // The redirect words sit after the body here, so they stay in place.
    expect(readingWords('timeout 5 bash -c cat < .env', normalizeWrappers)).toEqual([
      ['bash', '-c', 'cat', '<<>', '<.env>'],
    ])
  })

  it('does not peel a launcher whose own flags say it runs nothing', () => {
    // `command -v NAME` describes NAME; peeling through it left `flock` as a
    // launcher with no command, and the ruflo guard denied a real repository
    // line (`… && command -v flock >/dev/null 2>&1; then`). Measured, round 22.
    expect(readingWords('command -v flock')).toEqual([])
    expect(readingWords('command -V cat')).toEqual([])
    expect(readingWords('timeout --version cat .env')).toEqual([])
    expect(stripTransparentHeadWords(['command', '-v', 'flock'])).toEqual([
      'command',
      '-v',
      'flock',
    ])
    expect(peelOneLauncher(['command', '-v', 'flock'])).toBeNull()
    expect(peelOneLauncher(['nice', '--help', 'cat', '.env'])).toBeNull()
    // Round 23: a short-flag cluster carrying the stop flag stops too
    // (`command -pv cat` prints cat's path and runs nothing, measured).
    expect(peelOneLauncher(['command', '-pv', 'cat', '.env'])).toBeNull()
    expect(readingWords('command -pv cat .env')).toEqual([])
    // A cluster WITHOUT a stop flag, and a glued value, still peel.
    expect(peelOneLauncher(['exec', '-cl', 'cat', '.env'])).toEqual(['cat', '.env'])
    expect(peelOneLauncher(['nice', '-n5', 'cat', '.env'])).toEqual(['cat', '.env'])
    // SMI-6908: a known VALUE flag is one option, never a cluster, so
    // `arch -arch arm64 cat` (which runs cat, measured) is not read as a
    // cluster holding `-h`.
    expect(peelOneLauncher(['arch', '-arch', 'arm64', 'cat', '.env'])).toEqual(['cat', '.env'])
    expect(peelOneLauncher(['arch', '-h'])).toBeNull()
    expect(peelOneLauncher(['xcrun', '--show-sdk-path'])).toBeNull()
    // SMI-6908 round 27 F-17: the single-dash describe-only spellings stop
    // (each measured exiting 64 and running nothing with a trailing command),
    // and `-toolchain`, a value flag whose letters include `h`, is one
    // option, never a cluster holding xcrun's own `-h`.
    expect(peelOneLauncher(['xcrun', '-show-sdk-path', 'cat', '.env'])).toBeNull()
    expect(peelOneLauncher(['xcrun', '-sdk', 'macosx', '-find', 'cat'])).toBeNull()
    expect(peelOneLauncher(['xcrun', '-h', 'cat', '.env'])).toBeNull()
    expect(peelOneLauncher(['xcrun', '-version', 'cat', '.env'])).toBeNull()
    expect(peelOneLauncher(['xcrun', '-toolchain', 'default', 'cat', '.env'])).toEqual([
      'cat',
      '.env',
    ])
  })

  // Round 23: a launcher's own `-c`/`--command` value is a nested command the
  // launcher runs through a shell (util-linux `script -c`, `flock FILE -c`,
  // `su -c`; each measured printing a decoy in bash 5.2). The env guard reads
  // it as shell text through this reading, one level deep.
  it('extracts a -c body from a DASH_C launcher in every spelling', () => {
    expect(launcherDashCCommand(['script', '-q', '-c', 'cat .env', '/dev/null'])).toBe('cat .env')
    expect(launcherDashCCommand(['script', '-q', '/dev/null', '-c', 'cat .env'])).toBe('cat .env')
    expect(launcherDashCCommand(['script', '--command', 'cat .env', 'f'])).toBe('cat .env')
    expect(launcherDashCCommand(['script', '--command=cat .env', 'f'])).toBe('cat .env')
    expect(launcherDashCCommand(['script', '-ccat .env', 'f'])).toBe('cat .env')
    // Round 24: getopt's cluster rule. `c` last takes the next word; `c` not
    // last takes the rest of the token (`-cq` runs `q`, measured).
    expect(launcherDashCCommand(['script', '-qc', 'cat .env', 'f'])).toBe('cat .env')
    expect(launcherDashCCommand(['script', '-qccat .env', 'f'])).toBe('cat .env')
    expect(launcherDashCCommand(['script', '-cq', 'cat .env', 'f'])).toBe('q')
    expect(launcherDashCCommand(['script', '-qa', '-c', 'cat .env'])).toBe('cat .env')
    expect(launcherDashCCommand(['script', '-q', '-c'])).toBeNull()
    expect(launcherDashCCommand(['flock', '/tmp/l', '-c', 'cat .env'])).toBe('cat .env')
    expect(launcherDashCCommand(['su', 'root', '-c', 'cat .env'])).toBe('cat .env')
    expect(launcherDashCCommand(['/usr/bin/script', '-c', 'cat .env'])).toBe('cat .env')
    // No body, a `--` before it, or not a DASH_C launcher: null.
    expect(launcherDashCCommand(['script', '-q', '/dev/null'])).toBeNull()
    expect(launcherDashCCommand(['script', '--', '-c', 'cat .env'])).toBeNull()
    expect(launcherDashCCommand(['timeout', '-c', 'cat .env'])).toBeNull()
    expect(launcherDashCCommand(['script', '-c'])).toBeNull()
  })

  it('reads a -c body as its own segments through the caller-supplied splitter', () => {
    const split = (c: string) =>
      transparentHeadReadings(
        splitCommandSegments(tokenize(c)),
        normalizeWrappers,
        splitCommandSegments
      ).map((r) => r.map((t) => t.value))
    expect(split("script -q -c 'cat .env' /dev/null")).toEqual([['cat', '.env']])
    expect(split("script -q -c 'ls; cat .env' /dev/null")).toEqual([['ls'], ['cat', '.env']])
    expect(split("flock /tmp/l -c 'cat .env'")).toEqual([['cat', '.env']])
    expect(split("sudo script -q -c 'cat .env' /dev/null")).toEqual([['cat', '.env']])
    // Without the splitter the body is one segment (the default), still read.
    expect(readingWords("script -q -c 'cat .env' /dev/null")).toEqual([['cat', '.env']])
    // A `script` with no -c body is an ordinary launcher row.
    expect(readingWords('script -q /dev/null cat .env')).toEqual([['cat', '.env']])
  })

  it('re-reads a -c body with this same reading, two levels deep (round 24)', () => {
    const split = (c: string) =>
      transparentHeadReadings(
        splitCommandSegments(tokenize(c)),
        normalizeWrappers,
        splitCommandSegments
      ).map((r) => r.map((t) => t.value))
    // A launcher inside the body yields the body segment AND its peel.
    expect(split("script -q -c 'timeout 5 cat .env' /dev/null")).toEqual([
      ['timeout', '5', 'cat', '.env'],
      ['cat', '.env'],
    ])
    // A body inside the body: one more level, then the launcher row's own
    // peel of the innermost `script` (its quoted body is a positional).
    expect(split('script -q -c "script -q -c \'cat .env\' f" f')).toEqual([
      ['script', '-q', '-c', 'cat .env', 'f'],
      ['cat', '.env'],
    ])
    const three = 'script -q -c "script -q -c \\"script -q -c \'cat .env\' f\\" f" f'
    expect(split(three).some((r) => r.join(' ') === 'cat .env')).toBe(false)
  })

  it('yields nothing when peeling consumes every word', () => {
    expect(readingWords('timeout 5')).toEqual([])
    expect(readingWords('nice -n 5')).toEqual([])
  })

  it('yields nothing on an ordinary command', () => {
    expect(readingWords('cat .env')).toEqual([])
    expect(readingWords('ls -la', normalizeWrappers)).toEqual([])
  })
})
