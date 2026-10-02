/**
 * A head whose operand IS shell text (SMI-6920, the post-merge retro of PR
 * #2978): `eval "cat .env"`, `env -S "cat .env"` / `env --split-string=…`
 * / a glued `-S…`, and `trap "cat .env" EXIT` each hand one word to the
 * shell to be tokenized again, so a reader spelled inside that word was
 * never seen by a guard that only strips the head (`eval cat .env` denied,
 * `eval "cat .env"` allowed on every tree, decoys printed in bash 3.2, zsh
 * 5.9 and bash 5.2; the live hook pair let `eval "cat <path>/.env"`
 * through). Shared by both guards: the ruflo guard had read `eval` and
 * `env -S` through guard-local helpers whose docblock said no sibling
 * needed them, which is how the env guard's gap went unnoticed; its own
 * text-only `env -S` reading (`detectEnvSplitString`) went with them once
 * the review of 243a96847 found `env -S npx ruflo memory store` allowed
 * through it while the same line behind `sudo` denied.
 *
 * Returns the operand text to evaluate as a command line, or null when the
 * head is not one of these or runs nothing (`trap -l`, `trap -p`, `trap -
 * SIG`, `eval` with no argument). The caller decides how an operand that
 * EXPANDS is treated: the env guard re-tokenizes it anyway (an expansion
 * yields no literal protected name, and its substitutions are already read
 * by the enclosing segment); the ruflo guard denies an expanding `eval`
 * argument (H9) and leaves an expanding `trap` action as the variable-
 * indirection limit it already accepts (22 of the 45 `trap` lines in this
 * repository expand, `trap 'rm -rf "$TMPROOT"' EXIT`; the governance review
 * of 243a96847 measured them all denied, with a false reason, on a guard
 * with no opt-out).
 */

import { LAUNCHER_TABLE, stripLauncher } from './shell-command-launchers.mjs'
import { basenameOf } from './shell-command-tokenize.mjs'

/**
 * `env -S '<text>' [more…]` / `env --split-string='<text>'` / glued
 * `-S<text>` (GNU coreutils env(1)): the flag re-tokenizes its argument as
 * one shell command line and APPENDS the remaining operands to the result,
 * so `env -S cat .env` runs `cat .env`. Skips env's own leading assignments
 * and value flags first (`env -uX -S '…'`, `env X=1 -S '…'`), then scans
 * every remaining token. The scan moved here from
 * `ruflo-host-guard-wrappers.mjs` (H-3, SMI-6744 Wave 4) unchanged; the
 * `rest` is new (SMI-6920), for the wrapper normalizer's nested body.
 * @param {string[]} rawValues
 * @returns {{ text: string, rest: string[] } | null}
 */
export function envSplitString(rawValues) {
  if (basenameOf(rawValues[0] ?? '') !== 'env') return null
  let i = 1
  while (i < rawValues.length) {
    const a = rawValues[i]
    if (a === '-S' || a === '--split-string') {
      if (rawValues[i + 1] === undefined) return null
      return { text: rawValues[i + 1], rest: rawValues.slice(i + 2) }
    }
    if (a.startsWith('--split-string='))
      return { text: a.slice('--split-string='.length), rest: rawValues.slice(i + 1) }
    if (a.startsWith('-S') && a !== '-S') return { text: a.slice(2), rest: rawValues.slice(i + 1) }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      i++
      continue
    }
    if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir') {
      i += 2
      continue
    }
    if (a === '--') break
    if (a.startsWith('-')) {
      i++
      continue
    }
    break
  }
  return null
}

/**
 * The command line `env -S` will run: the split text with the remaining
 * operands appended. env appends those operands VERBATIM (it never
 * re-parses them), so each is single-quoted here before the whole is
 * re-tokenized: joined bare, an operand carrying `#`, `;`, `|`, `&`, `>`
 * or a quote became a comment, a separator or a redirect and the reader
 * behind it vanished (`env -S cat "#x" .env` read nothing while the shell
 * printed the file; the governance review of 243a96847, C-1, eight
 * spellings). Quoted, a word stays one word whatever it carries.
 * @param {string[]} rawValues
 * @returns {string | null}
 */
export function envSplitCommandText(rawValues) {
  const s = envSplitString(rawValues)
  if (s === null) return null
  const quoted = (w) => "'" + w.split("'").join("'\\''") + "'"
  return s.rest.length === 0 ? s.text : s.text + ' ' + s.rest.map(quoted).join(' ')
}

/**
 * Which of `argv`'s words a shell-text head hands to the shell as text: a
 * half-open index span, or null when the head is not one of these or runs
 * nothing. ONE rule for both guards (the ruflo guard maps the span onto its
 * own `.subs`-bearing tokens): `eval` joins every word after it, past a
 * separate `--` (`eval -- cat D` runs `cat D` in bash 3.2, zsh 5.9 and
 * bash 5.2; `eval "-- cat D"` runs nothing and the quoted word is left
 * alone); `trap [--] ACTION SIG…` hands over the one action word (`trap
 * -l`, `trap -p`, `trap - SIG` run nothing; past `--` the action is
 * whatever follows, `trap -- "cat D" EXIT` printed a decoy); `watch`
 * without `-x`/`--exec` joins its operands into `sh -c` text (documented
 * semantics, the binary is installed nowhere here; with `-x` the operands
 * are argv and the launcher row reads them).
 * @param {string[]} argv
 * @returns {{ start: number, end: number } | null}
 */
export function shellTextOperandSpan(argv) {
  if (argv.length < 2) return null
  const head = basenameOf(argv[0])
  if (head === 'eval') return { start: argv[1] === '--' ? 2 : 1, end: argv.length }
  if (head === 'trap') {
    // Past a separate `--` the next word is the action whatever it looks like
    // (`trap -- "cat D" EXIT` printed a decoy).
    if (argv[1] === '--') {
      const action = argv[2]
      if (action === undefined || action === '-') return null
      return { start: 2, end: 3 }
    }
    // `-l` and `-p` (and a cluster of them) are the only options either
    // builtin accepts -- `trap [-lp] [arg] [sig…]` in both synopses -- and
    // under either the builtin LISTS or PRINTS and runs no action, so there is
    // nothing to read. Testing the whole action's first character instead
    // dropped the reading for any action merely BEGINNING with a dash, which
    // zsh 5.9 installs and runs: `trap "-l; cat D" EXIT` printed the decoy
    // while both guards allowed, as did the `-p;`, `-- echo a;`, `- ;` and
    // `-n echo a;` spellings (SMI-6937, the post-merge retro of PR #2982;
    // bash 3.2 rejects all five, zsh is the shell the harness runs).
    //
    // Matching the option exactly also keeps `trap -p EXIT` unread, where
    // advancing PAST the option would have read `EXIT` as the action and
    // refused a line that only prints.
    if (/^-[lp]+$/.test(argv[1])) return null
    if (argv[1] === '-') return null
    return { start: 1, end: 2 }
  }
  if (head === 'watch') {
    const rest = stripLauncher(argv.slice(1), LAUNCHER_TABLE.get('watch'))
    const start = argv.length - rest.length
    if (rest.length === 0 || argv.slice(1, start).some((w) => w === '-x' || w === '--exec'))
      return null
    return { start, end: argv.length }
  }
  return null
}

/**
 * @param {string[]} argv the segment's argv after wrapper peeling
 * @returns {string | null} the shell text the head will tokenize again
 */
export function shellTextOperand(argv) {
  const span = shellTextOperandSpan(argv)
  if (span !== null) return argv.slice(span.start, span.end).join(' ')
  if (argv.length >= 2 && basenameOf(argv[0]) === 'env') return envSplitCommandText(argv)
  return null
}
