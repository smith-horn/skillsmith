/**
 * Shell-command tokenizer (quote-aware, records command substitutions),
 * shared by `scripts/env-read-guard.mjs` and `scripts/ruflo-host-guard.mjs`
 * via `scripts/lib/shell-command-normalize.mjs`. A backtick the tokenizer
 * interprets as a substitution (unquoted, or inside double quotes) is
 * spelled $(...) in .value, its body unchanged in .subs, so both spellings
 * reach every downstream $-based unresolvable-head test identically; a
 * backtick inside single quotes, behind a backslash, or in a heredoc body
 * is literal text and stays as written. An unquoted `#` that starts a NEW
 * word AND directly follows one of bash's own word-ending characters
 * (`COMMENT_BOUNDARY_CHARS`) begins a comment running through the next
 * newline; every other `#` -- quoted, mid-word, glued to a `{`/`}`, or
 * glued to a non-bash whitespace character -- stays literal text. A `#`
 * inside a `$(...)`/backtick BODY is likewise literal in the enclosing
 * word's `.value`, but a consumer that re-tokenizes that body
 * (`flattenSubWords`, `evaluateCommand`'s `.subs` recursion) applies the
 * comment rule to it, matching bash: the body is its own command text.
 *
 * Split out of `shell-command-normalize.mjs` (SMI-6744 Wave 4) to stay under
 * the repo's by-hand 500-line .mjs convention (not tool-enforced here;
 * SMI-5994); that file imports `tokenize`/`basenameOf` back from here and
 * RE-EXPORTS them, so no consumer's own import path changes.
 */

import { decodeEscapeAt } from './shell-escape-decode.mjs'
// L7 correction: `shell-command-heredoc.mjs` imports `readParen` back from
// THIS file — a real circular import, safe only because both sides are
// hoisted function declarations consumed at CALL time, after both modules
// finish loading.
import { consumeHeredocBodies, parseHeredocDelimiter } from './shell-command-heredoc.mjs'
// The comment-boundary rule (which characters and paren positions may
// precede a `#`, and the arithmetic suppression) lives in its own module
// since the retro of PR #2970: rounds 14 to 19 patched it inline until this
// file sat at exactly the 500-line convention with no room for the next
// correction. See that module's docblocks for every measured row.
import {
  classifyOpenParen,
  closingParenIsBoundary,
  startsComment,
} from './shell-command-comment.mjs'

/**
 * Characters that cannot continue a word, so the character right after a `)`
 * being one of these means no word is glued onto that `)`. Wider than
 * `COMMENT_BOUNDARY_CHARS` on purpose: this asks "does a word start here",
 * which every metacharacter and all of JS `/\s/` answers no to, whereas the
 * comment rule asks the narrower "did the SHELL end a word here".
 */
const WORD_ENDING_RE = /[\s;|&(){}<>#]/

/** @param {string} p */
export function basenameOf(p) {
  return p.split('/').pop()
}

// --- Tokenizer (quote-aware, records command substitutions) ---

/** Index just past the closing `"` starting at s[i] === '"'. */
function skipDouble(s, i) {
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2
      continue
    }
    if (s[j] === '"') return j + 1
    j++
  }
  return s.length
}

/**
 * Balanced-paren read; s[start] === '('. Exported (SMI-6869 Fix B) so
 * `shell-command-heredoc.mjs` can reuse it to scan an unquoted heredoc
 * body for `$(...)` substitutions the same way ordinary quoted text does.
 */
export function readParen(s, start) {
  let depth = 0
  let i = start
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      i = e === -1 ? s.length : e + 1
      continue
    }
    if (c === '"') {
      i = skipDouble(s, i)
      continue
    }
    if (c === '(') {
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth--
      i++
      if (depth === 0) return { inner: s.slice(start + 1, i - 1), next: i }
      continue
    }
    i++
  }
  return { inner: s.slice(start + 1), next: s.length }
}

/**
 * Parses one redirect operator's characters starting at `command[i]` — `c`
 * (`command[i]`) must be `<`, `>`, or `&` (the last only when
 * `command[i+1] === '>'`, i.e. `&>`/`&>>`). Recognizes every POSIX/Bash
 * redirect operator: `<`, `<<`, `<<-`, `<<<`, `<>`, `<&`, `>`, `>>`, `>|`,
 * `>&`, `&>`, `&>>` (SMI-6869 Fix A).
 * @param {string} command
 * @param {number} i
 * @returns {{ op: string, next: number }}
 */
function readRedirectOperator(command, i) {
  const c = command[i]
  if (c === '&') {
    if (command[i + 2] === '>') return { op: '&>>', next: i + 3 }
    return { op: '&>', next: i + 2 }
  }
  if (c === '<') {
    if (command[i + 1] === '<') {
      if (command[i + 2] === '<') return { op: '<<<', next: i + 3 }
      if (command[i + 2] === '-') return { op: '<<-', next: i + 3 }
      return { op: '<<', next: i + 2 }
    }
    if (command[i + 1] === '>') return { op: '<>', next: i + 2 }
    if (command[i + 1] === '&') return { op: '<&', next: i + 2 }
    return { op: '<', next: i + 1 }
  }
  // c === '>'
  if (command[i + 1] === '>') return { op: '>>', next: i + 2 }
  if (command[i + 1] === '|') return { op: '>|', next: i + 2 }
  if (command[i + 1] === '&') return { op: '>&', next: i + 2 }
  return { op: '>', next: i + 1 }
}

/**
 * Split a command string into word/operator tokens. Word tokens carry
 * their unquoted `value` plus any `$(...)` / backtick bodies in `subs`. A
 * redirect operator (and any target GLUED directly onto it, no space) is
 * ONE word token marked `redirect: true` (SMI-6869 Fix A) — consumers that
 * build argv from word tokens must exclude these; `findShellFedLiteralText`
 * deliberately does NOT, since it still needs to see a glued `<<<text`
 * shape. A SEPARATE (space-separated) target word is ALSO marked
 * `redirect: true` (SMI-6869 C1 correction): the token right after a bare
 * redirect op is tagged as its pending target and cleared on the next
 * op/newline — otherwise it became a bare argv[0] that bypassed
 * `NON_EXECUTING_VERBS` checks (`> ls ruflo memory store`). A heredoc
 * (`<<`/`<<-`) produces its own `{type: 'heredoc', ...}` token instead,
 * filled in at the next newline (SMI-6869 Fix B) — see
 * `shell-command-heredoc.mjs`.
 * @param {string} command
 */
export function tokenize(command) {
  const tokens = []
  const pendingHeredocs = []
  let cur = null
  let pendingRedirectToken = null
  let pendingRedirectOpText = ''
  const flush = () => {
    if (cur !== null) {
      tokens.push(cur)
      // A redirect operator token flushed with NOTHING glued onto it means
      // its target is the NEXT word (`> out cmd`), which is likewise not
      // part of the command's own argv.
      if (cur === pendingRedirectToken && cur.value === pendingRedirectOpText) {
        awaitingRedirectTarget = true
      }
    }
    cur = null
    pendingRedirectToken = null
  }
  let awaitingRedirectTarget = false
  const word = () => {
    if (cur === null) {
      cur = { type: 'word', value: '', subs: [] }
      if (awaitingRedirectTarget) {
        cur.redirect = true
        awaitingRedirectTarget = false
      }
    }
    return cur
  }
  const pushOp = (value, width, i) => {
    flush()
    awaitingRedirectTarget = false
    tokens.push({ type: 'op', value })
    return i + width
  }

  let i = 0
  // `parenKinds`: a stack of `{ kind, fnName, arith }` entries, one per
  // currently OPEN `(`, built by `classifyOpenParen`. Declared INSIDE
  // `tokenize`, so a guard that recurses into a `bash -c` body gets a fresh
  // stack per call and an input ending inside an open `(` cannot leak its
  // state into the next one. `closeParenIsBoundary` is the verdict from the
  // MOST RECENTLY closed `)` -- the only one a following `#` can ever need.
  // `arithDepth` counts open arithmetic `((` pairs, in which a `#` is not a
  // comment.
  const parenKinds = []
  let closeParenIsBoundary = false
  let arithDepth = 0
  // `prevChar`: the LOGICAL previous character the comment test reads, not
  // always raw `command[i - 1]` -- a removed `\`+newline continuation (see
  // the `\\` branch) must not change it to `\n`. Updated once per outer
  // iteration, except right after a removed continuation
  // (`skipPrevCharUpdate` suppresses that one update).
  let prevChar = ''
  let skipPrevCharUpdate = false
  while (i < command.length) {
    if (skipPrevCharUpdate) {
      skipPrevCharUpdate = false
    } else {
      prevChar = i === 0 ? '' : command[i - 1]
    }
    const c = command[i]
    if (c === '\\') {
      // `\` + newline is a LINE CONTINUATION: bash and zsh both REMOVE the
      // pair before word splitting (measured: `cat \<nl>f` reads `f`, the
      // command NAME can itself be split, and removal happens inside double
      // quotes too) -- appending the newline instead left a literal `\n`
      // INSIDE the word, a live read/ruflo-predicate bypass (the same
      // one-construct-two-representations class as the backtick and
      // `$'...'` fixes, ADR-172 sec 3). `skipPrevCharUpdate` keeps
      // `prevChar` at whatever preceded the backslash across the removal
      // (SMI-6892 round 16) -- without it, a comment-boundary char left by
      // the removed pair could misread a live `)`/word tail as a comment.
      if (command[i + 1] === '\n') {
        i += 2
        skipPrevCharUpdate = true
        continue
      }
      if (i + 1 < command.length) word().value += command[i + 1]
      i += 2
      continue
    }
    if (c === "'") {
      const e = command.indexOf("'", i + 1)
      word().value += e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
      i = e === -1 ? command.length : e + 1
      continue
    }
    if (c === '"') {
      const w = word()
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') {
          // A line continuation is removed inside double quotes too
          // (measured: `cat "probe\<nl>.txt"` reads `probe.txt`).
          if (command[j + 1] !== '\n' && j + 1 < command.length) w.value += command[j + 1]
          j += 2
        } else if (command[j] === '$' && command[j + 1] === '(') {
          const r = readParen(command, j + 1)
          w.subs.push(r.inner)
          w.value += command.slice(j, r.next)
          j = r.next
        } else if (command[j] === '`') {
          const e = command.indexOf('`', j + 1)
          const inner = e === -1 ? command.slice(j + 1) : command.slice(j + 1, e)
          w.subs.push(inner)
          w.value += '$(' + inner + ')'
          j = e === -1 ? command.length : e + 1
        } else {
          w.value += command[j]
          j++
        }
      }
      i = j < command.length ? j + 1 : command.length
      continue
    }
    if (c === '`') {
      const w = word()
      const e = command.indexOf('`', i + 1)
      const inner = e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
      w.subs.push(inner)
      w.value += '$(' + inner + ')'
      i = e === -1 ? command.length : e + 1
      continue
    }
    if (c === '$' && command[i + 1] === "'") {
      // ANSI-C quoting (H-6 fix, SMI-6744 Wave 4; broadened by the C1
      // delta-round fix): `$'...'` is a distinct Bash quoting form from a
      // plain `'...'` -- its body's own backslash escapes ARE processed, so
      // leaving them undecoded was a live literal-text bypass. The escape
      // table lives in the shared `decodeEscapeAt` (SMI-6744 C1 fix) -- see
      // that module's own docblock for the full table and the bash/zsh
      // divergence its "unrecognized escape" arm preserves. Dropping the
      // `$` and reusing the current word lets `$'text'` glued onto other
      // characters compose like a plain quoted segment already does.
      const w = word()
      let j = i + 2
      while (j < command.length && command[j] !== "'") {
        if (command[j] === '\\') {
          const r = decodeEscapeAt(command, j)
          w.value += r.value
          j = r.next
          continue
        }
        w.value += command[j]
        j++
      }
      i = j < command.length ? j + 1 : command.length
      continue
    }
    if ((c === '$' || c === '<' || c === '>') && command[i + 1] === '(') {
      const w = word()
      const r = readParen(command, i + 1)
      w.subs.push(r.inner)
      w.value += command.slice(i, r.next)
      i = r.next
      continue
    }
    // SMI-6869 Fix A: `&>`/`&>>` (redirect both stdout+stderr) — checked
    // before the plain `&` operator dispatch below, and before the `<`/`>`
    // branch (which handles every OTHER redirect form) since this one
    // starts with `&`, not `<`/`>`. No fd-prefix support here (real Bash
    // does not allow a leading digit on `&>`/`&>>` either) — always flush
    // whatever word was in progress.
    if (c === '&' && command[i + 1] === '>') {
      flush()
      const { op, next } = readRedirectOperator(command, i)
      cur = { type: 'word', value: op, subs: [], redirect: true }
      pendingRedirectToken = cur
      pendingRedirectOpText = op
      i = next
      continue
    }
    // SMI-6869 Fix A/B: every other redirect operator (`<`, `<<`, `<<-`,
    // `<<<`, `<>`, `<&`, `>`, `>>`, `>|`, `>&`) and the heredoc forms
    // (`<<`/`<<-`) they include. An unquoted `<`/`>` ends the current word
    // UNLESS that word is a bare digit sequence (a file-descriptor
    // redesignator, e.g. `2>`), in which case the digits stay attached to
    // the operator instead of becoming their own word token.
    if (c === '<' || c === '>') {
      let fdPrefix = ''
      if (cur !== null && cur.subs.length === 0 && /^[0-9]+$/.test(cur.value)) {
        fdPrefix = cur.value
        cur = null
      } else {
        flush()
      }
      const { op, next } = readRedirectOperator(command, i)
      if (op === '<<' || op === '<<-') {
        const dash = op === '<<-'
        const { delim, quoted, next: afterDelim } = parseHeredocDelimiter(command, next)
        const heredocToken = { type: 'heredoc', value: null, quoted, subs: [], delim, dash }
        tokens.push(heredocToken)
        pendingHeredocs.push(heredocToken)
        i = afterDelim
        continue
      }
      cur = { type: 'word', value: fdPrefix + op, subs: [], redirect: true }
      pendingRedirectToken = cur
      pendingRedirectOpText = fdPrefix + op
      i = next
      continue
    }
    if (c === '\n') {
      i = pushOp('\n', 1, i)
      // SMI-6869 Fix B: this newline ends the line that opened every
      // still-pending heredoc — consume their bodies now, before
      // tokenizing continues, so the body lines never get tokenized as
      // ordinary command text (the bug this fix exists to close).
      if (pendingHeredocs.length > 0) {
        i = consumeHeredocBodies(command, i, pendingHeredocs)
      }
      continue
    }
    if (/\s/.test(c)) {
      flush()
      i++
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      i = pushOp(two, 2, i)
      continue
    }
    // `|&` is shorthand for a pipe that also redirects stderr — treated
    // here as plain `|` (SMI-6869 Fix A): this guard's own segmentation
    // only needs to know a pipe boundary occurred, not the stderr detail.
    if (two === '|&') {
      i = pushOp('|', 2, i)
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '{' || c === '}') {
      i = pushOp(c, 1, i)
      continue
    }
    // `classifyOpenParen` decides command vs word position, the
    // function-definition mark, and whether this `(` is the inner half of
    // an arithmetic `((` -- see `shell-command-comment.mjs` for every
    // measured row behind those three.
    // Both paren op tokens carry `wordGroup`: true when the `(` was WORD
    // position, so a consumer can tell zsh's glob group `(.env|zzz)` -- ONE
    // word to the shell, whose `|` is not a pipe -- from a real subshell,
    // whose `|` is. `splitCommandSegmentsParensGrouping` needs exactly that.
    // `gluedLeft`/`gluedRight` record whether the group is WELDED to the word
    // on that side with no blank between, which is what makes the whole run
    // ONE zsh word: `./(node_modules|x)/.bin/ruflo` is a single path. A
    // consumer rebuilding that word needs the adjacency, since the tokens
    // alone cannot distinguish it from `./ (node_modules|x) /.bin/ruflo`
    // (SMI-6903 H1; `globGroupAlternativeReadings`).
    if (c === '(') {
      const last = cur !== null ? cur : tokens[tokens.length - 1]
      const entry = classifyOpenParen(last, tokens, cur, command[i - 1], parenKinds.length)
      parenKinds.push(entry)
      if (entry.arith) arithDepth++
      const gluedLeft = cur !== null
      i = pushOp(c, 1, i)
      tokens[tokens.length - 1].wordGroup = entry.kind === 'word'
      tokens[tokens.length - 1].gluedLeft = gluedLeft
      continue
    }
    if (c === ')') {
      const entry = parenKinds.pop()
      if (entry?.arith === true && arithDepth > 0) arithDepth--
      closeParenIsBoundary = closingParenIsBoundary(entry, command[i - 1])
      const after = command[i + 1]
      i = pushOp(c, 1, i)
      tokens[tokens.length - 1].wordGroup = entry !== undefined && entry.kind === 'word'
      tokens[tokens.length - 1].gluedRight = after !== undefined && !WORD_ENDING_RE.test(after)
      continue
    }
    // An unquoted `#` begins a comment -- discard through the next newline
    // (the `\n` branch above still emits that as its own `op` token) --
    // only where a real shell starts one. `startsComment` holds that whole
    // rule and the measured table behind it; a `#` not at a word boundary
    // (`a#b`, `${var#pattern}`, `http://x/#f`, `16#ff` inside `((…))`)
    // leaves `cur` non-null or fails the test, and is appended like any
    // other character.
    if (c === '#' && startsComment(cur, prevChar, closeParenIsBoundary, arithDepth)) {
      while (i < command.length && command[i] !== '\n') i++
      continue
    }
    word().value += c
    i++
  }
  flush()
  // SMI-6869 Fix B safety net: a heredoc whose introducing line has no
  // trailing newline at all (the delimiter word is the literal end of the
  // whole command string) never reaches the newline-triggered consumption
  // above — treat its body as empty rather than leaving `value: null`.
  if (pendingHeredocs.length > 0) {
    for (const token of pendingHeredocs) {
      token.value = ''
      token.subs = []
    }
    pendingHeredocs.length = 0
  }
  return tokens
}
