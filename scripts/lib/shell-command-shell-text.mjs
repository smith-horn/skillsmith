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
 * needed them, which is how the env guard's gap went unnoticed.
 *
 * Returns the operand text to evaluate as a command line, or null when the
 * head is not one of these or runs nothing (`trap -l`, `trap -p`, `trap -
 * SIG`, `eval` with no argument). The caller decides how an operand that
 * EXPANDS is treated: the env guard re-tokenizes it anyway (an expansion
 * yields no literal protected name, and its substitutions are already read
 * by the enclosing segment), the ruflo guard denies it (H9).
 */

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
 * The split text alone, the ruflo guard's original contract (its H9-style
 * recursion reads the text and the appended operands are its own argv).
 * @param {string[]} rawValues
 * @returns {string | null}
 */
export function detectEnvSplitString(rawValues) {
  return envSplitString(rawValues)?.text ?? null
}

/**
 * The command line `env -S` will run: the split text with the remaining
 * operands appended, joined by spaces. Re-tokenizing a joined operand is an
 * over-approximation (a word that carried a space splits), which is safe in
 * an additive reading: it can add a denial, never remove one.
 * @param {string[]} rawValues
 * @returns {string | null}
 */
export function envSplitCommandText(rawValues) {
  const s = envSplitString(rawValues)
  if (s === null) return null
  return s.rest.length === 0 ? s.text : s.text + ' ' + s.rest.join(' ')
}

/**
 * @param {string[]} argv the segment's argv after wrapper peeling
 * @returns {string | null} the shell text the head will tokenize again
 */
export function shellTextOperand(argv) {
  if (argv.length < 2) return null
  const head = basenameOf(argv[0])
  // `eval -- cat D` runs `cat D` (measured: bash 3.2, zsh 5.9, bash 5.2),
  // so a separate `--` is not part of the text; `eval "-- cat D"` runs
  // nothing, and the quoted spelling is left as it is.
  if (head === 'eval') return argv.slice(argv[1] === '--' ? 2 : 1).join(' ')
  if (head === 'trap') {
    // `trap [--] ACTION SIG…`: only the action is shell text; `trap -l`,
    // `trap -p` and `trap - SIG` (reset) run nothing. Past the `--` option
    // terminator the action is whatever follows (`trap -- "cat D" EXIT`
    // printed a decoy in bash 3.2 and zsh 5.9; it allowed, SMI-6920 probe).
    const at = argv[1] === '--' ? 2 : 1
    const action = argv[at]
    if (action === undefined || action === '-') return null
    if (at === 1 && action.startsWith('-')) return null
    return action
  }
  if (head === 'env') return envSplitCommandText(argv)
  return null
}
