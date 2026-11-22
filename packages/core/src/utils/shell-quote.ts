/**
 * SMI-6531 (#3283): one argument of a command Skillsmith prints for the user
 * to paste into a POSIX shell. A word of only `[A-Za-z0-9_./:@%+,-]` that does
 * not start with `-` is printed as it is; anything else is wrapped in single
 * quotes, each `'` written as `'\''`, so a space, `$`, a backtick, a newline or
 * a quote reaches the program as the same bytes.
 *
 * `~` and `=` are never bare: bash expands `~` after `name=` or `:` inside a
 * word, and zsh expands a leading `=`. A leading `-` is quoted too, though a
 * quoted `-x` still reaches the program as `-x`: callers that print a value a
 * program could read as an option must also rule that out themselves.
 *
 * `install/park-callers.ts` (`shq`) and `db/corrupt-refusal.ts` have their
 * own helpers that always quote; changing them would change shipped text.
 *
 * No filesystem access.
 *
 * @module @skillsmith/core/utils/shell-quote
 */

const SAFE = /^[A-Za-z0-9_./:@%+,-]+$/

/** `arg` as one POSIX shell word (see the module comment). */
export function shellQuote(arg: string): string {
  if (SAFE.test(arg) && !arg.startsWith('-')) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
