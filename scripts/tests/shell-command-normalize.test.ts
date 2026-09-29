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

  it('tokenize() normalizes a backtick substitution to the $(...) spelling in .value, and keeps the unwrapped body in .subs', () => {
    const tokens = tokenize('echo `echo hi`')
    const sub = tokens[1]
    expect(sub.value).toBe('$(echo hi)')
    expect(sub.subs).toEqual(['echo hi'])
  })

  it('tokenize() normalizes a whole-word backtick substitution (`x`) to $(x) in .value and records .subs', () => {
    const tokens = tokenize('`x`')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].value).toBe('$(x)')
    expect(tokens[0].subs).toEqual(['x'])
  })

  it('tokenize() normalizes a lone unmatched backtick to $() in .value, with an empty .subs entry', () => {
    const tokens = tokenize('`')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].value).toBe('$()')
    expect(tokens[0].subs).toEqual([''])
  })

  it('tokenize() normalizes a backtick substitution embedded in double-quoted text to $(...) in .value', () => {
    const tokens = tokenize('"a `x` b"')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].value).toBe('a $(x) b')
    expect(tokens[0].subs).toEqual(['x'])
  })

  it('the backtick and $(...) spellings of one substitution produce the SAME .value: one construct, one representation', () => {
    for (const inner of ['x', 'which ruflo', 'echo hi']) {
      expect(tokenize('`' + inner + '`')[0].value).toBe(tokenize('$(' + inner + ')')[0].value)
      expect(tokenize('"a `' + inner + '` b"')[0].value).toBe(
        tokenize('"a $(' + inner + ') b"')[0].value
      )
    }
  })

  it('a backtick inside single quotes is literal text, not a substitution: .value keeps the backticks and .subs stays empty', () => {
    const tokens = tokenize("echo 'a `x` b'")
    expect(tokens[1].value).toBe('a `x` b')
    expect(tokens[1].subs).toEqual([])
  })

  it('a backslash-escaped backtick outside quotes is literal text, not a substitution: .value keeps the backticks and .subs stays empty', () => {
    const tokens = tokenize('echo \\`x\\`')
    expect(tokens[1].value).toBe('`x`')
    expect(tokens[1].subs).toEqual([])
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

    // C1 fix (SMI-6744 delta governance round): the ORIGINAL H-6 fix above
    // only decoded `\n`, `\t`, `\\`, `\'`, and `\xHH` -- `\NNN` (octal),
    // `\uHHHH`, and `\UHHHHHHHH` fell through UNCHANGED, so
    // `$'\162uflo' memory store` (octal 162 = 'r') reached the ruflo host
    // guard as the literal text `\162uflo`, never equalling the decoded
    // `ruflo` its H-predicates test for -- a live bypass (measured:
    // `zsh -c "printf '\162uflo\n'"` prints `ruflo`), not a cosmetic gap.
    describe('C1 fix -- octal/unicode/control escapes', () => {
      it('decodes \\NNN octal escapes', () => {
        const tokens = tokenize("$'\\162uflo'")
        expect(wordValues(tokens)).toEqual(['ruflo'])
      })

      // Control, not a red arm: a `$'...'` word with NO escape sequence at
      // all was never part of this bug (it already decoded correctly
      // before this fix, since no escape branch is ever entered) — kept
      // here as a regression pin, not claimed to fail against the
      // pre-fix tokenizer.
      it("control: a $'...' word with no escapes at all decodes to its literal text", () => {
        const tokens = tokenize("$'ruflo'")
        expect(wordValues(tokens)).toEqual(['ruflo'])
      })

      it('decodes \\UHHHHHHHH (8-hex Unicode) escapes', () => {
        const tokens = tokenize("$'\\U00000072uflo'")
        expect(wordValues(tokens)).toEqual(['ruflo'])
      })

      it('decodes \\cX control-character escapes', () => {
        const tokens = tokenize("$'\\cA'")
        expect(wordValues(tokens)).toEqual(['\x01'])
      })

      it('decodes \\e / \\E as ESC (0x1b)', () => {
        expect(wordValues(tokenize("$'\\e'"))).toEqual(['\x1b'])
        expect(wordValues(tokenize("$'\\E'"))).toEqual(['\x1b'])
      })

      it('decodes \\0 and \\000 as a NUL byte', () => {
        expect(wordValues(tokenize("$'\\0'"))).toEqual(['\0'])
        expect(wordValues(tokenize("$'\\000'"))).toEqual(['\0'])
      })
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

// SMI-6869 Fix A: `<`/`>`/`&>` were plain word characters before this fix —
// `2>&1` tokenized as a leftover `2>` word plus a job-control `&` op plus a
// stray `1` word, which is what let a trailing redirect masquerade as an
// unrelated argv element (`unresolved-command` firing on that stray `1`)
// and let a GLUED runner+redirect (`ruflo>/dev/null`) hide `ruflo` inside
// one opaque word H4 never saw. See scripts/tests/ruflo-host-guard.test.ts'
// own SMI-6869 Fix A describe block for the guard-level verdict red arms
// these tokenizer shapes feed.
describe('SMI-6869 Fix A: redirect operators are word boundaries', () => {
  it('an unquoted > ends the current word; the operator plus its glued target is ONE redirect-marked word', () => {
    const tokens = tokenize('ruflo>/dev/null memory store')
    expect(tokens[0]).toMatchObject({ type: 'word', value: 'ruflo' })
    expect(tokens[0].redirect).toBeUndefined()
    expect(tokens[1]).toMatchObject({ type: 'word', value: '>/dev/null', redirect: true })
    expect(wordValues(tokens)).toEqual(['ruflo', '>/dev/null', 'memory', 'store'])
  })

  it('a bare digit sequence immediately before > stays attached as the fd prefix (2>&1 is ONE token, not 2> + & + 1)', () => {
    const tokens = tokenize('gh pr checks 2957 2>&1')
    expect(wordValues(tokens)).toEqual(['gh', 'pr', 'checks', '2957', '2>&1'])
    expect(tokens[tokens.length - 1]).toMatchObject({ value: '2>&1', redirect: true })
  })

  // SMI-6869 C1 correction: this assertion originally pinned `/tmp/o` as
  // `redirect: false` — a BYPASS, not a neutral observation. A redirect
  // token flushed with nothing glued onto it (`>` alone, followed by a
  // space) still has a target: the very NEXT word. Leaving that word
  // untagged let it become argv[0] of the "residual" command, and since a
  // word like `ls`/`cat`/`grep` sits on `NON_EXECUTING_VERBS`,
  // `checkBareNameInversion` exempted the whole segment — `> ls ruflo
  // memory store` and seven siblings ALLOWED. Fixed: the pending-redirect
  // flag now survives across the flush and tags the next word token too,
  // clearing on any operator or newline.
  it('a redirect operator followed by a SEPARATE (space-separated) target is ALSO marked redirect (C1 fix: it is still the target, just not glued)', () => {
    const tokens = tokenize('git push > /tmp/o 2>&1')
    expect(tokens.map((t) => [t.type, t.value, t.redirect ?? false])).toEqual([
      ['word', 'git', false],
      ['word', 'push', false],
      ['word', '>', true],
      ['word', '/tmp/o', true],
      ['word', '2>&1', true],
    ])
  })

  it('C1: the pending-redirect-target flag clears on an operator, so a word AFTER a stray trailing redirect is not wrongly tagged', () => {
    const tokens = tokenize('cmd > ; echo hi')
    const echoIdx = tokens.findIndex((t) => t.type === 'word' && t.value === 'echo')
    expect(tokens[echoIdx].redirect ?? false).toBe(false)
  })

  it('C1: the pending-redirect-target flag clears on a newline too', () => {
    const tokens = tokenize('cmd >\necho hi')
    const echoIdx = tokens.findIndex((t) => t.type === 'word' && t.value === 'echo')
    expect(tokens[echoIdx].redirect ?? false).toBe(false)
  })

  it('a digit that is NOT immediately followed by a redirect stays an ordinary word (no fd-prefix false match)', () => {
    const tokens = tokenize('sleep 5 & wait')
    expect(wordValues(tokens)).toEqual(['sleep', '5', 'wait'])
    expect(tokens.every((t) => !t.redirect)).toBe(true)
  })

  it('&> is recognized as ONE glued redirect operator token, not a job-control & followed by a word', () => {
    const tokens = tokenize('ls &> /tmp/o')
    expect(tokens.map((t) => t.type)).toEqual(['word', 'word', 'word'])
    expect(tokens[1]).toMatchObject({ type: 'word', value: '&>', redirect: true })
  })

  it('&>> (append form) is likewise one glued token', () => {
    const tokens = tokenize('ls &>> /tmp/o')
    expect(tokens[1]).toMatchObject({ type: 'word', value: '&>>', redirect: true })
  })

  it('|& tokenizes as the plain pipe operator (one op token), not a pipe plus a separate & job-control op', () => {
    const tokens = tokenize('ls |& cat')
    expect(tokens.map((t) => t.type)).toEqual(['word', 'op', 'word'])
    expect(tokens[1]).toEqual({ type: 'op', value: '|' })
  })

  it('a bare job-control & (not part of >&/<&/&>/&&/|&) is still its own op token', () => {
    const tokens = tokenize('sleep 5 & wait')
    expect(tokens.filter((t) => t.type === 'op')).toEqual([{ type: 'op', value: '&' }])
  })

  it('a glued here-string (bash<<<"text", no space) is ONE <<<-prefixed redirect word, split off the preceding command word', () => {
    const tokens = tokenize('bash<<<"ruflo memory store"')
    expect(wordValues(tokens)).toEqual(['bash', '<<<ruflo memory store'])
    expect(tokens[1].redirect).toBe(true)
  })

  it('&& and || are unaffected by the new & handling', () => {
    const tokens = tokenize('a && b || c')
    expect(tokens.filter((t) => t.type === 'op').map((t) => t.value)).toEqual(['&&', '||'])
  })
})

// SMI-6869 Fix B: the tokenizer had no heredoc state at all — a `<<`/`<<-`
// body's own lines were tokenized as ordinary, separate command-line
// segments (the exact bug this fix closes). See
// scripts/lib/shell-command-heredoc.mjs for the delimiter-parsing and
// body-consumption implementation these tests exercise indirectly through
// `tokenize()`.
describe('SMI-6869 Fix B: heredoc tokenization', () => {
  it("a quoted heredoc (<<'EOF') body becomes ONE heredoc token — its lines never surface as their own word tokens", () => {
    const tokens = tokenize("cat <<'EOF'\nline one\nline two\nEOF\necho done")
    const heredoc = tokens.find((t) => t.type === 'heredoc')
    expect(heredoc).toMatchObject({ value: 'line one\nline two\n', quoted: true, delim: 'EOF' })
    expect(wordValues(tokens)).toEqual(['cat', 'echo', 'done'])
  })

  it('an unquoted heredoc (<<EOF) records a $(...) substitution in .subs', () => {
    const tokens = tokenize('cat <<EOF\n$(ruflo memory store)\nEOF')
    const heredoc = tokens.find((t) => t.type === 'heredoc')
    expect(heredoc).toMatchObject({ quoted: false, subs: ['ruflo memory store'] })
  })

  it("a quoted heredoc (<<'EOF') never records a substitution, even when the body LOOKS like $(...)", () => {
    const tokens = tokenize("cat <<'EOF'\n$(ruflo memory store)\nEOF")
    const heredoc = tokens.find((t) => t.type === 'heredoc')
    expect(heredoc).toMatchObject({ quoted: true, subs: [] })
    expect(heredoc?.value).toBe('$(ruflo memory store)\n')
  })

  it('a double-quoted delimiter (<<"EOF") is also recognized as quoted', () => {
    const tokens = tokenize('cat <<"EOF"\n$(ruflo memory store)\nEOF')
    const heredoc = tokens.find((t) => t.type === 'heredoc')
    expect(heredoc).toMatchObject({ quoted: true, subs: [] })
  })

  it('<<- strips leading tabs when matching the terminator (and from the captured body line)', () => {
    const tokens = tokenize('cat <<-EOF\n\tindented body\n\tEOF')
    const heredoc = tokens.find((t) => t.type === 'heredoc')
    expect(heredoc).toMatchObject({ dash: true, delim: 'EOF', value: 'indented body\n' })
  })

  it('several heredocs opened on one line are filled in the order they were opened', () => {
    const tokens = tokenize('cat <<A <<B\nfirst\nA\nsecond\nB')
    const heredocs = tokens.filter((t) => t.type === 'heredoc')
    expect(heredocs.map((h) => h.value)).toEqual(['first\n', 'second\n'])
  })

  it('an unterminated heredoc (no terminator line before end of input) runs to end of input', () => {
    const tokens = tokenize('cat <<EOF\nnever terminated')
    const heredoc = tokens.find((t) => t.type === 'heredoc')
    expect(heredoc?.value).toBe('never terminated\n')
  })

  it('<< is distinct from <<< — a bare here-string operator never becomes a heredoc token', () => {
    const tokens = tokenize('bash <<< "ruflo memory store"')
    expect(tokens.some((t) => t.type === 'heredoc')).toBe(false)
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
