/**
 * Word rebuilding for Check 59's shell sub-check (SMI-7241).
 *
 * Bash joins adjacent parts into one word: '…', "…", $'…' (ANSI-C decoded),
 * $"…", bare text with backslash escapes, and expansions ($x, ${…}, $(…),
 * backticks, $((…)), $[…]). readWords() rebuilds every word in command
 * context on one logical line, taking each expansion as empty, and decides
 * which heredoc operators feed a shell that reads its script from stdin.
 *
 * It reads the lexer's match table (lexLine's `frames`), so a quote or
 * substitution is jumped in O(1) and every character is visited a bounded
 * number of times. Command substitutions are walked from a work list, not by
 * recursion, so nesting depth costs no stack.
 */

import { decodeAnsiC, SQ, ANSI, DQ, CMD, ARITH } from './audit-shell-npx-cli-lexer.mjs'

const SPACE = /\s/
const OP_CHARS = ';&|<>()'
// Longest first. `<<` heredocs are matched from the lexer's records first.
const OPS = ['&>>', ';;&', '&&', '||', '|&', ';;', ';&', '&>', '>&', '<&', '>>', '>|', '<>', '<<<']
const REDIRECTS = new Set(['<', '>', '>>', '>|', '<>', '<&', '>&', '&>', '&>>', '<<<'])
const PIPES = new Set(['|', '|&'])
const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/
const SPECIAL_PARAM = '@*#?$!-0123456789'

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'elif', 'else', 'do', 'while', 'until'])
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'exec',
  'command',
  'builtin',
  'nice',
  'nohup',
  'time',
  'stdbuf',
  'timeout',
  'setsid',
  'ionice',
  'flock',
])
const SHELL = /^(?:ba|z|da|k)?sh$/
// A script operand that is the shell's own stdin.
const STDIN_PATHS = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
// Builtins that run the builtin named after them (`command source`, `builtin .`).
const BUILTIN_RUNNERS = new Set(['command', 'builtin'])
const basename = (w) => w.slice(w.lastIndexOf('/') + 1)

/**
 * Rebuild the words of one logical line. `code` is the line (trailing
 * comment removed), `lexed` is lexLine(code, { heredocBody }). In a heredoc
 * body only the command substitutions hold commands, so only their words are
 * read. Returns { words, fed }: words is [{ start, end, value, changed,
 * quoted, subst, closed }] in no particular order (`changed`: the value
 * differs from the raw text; `quoted`: a quote or backslash took part;
 * `subst`: an unquoted command substitution or arithmetic took part; `closed`: every
 * frame in the word closed on this line); fed[k] is true when lexed.heredocs[k]
 * feeds a shell reading stdin. `groups` is the stack of `( … )` groups still
 * open at the start of the line (see walk); the line's top-level walk updates
 * it in place, so a caller passing one stack to every logical line of a text
 * lets a group opened on one line close on a later one.
 */
export function readWords(code, lexed, { heredocBody = false, groups = [] } = {}) {
  const { kind, body, close, end } = lexed.frames
  const n = code.length
  const hdAt = new Map(lexed.heredocs.map((h, k) => [h.at, k]))
  const fed = lexed.heredocs.map(() => false)
  const words = []
  const work = [] // [from, to) ranges holding commands
  let closed = true // reset per word

  // Every command substitution inside [from, to), which holds no commands of
  // its own ("…" body, arithmetic, ${…} body): queue it. Quotes are jumped.
  const queueSubsIn = (from, to) => {
    let j = from
    while (j < to) {
      const k = kind[j]
      if (k === CMD) {
        if (close[j] >= n) closed = false
        work.push([body[j], close[j]])
        j = end[j]
      } else if (k === SQ || k === ANSI) {
        if (close[j] >= n) closed = false
        j = end[j]
      } else if (k === DQ || k === ARITH) {
        if (close[j] >= n) closed = false
        j = body[j] // walk on through the body; its close is stepped over
      } else j += code[j] === '\\' ? 2 : 1
    }
  }

  // ${…} starting at i: returns the index after its `}` (or `to`).
  const skipBrace = (i, to) => {
    let depth = 1
    let j = i + 2
    while (j < to) {
      const k = kind[j]
      if (k === CMD) {
        work.push([body[j], close[j]])
        j = end[j]
      } else if (k === SQ || k === ANSI) j = end[j]
      else if (k === DQ || k === ARITH) {
        queueSubsIn(body[j], close[j])
        j = end[j]
      } else if (code[j] === '\\') j += 2
      else if (code[j] === '$' && code[j + 1] === '{') {
        depth++
        j += 2
      } else if (code[j] === '}') {
        j++
        if (--depth === 0) return j
      } else j++
    }
    closed = false
    return to
  }

  // $name, $1, $@ …: the index after it, or -1 when `$` is literal.
  const paramEnd = (i) => {
    const c = code[i + 1]
    if (c !== undefined && NAME_START.test(c)) {
      let j = i + 2
      while (j < n && NAME_CHAR.test(code[j])) j++
      return j
    }
    return c !== undefined && SPECIAL_PARAM.includes(c) ? i + 2 : -1
  }

  // The static value of a "…" body [from, to).
  const dqValue = (from, to) => {
    let v = ''
    let j = from
    while (j < to) {
      const c = code[j]
      const k = kind[j]
      if (c === '\\' && j + 1 < to && '$`"\\'.includes(code[j + 1])) {
        v += code[j + 1]
        j += 2
      } else if (k === CMD) {
        if (close[j] >= n) closed = false
        work.push([body[j], close[j]])
        j = end[j]
      } else if (k === ARITH) {
        queueSubsIn(body[j], close[j])
        j = end[j]
      } else if (c === '$' && code[j + 1] === '{') j = skipBrace(j, to)
      else if (c === '$' && paramEnd(j) !== -1) j = paramEnd(j)
      else {
        v += c
        j++
      }
    }
    return v
  }

  // One word from i (not space, not an operator) inside a range ending at to.
  const readWord = (i, to) => {
    const start = i
    let v = ''
    let quoted = false
    let subst = false // an unquoted $(…), backtick or arithmetic took part
    closed = true
    while (i < to) {
      const c = code[i]
      if (SPACE.test(c) || OP_CHARS.includes(c)) break
      const k = kind[i]
      if (k === SQ) {
        v += code.slice(body[i], close[i])
        quoted = true
      } else if (k === ANSI) {
        v += decodeAnsiC(code.slice(body[i], close[i]))
        quoted = true
      } else if (k === DQ) {
        v += dqValue(body[i], close[i])
        quoted = true
      } else if (k === CMD) {
        work.push([body[i], close[i]])
        subst = true
      } else if (k === ARITH) {
        queueSubsIn(body[i], close[i])
        subst = true
      } else if (c === '\\') {
        quoted = true
        v += i + 1 < to ? code[i + 1] : '\\'
        i += i + 1 < to ? 2 : 1
        continue
      } else if (c === '$' && code[i + 1] === '{') {
        i = skipBrace(i, to)
        continue
      } else if (c === '$' && paramEnd(i) !== -1) {
        i = paramEnd(i)
        continue
      } else {
        v += c
        i++
        continue
      }
      if (close[i] >= n) closed = false
      i = end[i]
    }
    const raw = code.slice(start, i)
    return { start, end: i, value: v, changed: raw !== v, quoted, subst, closed }
  }

  // The digits-only word written directly against the operator at `opAt`,
  // which is its fd, or null. Removed from the command's words when found.
  const takeFd = (cmd, opAt) => {
    const last = cmd.words[cmd.words.length - 1]
    if (!last || last.end !== opAt || !/^\d+$/.test(code.slice(last.start, opAt))) return null
    cmd.words.pop()
    return Number(last.value)
  }

  // Walk one command range, collecting words and the simple commands of each
  // pipeline, for the heredoc decision. `groups` holds, for each `(` still
  // open, the simple commands started inside it (every pipeline stage among
  // them); the command that follows its `)` records whether any of them
  // reads stdin, so a heredoc redirected onto the group (`( bash ) <<EOF`,
  // `( cat | bash ) <<EOF`) is fed when one does. A command with a heredoc
  // of its own reads that, not the group's stdin. The top-level range shares
  // the caller's stack across lines; a command substitution starts empty.
  const walk = (from, to, groups) => {
    const newCmd = () => {
      const c = { words: [], hds: [], groupReads: false }
      if (groups.length > 0) groups[groups.length - 1].push(c)
      return c
    }
    let cmd = newCmd()
    let stages = [cmd]
    let target = false // the next word is a redirection target
    const endPipeline = () => {
      if (stages.some((s) => s.hds.length > 0)) markFed(stages)
      cmd = newCmd()
      stages = [cmd]
    }
    let i = from
    while (i < to) {
      const c = code[i]
      if (SPACE.test(c)) {
        i++
        continue
      }
      // A word starting with # is a comment: decoded text, or raw text the
      // trailing-comment cut misses (`echo a;#'np''x' supabase status`).
      if (c === '#') break
      if (hdAt.has(i)) {
        // A digits-only word against the operator is its fd: only fd 0 (or
        // none) is the command's stdin.
        const k = hdAt.get(i)
        if ((takeFd(cmd, i) ?? 0) === 0) cmd.hds.push(k)
        i = lexed.heredocs[k].end
        continue
      }
      if (c === '(' && kind[i] === ARITH) {
        queueSubsIn(body[i], close[i])
        i = end[i]
        continue
      }
      if (OP_CHARS.includes(c)) {
        const op = OPS.find((o) => code.startsWith(o, i)) ?? c
        i += op.length
        if (op === '(' || op === ')') {
          // Grouping ends the simple command but not the pipeline: a case
          // pattern, a function header or a subshell starts a new one. A `)`
          // with no open `(` (a case pattern) closes no group.
          const inside = op === ')' && groups.length > 0 ? groups.pop() : null
          if (op === '(') groups.push([])
          cmd = newCmd()
          cmd.groupReads =
            inside !== null && inside.some((m) => m.hds.length === 0 && readsStdin(m))
          stages.push(cmd)
          continue
        }
        if (REDIRECTS.has(op)) {
          takeFd(cmd, i - op.length)
          target = true
        } else if (PIPES.has(op)) {
          cmd = newCmd()
          stages.push(cmd)
        } else endPipeline()
        continue
      }
      const w = readWord(i, to)
      words.push(w)
      if (target) target = false
      else cmd.words.push(w)
      i = w.end > i ? w.end : i + 1
    }
    endPipeline()
  }

  const markFed = (stages) => {
    // A heredoc is fed when its own stage, or any later stage of the same
    // pipeline, is a shell reading stdin: one pass from the end.
    let later = false
    for (let s = stages.length - 1; s >= 0; s--) {
      later = later || readsStdin(stages[s])
      for (const k of stages[s].hds) fed[k] = later
    }
  }

  // A stage reads its script from stdin itself or, when it is the bare
  // redirection target of a `( … )` group, through any command inside the
  // group, nested groups included (groupReads, set once when the group
  // closes). Over-approximate: a command earlier in the group could consume
  // stdin first (`( cat; bash ) <<EOF`, `( true | bash ) <<EOF`).
  const readsStdin = (c) => readsStdinScript(c.words) || (c.words.length === 0 && c.groupReads)

  if (heredocBody) queueSubsIn(0, n)
  else work.push([0, n, groups])
  while (work.length > 0) {
    const [from, to, open = []] = work.pop()
    walk(from, to, open)
  }
  return { words, fed }
}

/**
 * Does this simple command run a shell that reads its script from stdin?
 * The command word (after assignments and reserved words) is a shell, or a
 * wrapper (sudo, env, exec, …) followed somewhere by a shell; the shell has
 * no -c flag (a c in a `+` bundle is -c too, and a lone `+` is a flag, as
 * bash 5.2 reads them), and either has -s or takes no operand, or its operand is
 * /dev/stdin (any other operand would be a script file). Every o or O in a
 * flag bundle takes the next word as its value, as bash reads `-euo pipefail`
 * and `-oe pipefail`. `source /dev/stdin` and `. /dev/stdin` read stdin too,
 * also behind `command` or `builtin` (with their options).
 */
export function readsStdinScript(words) {
  let k = 0
  while (k < words.length && (ASSIGNMENT.test(words[k].value) || RESERVED.has(words[k].value))) k++
  if (k >= words.length) return false
  let s = k
  while (s < words.length && BUILTIN_RUNNERS.has(words[s].value)) {
    s++
    while (s < words.length && words[s].value.startsWith('-')) s++
  }
  if (s < words.length && (words[s].value === 'source' || words[s].value === '.')) {
    const op = words[s + 1]?.value === '--' ? words[s + 2] : words[s + 1]
    return op !== undefined && STDIN_PATHS.has(op.value)
  }
  if (!SHELL.test(basename(words[k].value))) {
    if (!WRAPPERS.has(basename(words[k].value))) return false
    do k++
    while (k < words.length && !SHELL.test(basename(words[k].value)))
    if (k >= words.length) return false
  }
  let stdin = false
  for (let j = k + 1; j < words.length; j++) {
    const w = words[j].value
    if (w === '--' || w === '-') {
      return stdin || j === words.length - 1 || STDIN_PATHS.has(words[j + 1].value)
    }
    if (w === '--rcfile' || w === '--init-file') j++
    else if (w.startsWith('--')) continue
    else if (/^[-+][A-Za-z]*$/.test(w)) {
      if (w.includes('c')) return false
      if (w.includes('s')) stdin = true
      j += w.length - w.replace(/[oO]/g, '').length
    } else return stdin || STDIN_PATHS.has(w)
  }
  return true
}
