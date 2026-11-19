/**
 * SMI-7226: does the text before a quote end in `sh -c` (or a relative), so the
 * quoted string is a command that runs? Shells: sh, bash, zsh, dash, ksh, also
 * by path (/bin/bash) or after ; & | ( or a backtick. The -c may be bundled (-lc, -ce);
 * flags may come before it, including `-o`/`-O <option>` and a letters-only
 * bundle holding o or O followed by its value (`-euo pipefail`, SMI-7241), and
 * more flags (or a lone `-`/`--`) after it.
 *
 * This walks whitespace-separated tokens backwards from the quote and stops at
 * the first token that cannot be part of the shape. It replaces a regex that
 * had the same meaning but backtracked: exponentially on `-O -x -O -x …`
 * (CodeQL js/redos) and, after that fix, quadratically on `bash -c -c -c … x`
 * (PR #3257 delta review). The tests check it against that regex.
 *
 * One line can hold many quote openings, and two things would make each one
 * cost the length of the line rather than of its own shape:
 * - Openings behind the same long run of flags would each re-walk it. So a
 *   caller scanning one line passes a `memo` Map: each step of a walk is a
 *   state (token span, phase, whether a -c was seen), its answer depends only
 *   on that state, and each state's answer is stored once.
 * - Openings inside one long unbroken token (`-"$(-"$(…`) would each scan
 *   back to its start and run a regex over it. So token starts and the letter
 *   and `c` lookups are tables built once per line. The shell-word regex
 *   never sees that partial first token: it runs only once a -c has been
 *   seen, so only on whole earlier tokens, each at most once per state.
 */

// The shell word: whole token, or after ; & | ( / or a backtick, which opens
// a command substitution (`` `bash -c '…'` ``) as `$(` does. Accepted
// over-approximations (owner decision, PR #3257): backslashes are ignored
// here, so an escaped `` \` `` or `\;` still counts, and a closing backtick
// (`` `echo hi`bash -c `` runs `hibash`) counts too. Both err towards a flag.
const SHELL_TAIL = /(?:^|[;&|(/`])(?:ba|z|da|k)?sh$/
const SPACE = /\s/
const LETTER = /[A-Za-z]/

/** Per-line tables, built once and kept in `memo` when there is one. */
function tables(s, memo) {
  if (memo !== null && memo.has('tables')) return memo.get('tables')
  const n = s.length
  const space = new Uint8Array(n)
  for (let i = 0; i < n; i++) space[i] = SPACE.test(s[i]) ? 1 : 0
  const start = new Int32Array(n) // token start of each non-space position
  for (let i = 0; i < n; i++) start[i] = i > 0 && !space[i - 1] ? start[i - 1] : i
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
  const t = { start, lastSolid, nonLetter, nextC, nextO }
  if (memo !== null) memo.set('tables', t)
  return t
}

/** [start, end) of the token ending at or before `end`, or null. */
function prevToken(t, end) {
  const j = t.lastSolid[end]
  return j < 0 ? null : [t.start[j], j + 1]
}

/** `-` then letters only, one of them `c` (-c, -lc, -ce). */
function isCFlag(s, t, [b, e]) {
  return s[b] === '-' && e - b >= 2 && t.nonLetter[b + 1] >= e && t.nextC[b + 1] < e
}

/** `-` then letters only, one of them o or O (-o, -eo, -euo): takes a value. */
function isOBundle(s, t, [b, e]) {
  return s[b] === '-' && e - b >= 2 && t.nonLetter[b + 1] >= e && t.nextO[b + 1] < e
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
  const path = []
  // A state seen before has a stored answer; otherwise remember the state so
  // the answer this walk reaches is stored for it too.
  const seen = (key) => {
    if (memo === null) return false
    if (memo.has(key)) return true
    path.push(key)
    return false
  }
  const done = (answer) => {
    if (memo !== null) for (const key of path) memo.set(key, answer)
    return answer
  }
  // Trailing flags, newest first. A -c flag is a candidate; flags after it may
  // be anything starting with `-`, but a lone `-` can't come before it.
  let seenC = false
  let tok = prevToken(t, end)
  while (tok && s[tok[0]] === '-') {
    const key = `f${seenC ? 1 : 0}:${tok[0]}:${tok[1]}`
    if (seen(key)) return done(memo.get(key))
    if (tok[1] - tok[0] === 1) seenC = false
    else if (isCFlag(s, t, tok)) seenC = true
    else if (seenC && isShellTail(s, tok)) return done(true)
    tok = prevToken(t, tok[0])
  }
  if (!seenC) return done(false)
  // Before the -c: flags of two or more characters, o-bundle `<value>` pairs
  // (`-o pipefail`, `-euo pipefail`), and then the shell word.
  while (tok) {
    const key = `b:${tok[0]}:${tok[1]}`
    if (seen(key)) return done(memo.get(key))
    if (isShellTail(s, tok)) return done(true)
    if (s[tok[0]] === '-') {
      if (tok[1] - tok[0] < 2) return done(false)
      tok = prevToken(t, tok[0])
      continue
    }
    const opt = prevToken(t, tok[0])
    if (!opt || !isOBundle(s, t, opt)) return done(false)
    tok = prevToken(t, opt[0])
  }
  return done(false)
}
