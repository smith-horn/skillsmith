/**
 * Characterisation tests for the shell-command-normalize primitives
 * (SMI-6744 A4.6), pinned BEFORE extracting them out of
 * `scripts/env-read-guard.mjs` into `scripts/lib/shell-command-normalize.mjs`
 * (plan § "Parity harness for the shared normalizer" /
 * docs/internal/implementation/smi-6744-ruflo-host-guard.md).
 *
 * The claim this file backs is "behaviourally equivalent for the
 * characterised input matrix", not "byte-for-byte" (round 1 finding 6) —
 * every case below was run GREEN against the pre-extraction in-file
 * implementations (temporarily exported from env-read-guard.mjs for this
 * one characterisation pass) before the code moved, and is run again here,
 * post-move, against `scripts/lib/shell-command-normalize.mjs`'s exports.
 * `hasInlineScriptFlag` and `scanPositionalScriptText` changed signature in
 * the move (their env-specific pieces became parameters instead of closed-
 * over module constants) — this file exercises the POST-move signature,
 * passing the exact same values env-read-guard.mjs itself now passes, so
 * the two runs are checking the same behaviour through two different call
 * shapes, not two different behaviours.
 */
import { describe, expect, it } from 'vitest'

import {
  extractShellDashC,
  hasInlineScriptFlag,
  MAX_DEPTH,
  normalizeWrappers,
  scanPositionalScriptText,
  stripDockerCompose,
  stripDockerExec,
  stripEnvPrefix,
  stripFlags,
  stripVarlockRun,
  tokenize,
} from '../lib/shell-command-normalize.mjs'

// Mirrors env-read-guard.mjs's own INLINE_SCRIPT_SHORT_FLAG_CHARS exactly —
// this file is testing the SHARED primitive, so it supplies the same env
// this guard passes, not a synthetic stand-in.
const SHORT_FLAG_CHARS = {
  python: 'c',
  python3: 'c',
  node: 'ep',
  nodejs: 'ep',
  perl: 'eE',
  ruby: 'e',
  php: 'rBRE',
}

function scanForDotEnv(text: string): string | null {
  return typeof text === 'string' && /(?:^|[^A-Za-z0-9_.-])\.env(?![A-Za-z0-9_-])/.test(text)
    ? '.env'
    : null
}

function wordValues(tokens: Array<{ type: string; value?: string }>) {
  return tokens.filter((t) => t.type === 'word').map((t) => t.value)
}

describe('tokenize()', () => {
  it('splits on whitespace and preserves quoted spaces as one word', () => {
    const tokens = tokenize('echo \'a b\' "c d"')
    expect(wordValues(tokens)).toEqual(['echo', 'a b', 'c d'])
  })

  it('an unquoted backslash escapes the next character into the same word', () => {
    const tokens = tokenize('echo a\\ b')
    expect(wordValues(tokens)).toEqual(['echo', 'a b'])
  })

  it('records a $(...) substitution in both .value and .subs', () => {
    const tokens = tokenize('echo $(echo hi)')
    const sub = tokens[1]
    expect(sub.type).toBe('word')
    expect(sub.value).toBe('$(echo hi)')
    expect(sub.subs).toEqual(['echo hi'])
  })

  it('a backtick substitution drops the backticks from .value but keeps .subs', () => {
    const tokens = tokenize('echo `echo hi`')
    const sub = tokens[1]
    expect(sub.value).toBe('echo hi')
    expect(sub.subs).toEqual(['echo hi'])
  })

  it('records a <(...) process substitution with its delimiters kept in .value', () => {
    const tokens = tokenize('diff <(cmd1) <(cmd2)')
    expect(tokens[1].value).toBe('<(cmd1)')
    expect(tokens[1].subs).toEqual(['cmd1'])
    expect(tokens[2].value).toBe('<(cmd2)')
    expect(tokens[2].subs).toEqual(['cmd2'])
  })

  it('unquoted { and } become their own op tokens, splitting the surrounding word', () => {
    const tokens = tokenize('npx ru{f,}lo')
    expect(tokens.map((t) => t.type)).toEqual(['word', 'word', 'op', 'word', 'op', 'word'])
    expect(tokens[2].value).toBe('{')
    expect(tokens[4].value).toBe('}')
  })

  it('quoted braces are literal text, not operators', () => {
    const tokens = tokenize("printf '{harmless}'")
    expect(tokens.map((t) => t.type)).toEqual(['word', 'word'])
    expect(tokens[1].value).toBe('{harmless}')
  })

  it('| && ; and newline are op tokens', () => {
    const tokens = tokenize('a | b && c ; d\ne')
    const ops = tokens.filter((t) => t.type === 'op').map((t) => t.value)
    expect(ops).toEqual(['|', '&&', ';', '\n'])
  })

  it('an unmatched single quote consumes the rest of the string as the word value', () => {
    const tokens = tokenize("echo 'abc")
    expect(wordValues(tokens)).toEqual(['echo', 'abc'])
  })

  it('an unmatched double quote consumes the rest of the string as the word value', () => {
    const tokens = tokenize('echo "abc')
    expect(wordValues(tokens)).toEqual(['echo', 'abc'])
  })

  // H-6 fix (SMI-6744 Wave 4 delta governance round): `$'...'` (ANSI-C
  // quoting) is a distinct Bash quoting form from a plain `'...'` — its
  // body's own backslash escapes ARE processed, unlike single quotes.
  describe("$'...' ANSI-C quoting (H-6 fix)", () => {
    it('is treated as a plain quoted word when it carries no escapes', () => {
      const tokens = tokenize("bash -c $'npx ruflo memory store --key k --value v'")
      expect(wordValues(tokens)).toEqual(['bash', '-c', 'npx ruflo memory store --key k --value v'])
    })

    it('decodes \\n and \\t', () => {
      const tokens = tokenize("echo $'a\\tb\\nc'")
      expect(wordValues(tokens)).toEqual(['echo', 'a\tb\nc'])
    })

    it("decodes \\\\ and \\' literally", () => {
      const tokens = tokenize("echo $'a\\\\b\\'c'")
      expect(wordValues(tokens)).toEqual(['echo', "a\\b'c"])
    })

    it('decodes \\xHH hex escapes', () => {
      const tokens = tokenize("echo $'\\x6e\\x70\\x78'")
      expect(wordValues(tokens)).toEqual(['echo', 'npx'])
    })

    it('passes an unrecognized escape character through unchanged', () => {
      const tokens = tokenize("echo $'a\\zb'")
      expect(wordValues(tokens)).toEqual(['echo', 'azb'])
    })

    it("an unmatched $'... consumes the rest of the string", () => {
      const tokens = tokenize("echo $'abc")
      expect(wordValues(tokens)).toEqual(['echo', 'abc'])
    })
  })
})

describe('stripFlags()', () => {
  it('drops leading single-char flags', () => {
    expect(stripFlags(['-a', '-b', 'cmd'])).toEqual(['cmd'])
  })

  it('consumes a value for a known value-taking flag', () => {
    expect(stripFlags(['-u', 'someuser', 'cmd'])).toEqual(['cmd'])
  })

  it('stops at -- and returns everything after it', () => {
    expect(stripFlags(['--', '--not-a-flag'])).toEqual(['--not-a-flag'])
  })

  it('treats an =-form flag as self-contained (no value consumed)', () => {
    expect(stripFlags(['--env=FOO', 'cmd'])).toEqual(['cmd'])
  })

  it('stops at the first non-flag token', () => {
    expect(stripFlags(['cmd', '-a'])).toEqual(['cmd', '-a'])
  })

  it('a bare "-" is not a flag and stops the scan', () => {
    expect(stripFlags(['-', 'cmd'])).toEqual(['-', 'cmd'])
  })
})

describe('stripEnvPrefix()', () => {
  it('drops leading VAR=val assignments', () => {
    expect(stripEnvPrefix(['FOO=1', 'BAR=2', 'cmd', 'arg'])).toEqual(['cmd', 'arg'])
  })

  it('consumes a value for -u / --unset / -C / --chdir', () => {
    expect(stripEnvPrefix(['-u', 'FOO', 'cmd'])).toEqual(['cmd'])
  })

  it('drops -- as a bare flag', () => {
    expect(stripEnvPrefix(['--', 'cmd'])).toEqual(['cmd'])
  })

  it('drops an unrecognized single-token flag', () => {
    expect(stripEnvPrefix(['-i', 'cmd'])).toEqual(['cmd'])
  })

  it('stops once a non-flag, non-assignment token is seen', () => {
    expect(stripEnvPrefix(['cmd', 'FOO=1'])).toEqual(['cmd', 'FOO=1'])
  })
})

describe('stripDockerExec()', () => {
  it('drops exec flags and the container name, keeping the inner command', () => {
    expect(stripDockerExec(['-it', 'mycontainer', 'cat', '/app/.env'])).toEqual([
      'cat',
      '/app/.env',
    ])
  })

  it('drops the container name alone when there are no flags', () => {
    expect(stripDockerExec(['mycontainer', 'echo', 'hi'])).toEqual(['echo', 'hi'])
  })
})

describe('stripDockerCompose()', () => {
  it('unwraps `docker compose exec <service> <inner>`', () => {
    expect(
      stripDockerCompose(['docker', 'compose', 'exec', 'dev', 'cat', 'file'], 'docker')
    ).toEqual(['cat', 'file'])
  })

  it('unwraps the docker-compose binary form the same way', () => {
    expect(
      stripDockerCompose(['docker-compose', 'exec', 'dev', 'cat', 'file'], 'docker-compose')
    ).toEqual(['cat', 'file'])
  })

  it('returns null when the subcommand is not exec (e.g. up)', () => {
    expect(stripDockerCompose(['docker', 'compose', 'up', '-d'], 'docker')).toBeNull()
  })
})

describe('stripVarlockRun()', () => {
  it('unwraps up to an explicit --', () => {
    expect(stripVarlockRun(['varlock', 'run', '--', 'echo', 'hi'])).toEqual(['echo', 'hi'])
  })

  it('falls back to flag-stripping when there is no --', () => {
    expect(stripVarlockRun(['varlock', 'run', '-q', 'echo'])).toEqual(['echo'])
  })

  // H-E fix (SMI-6744 Wave 4 governance round): a `--` belonging to the
  // WRAPPED command's own argv (e.g. npx/npm's own `--` separator) must
  // not be mistaken for varlock run's own separator just because it is
  // the first `--` anywhere in argv.
  it('falls back to flag-stripping when the first -- belongs to the wrapped command, not varlock', () => {
    expect(
      stripVarlockRun([
        'varlock',
        'run',
        'npx',
        'ruflo',
        'memory',
        'store',
        '--key',
        'k',
        '--',
        'x',
      ])
    ).toEqual(['npx', 'ruflo', 'memory', 'store', '--key', 'k', '--', 'x'])
  })

  it('falls back to flag-stripping when the wrapped command has no flags at all before its own --', () => {
    expect(
      stripVarlockRun(['varlock', 'run', 'ruflo', 'memory', 'store', '--key', 'k', '--', 'x'])
    ).toEqual(['ruflo', 'memory', 'store', '--key', 'k', '--', 'x'])
  })

  it("still trusts a -- immediately after a run of value-taking flags as varlock's own separator", () => {
    // -e/--env is in WRAPPER_VALUE_FLAGS, so "run -e FOO --" is a
    // flag-only span and this -- is legitimately varlock's own boundary.
    expect(stripVarlockRun(['varlock', 'run', '-e', 'FOO', '--', 'echo', 'hi'])).toEqual([
      'echo',
      'hi',
    ])
  })
})

describe('extractShellDashC()', () => {
  it('extracts the body of a -c flag', () => {
    expect(extractShellDashC(['bash', '-c', 'echo hi'])).toBe('echo hi')
  })

  it('extracts the body of a combined flag containing c (e.g. -lc)', () => {
    expect(extractShellDashC(['bash', '-lc', 'echo hi'])).toBe('echo hi')
  })

  it('returns null when a flag has no c and the next token is not a flag', () => {
    expect(extractShellDashC(['bash', '-l', 'somefile'])).toBeNull()
  })

  it('returns null when there is no flag at all', () => {
    expect(extractShellDashC(['bash', 'echo'])).toBeNull()
  })
})

describe('normalizeWrappers()', () => {
  it('unwraps sudo', () => {
    expect(normalizeWrappers(['sudo', 'node', 'x.js'])).toEqual({
      argv: ['node', 'x.js'],
      nested: null,
    })
  })

  it('unwraps env FOO=1', () => {
    expect(normalizeWrappers(['env', 'FOO=1', 'node', 'x.js'])).toEqual({
      argv: ['node', 'x.js'],
      nested: null,
    })
  })

  it('unwraps varlock run --', () => {
    expect(normalizeWrappers(['varlock', 'run', '--', 'node', 'x.js'])).toEqual({
      argv: ['node', 'x.js'],
      nested: null,
    })
  })

  it('unwraps docker exec <container>', () => {
    expect(normalizeWrappers(['docker', 'exec', 'mycontainer', 'cat', 'f'])).toEqual({
      argv: ['cat', 'f'],
      nested: null,
    })
  })

  it('unwraps docker compose exec <service>', () => {
    expect(normalizeWrappers(['docker', 'compose', 'exec', 'dev', 'cat', 'f'])).toEqual({
      argv: ['cat', 'f'],
      nested: null,
    })
  })

  it('unwraps a leading bare VAR=val assignment', () => {
    expect(normalizeWrappers(['FOO=1', 'node', 'x.js'])).toEqual({
      argv: ['node', 'x.js'],
      nested: null,
    })
  })

  it('unwraps sudo then env in the same call (iterates passes)', () => {
    expect(normalizeWrappers(['sudo', 'env', 'FOO=1', 'node', 'x.js'])).toEqual({
      argv: ['node', 'x.js'],
      nested: null,
    })
  })

  it('detects a nested bash -c body and returns it without stripping argv', () => {
    const result = normalizeWrappers(['bash', '-c', 'echo hi'])
    expect(result.nested).toBe('echo hi')
    expect(result.argv).toEqual(['bash', '-c', 'echo hi'])
  })

  it('the internal pass cap (8) does not fully unwrap a 9-deep sudo chain in one call', () => {
    const nineSudos = Array(9).fill('sudo').concat(['node', 'x.js'])
    const result = normalizeWrappers(nineSudos)
    // 8 passes peel 8 sudos; one sudo (plus node, x.js) remains — this pins
    // the existing internal loop bound, distinct from MAX_DEPTH (which
    // governs recursion into nested/substituted command TEXT, not this
    // wrapper-unwrap loop).
    expect(result.argv).toEqual(['sudo', 'node', 'x.js'])
    expect(result.nested).toBeNull()
  })
})

describe('MAX_DEPTH', () => {
  it('is exported as the recursion cap constant (6)', () => {
    expect(MAX_DEPTH).toBe(6)
  })
})

describe('hasInlineScriptFlag() — post-move 3-arg signature', () => {
  it('recognizes -e for node via the supplied short-flag-chars map', () => {
    expect(hasInlineScriptFlag('node', ['-e', 'code'], SHORT_FLAG_CHARS)).toBe(true)
  })

  it('recognizes -p for node (prints an expression, same hazard as -e)', () => {
    expect(hasInlineScriptFlag('node', ['-p', 'code'], SHORT_FLAG_CHARS)).toBe(true)
  })

  it('does not flag a plain script-file invocation', () => {
    expect(hasInlineScriptFlag('node', ['script.js'], SHORT_FLAG_CHARS)).toBe(false)
  })

  it('recognizes a long flag (--eval) uniformly across interpreters', () => {
    expect(hasInlineScriptFlag('python', ['--eval', 'code'], SHORT_FLAG_CHARS)).toBe(true)
  })

  it('stops scanning at --, so a flag-shaped positional after -- is not matched', () => {
    expect(hasInlineScriptFlag('node', ['--', '-e'], SHORT_FLAG_CHARS)).toBe(false)
  })

  it("ruby's -r (require) is not treated as inline code (per-interpreter short chars)", () => {
    expect(hasInlineScriptFlag('ruby', ['-r', 'somelib'], SHORT_FLAG_CHARS)).toBe(false)
  })

  it('an interpreter with no entry in the map never flags (?? fallback)', () => {
    expect(hasInlineScriptFlag('unknown-interp', ['-e', 'code'], SHORT_FLAG_CHARS)).toBe(false)
  })
})

describe('scanPositionalScriptText() — post-move 3-arg signature', () => {
  it('scans awk script text for an embedded match via the supplied scanFn', () => {
    expect(scanPositionalScriptText('awk', ['BEGIN{print ".env"}'], scanForDotEnv)).toBe('.env')
  })

  it('scans sed script text too', () => {
    expect(scanPositionalScriptText('sed', ['s/x/.env/'], scanForDotEnv)).toBe('.env')
  })

  it('returns null for a command outside POSITIONAL_SCRIPT_COMMANDS', () => {
    expect(scanPositionalScriptText('node', ['x.env'], scanForDotEnv)).toBeNull()
  })

  it('does NOT stop at -- (script text can follow it, unlike an option scan)', () => {
    expect(scanPositionalScriptText('awk', ['--', 'BEGIN{print ".env"}'], scanForDotEnv)).toBe(
      '.env'
    )
  })

  it('returns null when nothing embedded matches', () => {
    expect(scanPositionalScriptText('awk', ['BEGIN{print "hi"}'], scanForDotEnv)).toBeNull()
  })
})
