/**
 * SMI-6531 (#3283): one argument of a command Skillsmith prints for the user
 * to paste into a POSIX shell. A word of only `[A-Za-z0-9_./~:@%+=,-]` is
 * printed as it is; anything else is wrapped in single quotes, each `'`
 * written as `'\''`, so a space, `$`, a backtick, a newline or a quote reaches
 * the program as the same bytes. (`~` is left bare only inside a word, where
 * the shell does not expand it; a word that starts with `~` is quoted.)
 *
 * `install/park-callers.ts` has its own `shq`, which always quotes, for the
 * held park's detail; this is the one to reuse for a printed command.
 *
 * No filesystem access.
 *
 * @module @skillsmith/core/utils/shell-quote
 */

const SAFE = /^[A-Za-z0-9_./~:@%+=,-]+$/

/** `arg` as one POSIX shell word (see the module comment). */
export function shellQuote(arg: string): string {
  if (SAFE.test(arg) && !arg.startsWith('~')) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
