/**
 * SMI-7226: does the text before a quote end in `sh -c` (or a relative), so the
 * quoted string is a command that runs? Shells: sh, bash, zsh, dash, ksh, also
 * by path (/bin/bash) or after ; & | ( or a backtick. The -c may be bundled (-lc, -ce);
 * flags may come before it, including `-o`/`-O <option>` and a letters-only
 * bundle holding o or O followed by its value (`-euo pipefail`, SMI-7241),
 * with `+` as well as `-` (`+o posix`, `+eo posix`: bash takes the value for
 * either), and more flags (or a lone `-`/`--`) after it. A `+` then letters
 * with no o/O (`+e`, `+eu`, a lone `+`) is a flag before or after the -c, and
 * bash 5.2 reads a c in a `+` bundle as -c too (`bash +c '…'` runs the
 * string; measured, review round 3). A `+` bundle holding a c that bash does
 * not run (`+lc` ran nothing) is still read as -c, which errs towards a flag.
 *
 * It replaces a regex that had the same meaning but backtracked: exponentially
 * on `-O -x -O -x …` (CodeQL js/redos) and, after that fix, quadratically on
 * `bash -c -c -c … x` (PR #3257 delta review). The tests check it against
 * that regex.
 *
 * A `+` token is ambiguous before the -c: a flag (`+e`) or the value of an
 * o bundle before it (`+eo +x`), so a greedy walk back from the quote can take
 * the wrong reading. The shape is therefore decided by a dynamic program over
 * the line's whitespace-separated tokens, left to right, once per line:
 * - B[k]: the tokens up to k are a shell word followed by flags and
 *   o-bundle/value pairs (the part before the -c);
 * - A[k]: they are that, then a -c flag, then flags allowed after it.
 * Each entry reads only the one or two entries before it, so a line costs one
 * pass however many quote openings it holds; a caller scanning one line
 * passes the same `memo` Map to every call, which keeps the tables. A quote
 * opening inside a token (`-"$(…`) cuts that token: the piece before the
 * opening is tested on its own against the entries of the token before it.
 */

// The shell word: whole token, or after ; & | ( / or a backtick, which opens
// a command substitution (`` `bash -c '…'` ``) as `$(` does. Accepted
// over-approximations (owner decision, PR #3257): backslashes are ignored
// here, so an escaped `` \` `` or `\;` still counts, and a closing backtick
// (`` `echo hi`bash -c `` runs `hibash`) counts too. Both err towards a flag.
const SHELL_TAIL = /(?:^|[;&|(/`])(?:ba|z|da|k)?sh$/
const SPACE = /\s/
const LETTER = /[A-Za-z]/

/** Per-line tables and the shape program, built once and kept in `memo` when there is one. */
function tables(s, memo) {
  if (memo !== null && memo.has('tables')) return memo.get('tables')
  const n = s.length
  const space = new Uint8Array(n)
  for (let i = 0; i < n; i++) space[i] = SPACE.test(s[i]) ? 1 : 0
  const lastSolid = new Int32Array(n + 1) // last non-space index before i, or -1
  lastSolid[0] = -1
  for (let i = 1; i <= n; i++) lastSolid[i] = space[i - 1] ? lastSolid[i - 1] : i - 1
  const nonLetter = new Int32Array(n + 1) // first non-letter index at or after i
  const nextC = new Int32Array(n + 1) // first `c` at or after i
  const nextO = new Int32Array(n + 1) // first `o` or `O` at or after i
  nonLetter[n] = nextC[n] = nextO[n] = n
  for (let i = n - 1; i >= 0; i--) {
    nonLetter[i] = LETTER.test(s[i]) ? nonLetter[i + 1] : i
    nextC[i] = s[i] === 'c' ? i : nextC[i + 1]
    nextO[i] = s[i] === 'o' || s[i] === 'O' ? i : nextO[i + 1]
  }
  // Whole tokens: starts[k], ends[k]; tok[i] is the token holding index i.
  const starts = []
  const ends = []
  const tok = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    if (space[i]) continue
    if (i === 0 || space[i - 1]) starts.push(i)
    tok[i] = starts.length - 1
    if (i + 1 === n || space[i + 1]) ends.push(i + 1)
  }
  const t = { lastSolid, nonLetter, nextC, nextO, starts, ends, tok }
  const m = starts.length
  const A = new Uint8Array(m)
  const B = new Uint8Array(m)
  for (let k = 0; k < m; k++) {
    const span = [starts[k], ends[k]]
    const b1 = k > 0 && B[k - 1] === 1
    // A value (not starting with `-`) after an o bundle that follows a valid part.
    const pair =
      k > 1 && B[k - 2] === 1 && s[span[0]] !== '-' && isOBundle(s, t, [starts[k - 1], ends[k - 1]])
    const before = isShellTail(s, span) || (isFlagBefore(s, t, span) && b1) || pair
    const after =
      (isCFlag(s, t, span) && b1) || (isFlagAfter(s, t, span) && k > 0 && A[k - 1] === 1)
    B[k] = before ? 1 : 0
    A[k] = after ? 1 : 0
  }
  t.A = A
  t.B = B
  if (memo !== null) memo.set('tables', t)
  return t
}

/** `-` or `+`, then letters only, one of them `c` (-c, -lc, -ce, +c). */
function isCFlag(s, t, [b, e]) {
  return (
    (s[b] === '-' || s[b] === '+') && e - b >= 2 && t.nonLetter[b + 1] >= e && t.nextC[b + 1] < e
  )
}

/** `-` or `+`, then letters only, one of them o or O (-o, -euo, +o, +eo): takes a value. */
function isOBundle(s, t, [b, e]) {
  return (
    (s[b] === '-' || s[b] === '+') && e - b >= 2 && t.nonLetter[b + 1] >= e && t.nextO[b + 1] < e
  )
}

/**
 * `+` then letters only, possibly none, with no o or O (+e, +eu, +): a flag
 * wherever it stands. A `+` bundle holding o/O takes a value instead
 * (isOBundle), so `bash +o -c '…'` gives `-c` to the `+o` and runs nothing.
 */
function isPlusFlag(s, t, [b, e]) {
  return s[b] === '+' && t.nonLetter[b + 1] >= e && t.nextO[b + 1] >= e
}

/** A flag before the -c: `-` and at least one more character, or a `+` flag. */
function isFlagBefore(s, t, span) {
  return (s[span[0]] === '-' && span[1] - span[0] >= 2) || isPlusFlag(s, t, span)
}

/** A flag after the -c: anything starting with `-` (a lone `-` too), or a `+` flag. */
function isFlagAfter(s, t, span) {
  return s[span[0]] === '-' || isPlusFlag(s, t, span)
}

function isShellTail(s, [b, e]) {
  return SHELL_TAIL.test(s.slice(b, e))
}

/**
 * True when s.slice(0, end) ends in a `sh -c` command, flags included. Pass
 * the same `memo` Map to every call on one `s` (and only on that `s`). A
 * negative `end` (a heredoc body's sticky frame has no opening) gives false;
 * the old regex call (`slice(0, -1)`) read it as "all but the last
 * character", so it flagged body text such as `npx supabase sh -c x`.
 */
export function endsInShC(s, end = s.length, memo = null) {
  if (!(end >= 0)) return false
  if (end > s.length) end = s.length
  const t = tables(s, memo)
  const j = t.lastSolid[end]
  if (j < 0) return false
  const k = t.tok[j]
  if (t.ends[k] === j + 1) return t.A[k] === 1
  // `end` cuts token k: its piece before `end` must be the -c or a flag after it.
  const piece = [t.starts[k], j + 1]
  if (k === 0) return false
  return (
    (isCFlag(s, t, piece) && t.B[k - 1] === 1) || (isFlagAfter(s, t, piece) && t.A[k - 1] === 1)
  )
}
