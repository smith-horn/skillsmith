/**
 * Line lexer for Check 59's shell sub-check (SMI-7223, SMI-7226, SMI-7241).
 * Used by audit-shell-npx-cli-helpers.mjs and audit-shell-npx-cli-words.mjs.
 *
 * lexLine() walks one logical line once with a context stack: quotes ('…',
 * "…", $'…', $"…"), command substitution ($(…) and backticks, including inside
 * "…"), arithmetic ($((…)), ((…)), $[…]) and case…esac, so a pattern's `)`
 * does not close a substitution. Besides the per-index context it records
 * every frame it opens (a match table: opening -> body start, closing index,
 * end), so a later reader can jump over a quote or substitution without
 * rescanning it, and every heredoc operator in command context.
 *
 * decodeAnsiC() decodes the body of a $'…' string as bash 5.2 does.
 */

// Frame kinds in the match table. 0 means no frame opens at that index.
export const SQ = 1 // '…'
export const ANSI = 2 // $'…'
export const DQ = 3 // "…" and $"…"
export const CMD = 4 // $(…) and `…`
export const ARITH = 5 // $((…)), ((…)), $[…]
const KIND = { "'": SQ, "$'": ANSI, '"': DQ, cmd: CMD, arith: ARITH }

// A heredoc operator at the lexer's position; group 2 is the delimiter word,
// which may mix quoted, backslashed and bare parts (`END-OF`, `'EOF'`, `\EOF`).
// Sticky, so it is tried only at the first `<`: in a here-string `<<<word`
// the third `<` cannot start a word, and the scan moves past the operator.
const HEREDOC_AT = /<<(-?)\s*((?:'[^']*'|"[^"]*"|\\.|[^\s;&|<>()'"\\])+)/y
const WORD_BREAK = /[\s;&|()]/

function wordAt(line, i, word) {
  return (
    line.startsWith(word, i) &&
    (i === 0 || WORD_BREAK.test(line[i - 1])) &&
    (i + word.length === line.length || WORD_BREAK.test(line[i + word.length]))
  )
}

// Is `i` in command (keyword) position within frame `t`? True after only
// whitespace since the frame's start, after ; & | ( { ! , or after one of
// these words; inside a case, also after a pattern's `)` (a nested case). It
// looks back over whitespace only, so a line of many `case` words costs one
// pass; slicing from the frame start each time made it quadratic.
const KEYWORDS = ['then', 'do', 'else', 'elif', 'if', 'while', 'until', 'in']
const SPACE_CHAR = /\s/
const WORD_CHAR = /\w/

function inKeywordPosition(line, t, i) {
  let j = i
  while (j > t.bodyAt && SPACE_CHAR.test(line[j - 1])) j--
  if (j === t.bodyAt) return true
  const c = line[j - 1]
  if (';&|({!'.includes(c)) return true
  if (c === ')') return t.cases > 0
  return KEYWORDS.some((k) => {
    const s = j - k.length
    return (
      s >= t.bodyAt && line.startsWith(k, s) && (s === t.bodyAt || !WORD_CHAR.test(line[s - 1]))
    )
  })
}

/** The delimiter a heredoc word stands for: its quotes and backslashes removed. */
function heredocTag(word) {
  return word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_, a, b, c) => a ?? b ?? c)
}

/**
 * Bash reads `$((` / `((` as arithmetic only when the outer paren closes as
 * `))`; otherwise it is a substitution or subshell holding a subshell.
 * `from` is the index just past the opening `((`, so the inner paren is at
 * from - 1. Returns true for arithmetic. When no close is found on the line it
 * returns false, so the text is lexed as commands and an invocation there is
 * still seen. `pairs` (one Map per line) caches every paren this scan matches,
 * open index -> close index or -1 for unclosed, so a later opener inside an
 * already-scanned span is answered without rescanning: the line costs about
 * one pass however many openers it holds.
 */
function arithmeticCloses(line, from, pairs) {
  const inner = from - 1
  const known = pairs.get(inner)
  if (known !== undefined) return known !== -1 && line[known + 1] === ')'
  const open = [inner]
  for (let j = from; j < line.length; j++) {
    const c = line[j]
    if (c === '\\') j++
    else if (c === "'" || c === '"') {
      const end = line.indexOf(c, j + 1)
      if (end === -1) break
      j = end
    } else if (c === '(') {
      const close = pairs.get(j)
      if (close === undefined) open.push(j)
      else if (close === -1) break
      else j = close
    } else if (c === ')') {
      const at = open.pop()
      pairs.set(at, j)
      if (at === inner) return line[j + 1] === ')'
    }
  }
  for (const at of open) pairs.set(at, -1)
  return false
}

/**
 * Lex one logical line. Returns { at, heredocs, frames }:
 * - at[i] is the context just before index i, as { q, openAt }: q is null
 *   (command context), "'", '"', "$'" or 'arith'; openAt is where it opened.
 * - heredocs lists every heredoc operator in command context, in order, as
 *   { dash, tag, expands, at, end } (`at`..`end` is the operator and word).
 * - frames is the match table: kind[k] (SQ, ANSI, DQ, CMD, ARITH or 0) for a
 *   frame opening at k, body[k] its first body index, close[k] the index of
 *   its closing character and end[k] the index after the close. An unclosed
 *   frame has close and end equal to the line's length.
 */
export function lexLine(line, { heredocBody = false } = {}) {
  const n = line.length
  // A heredoc body with an unquoted delimiter expands like "…" but has no
  // closing quote, so it starts in a "…" frame that a `"` never pops.
  const stack = heredocBody
    ? [{ kind: '"', close: null, openAt: -1, bodyAt: 0, depth: 0, cases: 0, sticky: true }]
    : [{ kind: 'cmd', close: null, openAt: -1, bodyAt: 0, depth: 0, cases: 0 }]
  const at = new Array(n + 1)
  const heredocs = []
  const frames = {
    kind: new Uint8Array(n + 1),
    body: new Int32Array(n + 1),
    close: new Int32Array(n + 1),
    end: new Int32Array(n + 1),
  }
  const pairs = new Map()
  const top = () => stack[stack.length - 1]
  const push = (kind, close, openAt, bodyAt = openAt + 1) => {
    stack.push({ kind, close, openAt, bodyAt, depth: 0, cases: 0 })
    frames.kind[openAt] = KIND[kind]
    frames.body[openAt] = bodyAt
    frames.close[openAt] = n
    frames.end[openAt] = n
  }
  // Pop the top frame, whose closing text is line[closeAt .. endAt).
  const pop = (closeAt, endAt) => {
    const f = stack.pop()
    frames.close[f.openAt] = closeAt
    frames.end[f.openAt] = endAt
  }
  const mark = (from, to) => {
    const t = top()
    const st = { q: t.kind === 'cmd' ? null : t.kind, openAt: t.openAt }
    for (let k = from; k < to && k <= n; k++) at[k] = st
  }
  let i = 0
  while (i < n) {
    const t = top()
    const c = line[i]
    const next = line[i + 1]
    mark(i, i + 1)
    if (t.kind === "'") {
      if (c === "'") pop(i, i + 1)
      i++
    } else if (t.kind === "$'") {
      if (c === '\\') {
        mark(i + 1, i + 2)
        i += 2
      } else {
        if (c === "'") pop(i, i + 1)
        i++
      }
    } else if (t.kind === '"') {
      if (c === '\\') {
        mark(i + 1, i + 2)
        i += 2
      } else if (c === '"') {
        if (!t.sticky) pop(i, i + 1)
        i++
      } else if (
        c === '$' &&
        next === '(' &&
        line[i + 2] === '(' &&
        arithmeticCloses(line, i + 3, pairs)
      ) {
        push('arith', '))', i)
        i += 3
      } else if (c === '$' && next === '(') {
        push('cmd', ')', i, i + 2)
        i += 2
      } else if (c === '$' && next === '[') {
        push('arith', ']', i)
        i += 2
      } else if (c === '`') {
        push('cmd', '`', i)
        i++
      } else {
        i++
      }
    } else if (t.kind === 'arith') {
      if (c === '$' && next === '(' && line[i + 2] !== '(') {
        push('cmd', ')', i, i + 2)
        i += 2
      } else if (c === '(') {
        t.depth++
        i++
      } else if (t.close === '))' && c === ')' && t.depth === 0 && next === ')') {
        mark(i + 1, i + 2)
        pop(i, i + 2)
        i += 2
      } else if (c === ')' && t.depth > 0) {
        t.depth--
        i++
      } else if (t.close === ']' && c === ']') {
        pop(i, i + 1)
        i++
      } else {
        i++
      }
    } else {
      // command context
      if (c === '\\') {
        mark(i + 1, i + 2)
        i += 2
      } else if (c === "'") {
        push("'", "'", i)
        i++
      } else if (c === '$' && (next === "'" || next === '"')) {
        // SMI-7241 B.3 steps 1-2: the quote after `$` keeps the outer
        // context (marked before the push), and the frame opens at the `$`,
        // so endsInShC tests the text before it. $"…" is an ordinary "…".
        mark(i + 1, i + 2)
        push(next === "'" ? "$'" : '"', next, i, i + 2)
        i += 2
      } else if (c === '"') {
        push('"', '"', i)
        i++
      } else if (
        c === '$' &&
        next === '(' &&
        line[i + 2] === '(' &&
        arithmeticCloses(line, i + 3, pairs)
      ) {
        push('arith', '))', i)
        i += 3
      } else if (c === '$' && next === '(') {
        push('cmd', ')', i, i + 2)
        i += 2
      } else if (c === '$' && next === '[') {
        push('arith', ']', i)
        i += 2
      } else if (c === '(' && next === '(' && arithmeticCloses(line, i + 2, pairs)) {
        push('arith', '))', i)
        i += 2
      } else if (c === '`') {
        if (t.close === '`') pop(i, i + 1)
        else push('cmd', '`', i)
        i++
      } else if (c === '(') {
        t.depth++
        i++
      } else if (c === ')') {
        if (t.depth > 0) t.depth--
        else if (t.cases > 0) {
          // a case pattern's closing paren
        } else if (t.close === ')') pop(i, i + 1)
        i++
      } else if (c === '<' && next === '<') {
        HEREDOC_AT.lastIndex = i
        const m = HEREDOC_AT.exec(line)
        if (m) {
          heredocs.push({
            dash: m[1] === '-',
            tag: heredocTag(m[2]),
            expands: !/['"\\]/.test(m[2]),
            at: i,
            end: i + m[0].length,
          })
          mark(i, i + m[0].length)
          i += m[0].length
        } else {
          i += 2
        }
      } else if (wordAt(line, i, 'case') && inKeywordPosition(line, t, i)) {
        t.cases++
        mark(i, i + 4)
        i += 4
      } else if (wordAt(line, i, 'esac') && inKeywordPosition(line, t, i)) {
        if (t.cases > 0) t.cases--
        mark(i, i + 4)
        i += 4
      } else {
        i++
      }
    }
  }
  mark(n, n + 1)
  return { at, heredocs, frames }
}

// --- ANSI-C ($'…') decoding, after bash 5.2's ansicstr() -------------------

const SIMPLE = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
}
const OCT = /[0-7]{1,3}/y
const HEX2 = /[0-9A-Fa-f]{1,2}/y
const HEX4 = /[0-9A-Fa-f]{1,4}/y
const HEX8 = /[0-9A-Fa-f]{1,8}/y

function take(re, s, at) {
  re.lastIndex = at
  const m = re.exec(s)
  return m ? m[0] : null
}

/**
 * Decode the body of a $'…' string (the text between `$'` and `'`). The
 * simple escapes, octal of one to three digits masked to a byte, `\x` with one
 * or two hex digits, `\u` up to four, `\U` up to eight, `\cX` (`\c?` is DEL);
 * an unknown escape keeps its backslash; the string ends at a NUL. Linear: the
 * NUL test looks only at the character just produced.
 */
export function decodeAnsiC(body) {
  const out = []
  let i = 0
  while (i < body.length) {
    const c = body[i]
    let ch
    if (c !== '\\' || i + 1 >= body.length) {
      ch = c
      i++
    } else {
      const n = body[i + 1]
      let d
      if (Object.hasOwn(SIMPLE, n)) {
        ch = SIMPLE[n]
        i += 2
      } else if ((d = take(OCT, body, i + 1))) {
        ch = String.fromCharCode(parseInt(d, 8) & 0xff)
        i += 1 + d.length
      } else if (n === 'x' && (d = take(HEX2, body, i + 2))) {
        ch = String.fromCharCode(parseInt(d, 16))
        i += 2 + d.length
      } else if (n === 'u' && (d = take(HEX4, body, i + 2))) {
        ch = String.fromCodePoint(parseInt(d, 16))
        i += 2 + d.length
      } else if (n === 'U' && (d = take(HEX8, body, i + 2))) {
        const cp = parseInt(d, 16)
        ch = cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd'
        i += 2 + d.length
      } else if (n === 'c' && i + 2 < body.length) {
        const x = body[i + 2]
        ch = x === '?' ? '\x7f' : String.fromCharCode(x.toUpperCase().charCodeAt(0) & 0x1f)
        i += 3
      } else {
        ch = c
        i++
      }
    }
    if (ch === '\0') break // bash strings end at NUL
    out.push(ch)
  }
  return out.join('')
}
