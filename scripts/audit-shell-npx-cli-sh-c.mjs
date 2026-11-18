/**
 * SMI-7226: does the text before a quote end in `sh -c` (or a relative), so the
 * quoted string is a command that runs? Shells: sh, bash, zsh, dash, ksh, also
 * by path (/bin/bash) or after ; & | ( . The -c may be bundled (-lc, -ce);
 * flags may come before it, including `-o`/`-O <option>`, and more flags (or a
 * lone `-`/`--`) after it.
 *
 * This walks whitespace-separated tokens backwards from the quote and stops at
 * the first token that cannot be part of the shape, so a call costs about the
 * length of the shape, not the line. It replaces a regex that had the same
 * meaning but backtracked: exponentially on `-O -x -O -x …` (CodeQL js/redos)
 * and, after that fix, quadratically on `bash -c -c -c … x` (PR #3257 delta
 * review). The tests check it against that regex on generated token strings.
 */

const SHELL_TAIL = /(?:^|[;&|(/])(?:ba|z|da|k)?sh$/
const C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/
const SPACE = /\s/

/** [start, end) of the token ending at or before `end`, or null. */
function prevToken(s, end) {
  let e = end
  while (e > 0 && SPACE.test(s[e - 1])) e--
  if (e === 0) return null
  let b = e
  while (b > 0 && !SPACE.test(s[b - 1])) b--
  return [b, e]
}

/** True when s.slice(0, end) ends in a `sh -c` command, flags included. */
export function endsInShC(s, end = s.length) {
  // Trailing flags, newest first. A -c flag is a candidate; flags after it may
  // be anything starting with `-`, but a lone `-` can't come before it.
  let seenC = false
  let tok = prevToken(s, end)
  while (tok && s[tok[0]] === '-') {
    const t = s.slice(tok[0], tok[1])
    if (t === '-') seenC = false
    else if (C_FLAG.test(t)) seenC = true
    else if (seenC && SHELL_TAIL.test(t)) return true
    tok = prevToken(s, tok[0])
  }
  if (!seenC) return false
  // Before the -c: flags of two or more characters, `-o`/`-O <value>` pairs,
  // and then the shell word.
  while (tok) {
    const t = s.slice(tok[0], tok[1])
    if (SHELL_TAIL.test(t)) return true
    if (t[0] === '-') {
      if (t.length < 2) return false
      tok = prevToken(s, tok[0])
      continue
    }
    const opt = prevToken(s, tok[0])
    if (!opt) return false
    const o = s.slice(opt[0], opt[1])
    if (o !== '-o' && o !== '-O') return false
    tok = prevToken(s, opt[0])
  }
  return false
}
