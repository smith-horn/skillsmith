/**
 * Logical lines for Check 59's shell sub-check (SMI-7241). Backslash
 * continuations are joined as bash joins them, except that a backslash ending
 * a comment continues nothing; the comment is found with the line lexer
 * (audit-shell-npx-cli-lexer.mjs), so a `#` inside quotes is not one.
 */

import { lexLine } from './audit-shell-npx-cli-lexer.mjs'

/** Index of a trailing comment's `#` in `line` (lexed as `at`), or -1. */
export function trailingCommentIndex(line, at) {
  const re = /(?:^|\s)#/g
  let m
  while ((m = re.exec(line)) !== null) {
    const pos = m.index + m[0].length - 1
    if (at[pos].q === null) return pos
  }
  return -1
}

/** Index of the comment's `#` in a logical line, or -1. See lexLine for `lookahead`. */
function commentStart(line, lookahead = null) {
  const full = /^\s*#/.exec(line)
  if (full) return full[0].length - 1
  return line.includes('#') ? trailingCommentIndex(line, lexLine(line, { lookahead }).at) : -1
}

/**
 * A run: the physical lines from raw[i] up to the first that does not end in
 * a backslash, each continued piece without its backslash, joined once.
 * `starts[k]` is where piece k starts in `text`; `end` is the raw index after
 * the run; `pairs` caches the lexer's paren matches in `text` indices.
 */
function buildRun(raw, i) {
  const pieces = []
  const starts = []
  let len = 0
  let j = i
  for (;;) {
    const piece = raw[j]
    const more = piece.endsWith('\\') && j + 1 < raw.length
    const p = more ? piece.slice(0, -1) : piece
    starts.push(len)
    pieces.push(p)
    len += p.length
    j++
    if (!more) break
  }
  return { first: i, end: j, text: pieces.join(''), starts, pairs: new Map() }
}

/**
 * Returns join(i) for the physical lines `raw`: the logical line starting at
 * raw[i], as { line, next } (next: the raw index after it).
 *
 * A comment in a later piece needs the earlier pieces' context, and the
 * logical line ends after the piece holding it; the next logical line then
 * starts fresh at the following piece, inside the same run. Joining and
 * lexing to the end of the run on each such restart was quadratic
 * (`echo \` / ` # c \` repeated: 1.4 s at 4,000 lines, 26 s at 16,000). So a
 * run is joined once and kept while restarts fall inside it, and each
 * restart lexes a window of pieces that doubles until it holds a comment or
 * reaches the end of the run. Within a window every context is the one the
 * whole rest of the run gives it: the lexer decides from what precedes a
 * position, except the `((` arithmetic test, which reads the run's text past
 * the window (lexLine's `lookahead`). A restart costs at most about twice the
 * pieces it consumes, so the text is lexed a bounded number of times.
 */
export function makeJoiner(raw) {
  let run = null
  return (i) => {
    const first = raw[i]
    // The first piece is lexed alone for a comment: a backslash ending a
    // comment continues nothing.
    if (!first.endsWith('\\') || i + 1 >= raw.length || commentStart(first) !== -1) {
      return { line: first, next: i + 1 }
    }
    if (run === null || i < run.first || i >= run.end) run = buildRun(raw, i)
    const { text, starts, end, pairs } = run
    const k0 = i - run.first
    const s = starts[k0]
    const lookahead = { text, base: s, pairs }
    for (let w = 2; ; w *= 2) {
      const kEnd = k0 + w
      const e = kEnd >= starts.length ? text.length : starts[kEnd]
      const cut = commentStart(text.slice(s, e), lookahead)
      if (cut !== -1) {
        // The first piece starting after the comment is where the line ends.
        let k = k0 + 1
        while (k < starts.length && starts[k] <= s + cut) k++
        if (k >= starts.length) return { line: text.slice(s), next: end }
        return { line: text.slice(s, starts[k]), next: run.first + k }
      }
      if (kEnd >= starts.length) return { line: text.slice(s), next: end }
    }
  }
}
