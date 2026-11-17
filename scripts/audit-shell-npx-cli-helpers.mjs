/**
 * Helpers for audit-standards.mjs Check 59, shell sub-check (SMI-7223, SMI-7226).
 *
 * Flags a bare `npx supabase` / `npx wrangler` invocation in a tracked shell
 * script, workflow or composite action. With no local package, npx downloads
 * registry-latest and ignores any pinned binary on PATH, which is how
 * SMI-7223's deploy outage happened. See
 * docs/internal/implementation/smi-7223-deploy-pinned-supabase-cli.md.
 *
 * This is a line lexer, not a shell parser. It joins backslash continuations
 * as bash does (the backslash-newline is deleted), skips comments and heredoc
 * bodies, and walks each logical line once with a context stack: quotes ('…',
 * "…", $'…'), command substitution ($(…) and backticks, including inside
 * "…"), arithmetic ($((…)), ((…)), $[…]) and case…esac, so a pattern's `)`
 * does not close a substitution. An `npx … <tool>` in command context counts
 * as an invocation whatever precedes it; inside quotes it counts only as the
 * argument of `sh -c` (bundled flags such as `-lc` included). A tool pinned to
 * an exact x.y.z version is not flagged; `@latest` or `@3` is. In a workflow
 * or action file, each `run:` value (plain, quoted or block) is decoded with
 * js-yaml and scanned as the command it holds. Known blind spots, by design:
 * npx built from a variable, eval, a tool name in a variable, a quoted string
 * passed to another interpreter (ssh, docker exec), npx flags that take a
 * value other than those listed in NPX_VALUE_FLAGS, and a substitution or
 * quote left open across lines.
 */

import { execFileSync } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

const yaml = createRequire(import.meta.url)('js-yaml')

const TOOLS = ['supabase', 'wrangler']

// npx flags whose value is a separate word.
const NPX_VALUE_FLAGS = '--prefix|--cache|--registry|--userconfig|--workspace|-w'
// `npx` as a bare word or a quoted command word ("npx" / 'npx'), then
// optional flags, then a watched tool, bare or quoted, with an optional
// @version (group 3 is the tool, group 4 the version).
const HIT = new RegExp(
  String.raw`(?:(?<![\w.-])npx|(["'])npx\1)\s+(?:(?:${NPX_VALUE_FLAGS})(?:=|\s+)\S+\s+|--?[A-Za-z-]+(?:=\S+)?\s+)*(["']?)(${TOOLS.join('|')})(@[^\s"']+)?\2(?![A-Za-z0-9@_-])`,
  'g'
)
// An exact pin: npx runs that version, not registry-latest.
const EXACT_VERSION = /^@\d+\.\d+\.\d+$/
// `sh -c` and its relatives, with -c possibly bundled (-lc, -ec) and
// `-o <option>` allowed before it.
const SH_C = /(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+(?:(?:-o\s+\S+|-\S+)\s+)*-[A-Za-z]*c\s*$/
// A heredoc operator at the lexer's position; group 2 is the delimiter word,
// which may mix quoted, backslashed and bare parts (`END-OF`, `'EOF'`, `\EOF`).
// Sticky, so it is tried only at the first `<`: in a here-string `<<<word`
// the third `<` cannot start a word, and the scan moves past the operator.
const HEREDOC_AT = /<<(-?)\s*((?:'[^']*'|"[^"]*"|\\.|[^\s;&|<>()'"\\])+)/y
// A workflow or action `run:` key; group 1 is its indentation and list dash.
const YAML_RUN = /^(\s*(?:-\s+)?)run:(\s.*|)$/
const WORD_BREAK = /[\s;&|()]/

function wordAt(line, i, word) {
  return (
    line.startsWith(word, i) &&
    (i === 0 || WORD_BREAK.test(line[i - 1])) &&
    (i + word.length === line.length || WORD_BREAK.test(line[i + word.length]))
  )
}

// Preceding text that leaves the lexer in command (keyword) position.
const KEYWORD_POSITION = /(?:^|[;&|({!]|\b(?:then|do|else|elif|if|while|until|in)\b)\s*$/
// Inside a case, a pattern's `)` also leaves command position (a nested case).
const AFTER_PATTERN = /\)\s*$/

function inKeywordPosition(line, t, i) {
  const before = line.slice(t.bodyAt, i)
  return KEYWORD_POSITION.test(before) || (t.cases > 0 && AFTER_PATTERN.test(before))
}

/** The delimiter a heredoc word stands for: its quotes and backslashes removed. */
function heredocTag(word) {
  return word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_, a, b, c) => a ?? b ?? c)
}

/**
 * Bash reads `$((` / `((` as arithmetic only when the outer paren closes as
 * `))`; otherwise it is a substitution or subshell holding a subshell.
 * `from` is the index just past the opening `((`. Returns true for
 * arithmetic. When no close is found on the line it returns false, so the
 * text is lexed as commands and an invocation there is still seen.
 */
function arithmeticCloses(line, from) {
  let depth = 0
  for (let j = from; j < line.length; j++) {
    const c = line[j]
    if (c === '\\') j++
    else if (c === "'" || c === '"') {
      const end = line.indexOf(c, j + 1)
      if (end === -1) return false
      j = end
    } else if (c === '(') depth++
    else if (c === ')') {
      if (depth > 0) depth--
      else return line[j + 1] === ')'
    }
  }
  return false
}

/**
 * Lex one logical line. Returns { at, heredocs }: at[i] is the context in
 * force just before index i, as { q, openAt } where q is null (command
 * context), "'", '"', "$'" or 'arith', and openAt is where that context
 * opened. heredocs lists every heredoc operator in command context, in order.
 */
export function lexLine(line) {
  const stack = [{ kind: 'cmd', close: null, openAt: -1, bodyAt: 0, depth: 0, cases: 0 }]
  const at = new Array(line.length + 1)
  const heredocs = []
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
        stack.pop()
        i++
      } else if (
        c === '$' &&
        next === '(' &&
        line[i + 2] === '(' &&
        arithmeticCloses(line, i + 3)
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
        arithmeticCloses(line, i + 3)
      ) {
        push('arith', '))', i)
        i += 3
      } else if (c === '$' && next === '(') {
        push('cmd', ')', i, i + 2)
        i += 2
      } else if (c === '$' && next === '[') {
        push('arith', ']', i)
        i += 2
      } else if (c === '(' && next === '(' && arithmeticCloses(line, i + 2)) {
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
          heredocs.push({ dash: m[1] === '-', tag: heredocTag(m[2]) })
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

/** Context just before `idx`: { q, openAt }. q is null in command context. */
export function quoteStateAt(line, idx) {
  return lexLine(line).at[idx] ?? { q: null, openAt: -1 }
}

function trailingCommentIndex(line, at) {
  const re = /(?:^|\s)#/g
  let m
  while ((m = re.exec(line)) !== null) {
    const pos = m.index + m[0].length - 1
    if (at[pos].q === null) return pos
  }
  return -1
}

/**
 * Decode the `run:` value starting at raw[i] (plain, quoted or block scalar).
 * The value runs to the first non-blank line indented no deeper than the
 * `run:` key. Returns { command, consumed, literal } or null when the key has
 * no string value or js-yaml rejects it; the caller then scans the lines as
 * plain text. `literal` is true for a `|` block, whose decoded lines map one
 * to one onto the physical lines after the key.
 */
function decodeYamlRun(raw, i) {
  const m = raw[i].match(YAML_RUN)
  if (!m) return null
  const keyCol = m[1].length
  const indent = (l) => l.length - l.trimStart().length
  let n = 1
  while (i + n < raw.length && (raw[i + n].trim() === '' || indent(raw[i + n]) > keyCol)) n++
  while (n > 1 && raw[i + n - 1].trim() === '') n--
  const body = [
    'run:' + m[2],
    ...raw.slice(i + 1, i + n).map((l) => l.slice(Math.min(keyCol, indent(l)))),
  ]
  let value
  try {
    value = yaml.load(body.join('\n'))?.run
  } catch {
    return null
  }
  if (typeof value !== 'string') return null
  return { command: value, consumed: n, literal: /^\s*\|/.test(m[2]) }
}

/**
 * Scan shell (or workflow YAML) text. Returns [{ line, tool, text }].
 * Pass { yaml: true } for a workflow or action file, so a quoted `run:`
 * value is read as the command it holds.
 */
export function scanShellText(text, { yaml: isYaml = false } = {}) {
  const raw = text.split('\n')
  const hits = []
  const heredocs = []
  let i = 0
  while (i < raw.length) {
    const startLine = i + 1
    let line = raw[i]
    if (heredocs.length > 0) {
      const h = heredocs[0]
      // As in bash: the line must be exactly the delimiter; `<<-` strips
      // leading tabs only.
      const body = h.dash ? line.replace(/^\t+/, '') : line
      if (body === h.tag) heredocs.shift()
      i++
      continue
    }
    if (isYaml) {
      const decoded = decodeYamlRun(raw, i)
      if (decoded) {
        for (const h of scanShellText(decoded.command)) {
          const at = decoded.literal ? i + h.line : i
          hits.push({ line: at + 1, tool: h.tool, text: raw[at].trim() })
        }
        i += decoded.consumed
        continue
      }
    }
    while (/\\$/.test(line) && i + 1 < raw.length) {
      i++
      line = line.slice(0, -1) + raw[i]
    }
    i++
    if (/^\s*#/.test(line)) continue
    const { at, heredocs: found } = lexLine(line)
    const cut = trailingCommentIndex(line, at)
    const code = cut === -1 ? line : line.slice(0, cut)
    for (const m of code.matchAll(HIT)) {
      if (m[4] && EXACT_VERSION.test(m[4])) continue
      const { q, openAt } = at[m.index]
      if (q === null || (q !== 'arith' && SH_C.test(code.slice(0, openAt)))) {
        hits.push({ line: startLine, tool: m[3], text: line.trim() })
        break
      }
    }
    heredocs.push(...(cut === -1 ? found : lexLine(code).heredocs))
  }
  return hits
}

function walkFiles(repoRoot) {
  const files = []
  const visit = (rel, accept) => {
    let entries
    try {
      entries = readdirSync(join(repoRoot, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') visit(child, accept)
      } else if (accept(child)) {
        files.push(child)
      }
    }
  }
  visit('scripts', (f) => f.endsWith('.sh'))
  visit('.github/workflows', (f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
  visit('.github/actions', (f) => /^\.github\/actions\/.+\/action\.ya?ml$/.test(f))
  return files.sort()
}

/**
 * Scan every tracked scripts/**\/*.sh, .github/workflows/*.y*ml and
 * .github/actions/**\/action.y*ml file under repoRoot. Uses `git ls-files`;
 * when git can't answer (a worktree container, where the gitdir points at a
 * host path) it walks the filesystem instead and says so in `via`.
 * Returns { findings: [{ file, line, tool, text }], scanned, via, unreadable }:
 * `scanned` counts only files actually read; `unreadable` lists the others.
 * Pass `env` to control the spawned git's environment (tests use makeFixtureEnv).
 */
export function findBareNpxCliInShellAndWorkflows(repoRoot, { env } = {}) {
  let files
  let via = 'git'
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        repoRoot,
        'ls-files',
        'scripts/*.sh',
        '.github/workflows/*.yml',
        '.github/workflows/*.yaml',
        '.github/actions/*/action.yml',
        '.github/actions/*/action.yaml',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env } : {}) }
    )
    files = [...new Set(out.split('\n').filter(Boolean))]
  } catch {
    files = walkFiles(repoRoot)
    via = 'filesystem'
  }
  const findings = []
  const unreadable = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(join(repoRoot, file), 'utf8')
    } catch {
      unreadable.push(file)
      continue
    }
    const isYaml = /\.ya?ml$/.test(file)
    for (const h of scanShellText(text, { yaml: isYaml })) findings.push({ file, ...h })
  }
  return { findings, scanned: files.length - unreadable.length, via, unreadable }
}
