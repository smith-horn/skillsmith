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
 * argument of `sh -c` (bundled flags such as `-lc` or `-ce` included). The
 * body of a heredoc with an unquoted delimiter is scanned for command
 * substitutions, which bash runs. A tool pinned to an exact x.y.z version
 * (a prerelease or build suffix allowed) is not flagged, nor is a tool whose
 * `-p`/`--package` value is such a pin; `@latest` or `@3` is flagged. CRLF
 * line endings are read as LF. In a workflow or action file, each `run:`
 * value (plain, quoted or block) is decoded with js-yaml and scanned as the
 * command it holds, and the whole file is also resolved once so a `run`
 * value reached through an alias is counted (audit-shell-npx-cli-yaml.mjs).
 * Known blind spots, by design:
 * npx built from a variable, eval, a tool name in a variable, a quoted string
 * passed to another interpreter (ssh, docker exec), npx flags that take a
 * value other than those listed in NPX_VALUE_FLAGS, and a substitution or
 * quote left open across lines.
 */

import { execFileSync } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

import { endsInShC } from './audit-shell-npx-cli-sh-c.mjs'
import { decodeYamlRun, firstAliasLine, resolvedRunValues } from './audit-shell-npx-cli-yaml.mjs'

const TOOLS = ['supabase', 'wrangler']

// npx flags whose value is a separate word. `-p`/`--package` is checked by
// pinnedByPackageFlag(): its value is what npx installs.
const NPX_VALUE_FLAGS = '--prefix|--cache|--registry|--userconfig|--workspace|-w|--package|-p'
// `npx` as a bare word or a quoted command word ("npx" / 'npx'), then
// optional flags, then a watched tool, bare or quoted, with an optional
// @version (group 3 is the tool, group 4 the version).
const HIT = new RegExp(
  String.raw`(?:(?<![\w.-])npx|(["'])npx\1)\s+(?:(?:${NPX_VALUE_FLAGS})(?:=|\s+)\S+\s+|--?[A-Za-z-]+(?:=\S+)?\s+)*(["']?)(${TOOLS.join('|')})(@[^\s"';&|()<>]+)?\2(?![A-Za-z0-9@_-])`,
  'g'
)
// An exact pin: npx runs that version, not registry-latest. A prerelease or
// build suffix still names one version.
const EXACT_VERSION = /^@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// `-p <value>` / `--package=<value>` among npx's flags.
const PACKAGE_FLAG = /(?:^|\s)(?:-p|--package)(?:=|\s+)(["']?)([^\s"']+)\1/g

/** True when the npx call's -p/--package value pins this tool exactly. */
function pinnedByPackageFlag(call, tool) {
  for (const m of call.matchAll(PACKAGE_FLAG)) {
    const at = m[2].lastIndexOf('@')
    if (at > 0 && m[2].slice(0, at) === tool && EXACT_VERSION.test(m[2].slice(at))) return true
  }
  return false
}
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
 * The tool of the first unpinned npx call in `code` that runs (command context,
 * or quotes that are a `sh -c` argument), or null. `at` comes from lexLine.
 * One memo serves every quote opening on the line, so many openings (or many
 * hits in one quote) behind one long flag run don't each re-walk it. A
 * heredoc body's sticky frame has opening -1, and endsInShC answers false.
 */
function firstCall(code, at) {
  const memo = new Map()
  for (const m of code.matchAll(HIT)) {
    if (m[4] && EXACT_VERSION.test(m[4])) continue
    if (!m[4] && pinnedByPackageFlag(m[0], m[3])) continue
    const { q, openAt } = at[m.index]
    if (q === null) return m[3]
    if (q !== 'arith' && endsInShC(code, openAt, memo)) return m[3]
  }
  return null
}

/**
 * Scan shell (or workflow YAML) text. Returns [{ line, tool, text }].
 * Pass { yaml: true } for a workflow or action file, so a quoted `run:`
 * value is read as the command it holds.
 */
export function scanShellText(text, { yaml: isYaml = false } = {}) {
  const raw = text.split(/\r?\n/)
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
      else if (h.expands) {
        const tool = firstCall(line, lexLine(line, { heredocBody: true }).at)
        if (tool) hits.push({ line: startLine, tool, text: line.trim() })
      }
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
    const tool = firstCall(code, at)
    if (tool) hits.push({ line: startLine, tool, text: line.trim() })
    heredocs.push(...(cut === -1 ? found : lexLine(code).heredocs))
  }
  if (isYaml) reconcileAliases(text, raw, hits)
  return hits
}

/**
 * A `run` value reached through a YAML alias is invisible line by line. If
 * the file's resolved `run` values hold more unpinned calls per tool than the
 * line pass found, report the difference at the first alias reference, so the
 * check fails even when it cannot name the exact step.
 */
function reconcileAliases(text, raw, hits) {
  const values = resolvedRunValues(text)
  if (!values) return
  const count = (list) => list.reduce((m, h) => m.set(h.tool, (m.get(h.tool) || 0) + 1), new Map())
  const want = count(values.flatMap((v) => scanShellText(v)))
  const have = count(hits)
  const at = firstAliasLine(raw)
  for (const [tool, n] of want) {
    for (let k = have.get(tool) || 0; k < n; k++) {
      hits.push({ line: at + 1, tool, text: raw[at].trim() })
    }
  }
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
