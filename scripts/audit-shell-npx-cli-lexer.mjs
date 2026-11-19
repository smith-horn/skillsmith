/**
 * Line lexer for audit-standards.mjs Check 59's shell scan (SMI-7223,
 * SMI-7226, SMI-7241).
 *
 * lexLine() returns the context in force at every index of a logical line
 * (command context, a quote kind, or arithmetic), plus every heredoc operator
 * in command context. The scan that consumes it, and the list of Known blind
 * spots, are in audit-shell-npx-cli-helpers.mjs.
 */

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
 * Lex one logical line. Returns { at, heredocs }: at[i] is the context in
 * force just before index i, as { q, openAt } where q is null (command
 * context), "'", '"', "$'" or 'arith', and openAt is where that context
 * opened. heredocs lists every heredoc operator in command context, in order.
 */
export function lexLine(line, { heredocBody = false } = {}) {
  // A heredoc body with an unquoted delimiter expands like "…" but has no
  // closing quote, so it starts in a "…" frame that a `"` never pops.
  const stack = heredocBody
    ? [{ kind: '"', close: null, openAt: -1, bodyAt: 0, depth: 0, cases: 0, sticky: true }]
    : [{ kind: 'cmd', close: null, openAt: -1, bodyAt: 0, depth: 0, cases: 0 }]
  const at = new Array(line.length + 1)
  const heredocs = []
  const pairs = new Map() // arithmeticCloses() cache for this line
  const top = () => stack[stack.length - 1]
  const push = (kind, close, openAt, bodyAt = openAt + 1) =>
    stack.push({ kind, close, openAt, bodyAt, depth: 0, cases: 0 })
  const mark = (from, to) => {
    const t = top()
    const st = { q: t.kind === 'cmd' ? null : t.kind, openAt: t.openAt }
    for (let k = from; k < to && k <= line.length; k++) at[k] = st
  }
  let i = 0
  while (i < line.length) {
    const t = top()
    const c = line[i]
    const next = line[i + 1]
    mark(i, i + 1)
    if (t.kind === "'") {
      if (c === "'") stack.pop()
      i++
    } else if (t.kind === "$'") {
      if (c === '\\') {
        mark(i + 1, i + 2)
        i += 2
      } else {
        if (c === "'") stack.pop()
        i++
      }
    } else if (t.kind === '"') {
      if (c === '\\') {
        mark(i + 1, i + 2)
        i += 2
      } else if (c === '"') {
        if (!t.sticky) stack.pop()
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
        stack.pop()
        i += 2
      } else if (c === ')' && t.depth > 0) {
        t.depth--
        i++
      } else if (t.close === ']' && c === ']') {
        stack.pop()
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
      } else if (c === '$' && next === "'") {
        push("$'", "'", i + 1)
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
        if (t.close === '`') stack.pop()
        else push('cmd', '`', i)
        i++
      } else if (c === '(') {
        t.depth++
        i++
      } else if (c === ')') {
        if (t.depth > 0) t.depth--
        else if (t.cases > 0) {
          // a case pattern's closing paren
        } else if (t.close === ')') stack.pop()
        i++
      } else if (c === '<' && next === '<') {
        HEREDOC_AT.lastIndex = i
        const m = HEREDOC_AT.exec(line)
        if (m) {
          heredocs.push({
            dash: m[1] === '-',
            tag: heredocTag(m[2]),
            expands: !/['"\\]/.test(m[2]),
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
  mark(line.length, line.length + 1)
  return { at, heredocs }
}
