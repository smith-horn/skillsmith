/**
 * The comment-boundary rule for `shell-command-tokenize.mjs`, split out of
 * it (SMI-6892 retro of PR #2970): six review rounds (14 to 19) patched this
 * one predicate inline and left the tokenizer at exactly the 500-line
 * convention with zero remaining lines, so the next correction could not be
 * written there at all. Everything about WHERE a `#` may begin a comment
 * lives here; the tokenizer keeps the scanning loop and calls in.
 *
 * Every row this module encodes was measured in bash 3.2 (host), bash 5.2
 * (container) and zsh 5.9 (host, the shell Claude Code's Bash tool runs on
 * this machine). See ADR-172 sec 3.
 */

/**
 * The raw characters bash itself ends a word on that are UNCONDITIONAL `#`
 * comment boundaries: space, tab and newline (bash's ONLY blanks -- NOT JS
 * `/\s/`'s set), plus `;`, `|`, `&`. A `)` is NOT in this set -- it is a
 * boundary only by POSITION (see `closingParenIsBoundary`). `{`/`}` are
 * reserved WORDS, not metacharacters, so they stay absent.
 */
export const COMMENT_BOUNDARY_CHARS = new Set([' ', '\t', '\n', ';', '|', '&'])

/**
 * True when `tokens` ends in the words `case`, `<anything>`, `in` --
 * `case`'s own subject line -- with `case` itself at command position (the
 * token before it absent, or an op other than `)`/`}`; SMI-6892 round 17).
 * Read before `pushOp` flushes `cur`: a glued in-progress word is never
 * this paren.
 * @param {Array<{type: string, value?: string}>} tokens
 */
export function isCasePatternParen(tokens) {
  const n = tokens.length
  if (n < 3) return false
  const [caseTok, subject, inTok] = tokens.slice(n - 3)
  if (caseTok.type !== 'word' || caseTok.value !== 'case' || subject.type !== 'word') return false
  if (inTok.type !== 'word' || inTok.value !== 'in') return false
  const before = tokens[n - 4]
  return (
    before === undefined || (before.type === 'op' && before.value !== ')' && before.value !== '}')
  )
}

/**
 * Classify an opening `(` for the paren stack.
 *
 * `kind`: COMMAND position (subshell / `((…))`) when the token stream is
 * empty, or its last token (the in-progress word `cur` first, since it is
 * not yet flushed) is an op other than `)`/`}`, or it is a `case`
 * statement's own leading pattern paren (round 17); otherwise WORD position
 * (`echo (a|b)`, `a=(1 2)`; round 16).
 *
 * `fnName`: the `(` is glued to a bare word carrying no `=`, a function
 * definition's `name()` shape (round 17).
 *
 * `arith`: this `(` is RAW-adjacent to an enclosing `(` -- the `((` of an
 * arithmetic command. A `#` inside one is NOT a comment: `(( 1 #2 )); cat
 * .env` and `(( #2 )); cat .env` both RUN the read in bash 3.2, bash 5.2
 * and zsh 5.9 (measured; each emits the file's contents), while the comment
 * rule discarded the whole rest of the line and both guards allowed it.
 * Adjacency is the discriminator and it was measured, not reasoned:
 * `( ( 1 #2 ) )` with a space is nested subshells, where the `#` IS a
 * comment in all three shells, and `( ( : ) #c` shows comments work
 * normally inside a plain subshell. A `((` that the shells actually fall
 * back to reading as nested subshells (`((echo a); (echo b))`, measured as
 * running both) is marked `arith` here too: suppressing a comment can only
 * KEEP command text, never discard it, so that misread is in the
 * fail-closed direction.
 * @param {{type: string, value?: string} | undefined} last
 * @param {Array<{type: string, value?: string}>} tokens
 * @param {{type: string, value?: string} | null} cur
 * @param {string | undefined} rawPrevChar `command[i - 1]`
 * @param {number} openDepth how many `(` are currently open
 */
export function classifyOpenParen(last, tokens, cur, rawPrevChar, openDepth) {
  const isCommand =
    last === undefined || (last.type === 'op' && last.value !== ')' && last.value !== '}')
  return {
    kind: isCommand || (cur === null && isCasePatternParen(tokens)) ? 'command' : 'word',
    fnName: !isCommand && last !== undefined && last.type === 'word' && !last.value.includes('='),
    arith: rawPrevChar === '(' && openDepth > 0,
  }
}

/**
 * Whether the `)` that just closed `entry` ends a word, and so may precede
 * a comment `#`. A boundary iff its `(` was COMMAND position, it is
 * UNMATCHED (`parenKinds.pop()` on an empty stack -- a `case` pattern's
 * `a)#x`), or (round 17) it closes a function definition's EMPTY `name()`.
 * Empty means the RAW previous character is `(`, not the tracked
 * `prevChar`: a `\`+newline inside the parens makes zsh read `()#x` as a
 * glob word and run the tail (measured; bash reads a comment), so a
 * continuation there keeps the tail live (round 18).
 * @param {{kind: string, fnName: boolean} | undefined} entry
 * @param {string | undefined} rawPrevChar `command[i - 1]`
 */
export function closingParenIsBoundary(entry, rawPrevChar) {
  return (
    entry === undefined ||
    entry.kind === 'command' ||
    (entry.fnName === true && rawPrevChar === '(')
  )
}

/**
 * Whether an unquoted `#` at this point begins a comment. It does only when
 * it starts a NEW word (`cur === null`), is not inside an arithmetic
 * `((…))` (`arithDepth === 0`), and the LOGICAL previous character is a
 * boundary: one of `COMMENT_BOUNDARY_CHARS`, the start of input, or a `)`
 * whose own close was a boundary.
 *
 * `cur === null` alone is not enough: `{`/`}` are bash RESERVED WORDS, not
 * operators, yet the tokenizer flushes them as op tokens unconditionally
 * (`printf "[%s]" ${X}#foo bar` is TWO words in bash, `a{b}#x; cmd` still
 * runs `cmd`), and the tokenizer's whitespace flush uses JS `/\s/`, wider
 * than bash's own blanks (`hi<CR>#x; cmd` is one word plus a live `cmd`).
 *
 * `<`/`>` are metacharacters too but deliberately absent from the
 * boundary set: their own branch leaves `cur` non-null, so listing them is
 * a no-op, and real bash rejects a glued `>#f` anyway. `${#name}` needs no
 * special case -- that `#` follows `{`.
 * @param {{type: string} | null} cur
 * @param {string} prevChar the LOGICAL previous character (a removed
 *   `\`+newline pair must not change it)
 * @param {boolean} closeParenIsBoundary verdict from the most recent `)`
 * @param {number} arithDepth how many arithmetic `((` pairs are open
 */
export function startsComment(cur, prevChar, closeParenIsBoundary, arithDepth) {
  if (cur !== null || arithDepth > 0) return false
  if (prevChar === '') return true
  if (COMMENT_BOUNDARY_CHARS.has(prevChar)) return true
  return prevChar === ')' && closeParenIsBoundary
}
