/**
 * Helpers for audit-standards.mjs Check 59, shell sub-check (SMI-7223, SMI-7226,
 * SMI-7241).
 *
 * Flags a bare `npx supabase` / `npx wrangler` invocation in a tracked shell
 * script, workflow or composite action. With no local package, npx downloads
 * registry-latest and ignores any pinned binary on PATH, which is how
 * SMI-7223's deploy outage happened. See
 * docs/internal/implementation/smi-7223-deploy-pinned-supabase-cli.md.
 *
 * This is a line lexer, not a shell parser. It joins backslash continuations
 * as bash does (a backslash ending a comment continues nothing), skips
 * comments, and lexes each logical line once
 * (audit-shell-npx-cli-lexer.mjs). Each logical line yields at most one hit,
 * at its first physical line, from the first of three passes that finds a
 * call:
 * 1. Raw: an `npx … <tool>` in command context, or inside quotes that are a
 *    `sh -c` argument.
 * 2. Rebuilt `sh -c` argument: every word is rebuilt as bash joins it
 *    (quotes, $'…' decoded, backslashes, expansions taken as empty;
 *    audit-shell-npx-cli-words.mjs). A word that is a `sh -c` argument is
 *    scanned as a script of its own.
 * 3. Rebuilt words in place: a quoted, escaped or expanded word whose value is
 *    a plain word is put back unquoted into one copy of the line, which is
 *    lexed and checked once.
 * A heredoc whose command, or a later stage of its pipeline, is a shell
 * reading stdin (sh, bash, zsh, dash, ksh, no -c; or `source /dev/stdin`)
 * has its body scanned as a script, hits at their physical lines. Any other
 * heredoc body is text. With an unquoted delimiter the outer shell expands
 * the body first, so its command substitutions are scanned too, fed or not
 * (at most one hit per physical line). A tool pinned
 * to an exact x.y.z version (or by an exact `-p`/`--package` value) is not
 * flagged; `@latest` or `@3` is. In a workflow or action file, each `run:`
 * value is decoded with js-yaml and scanned as the command it holds
 * (audit-shell-npx-cli-yaml.mjs).
 * Known blind spots, by design (plan Addendum B.8):
 * - npx or the tool name built from a variable, or from an expansion that is
 *   not empty at run time. Expansions are taken as empty, which also flags
 *   `"$(echo hi)"bash -c 'npx …'` (bash runs `hibash`).
 * - A `${x:-word}` default (taken as empty), and a `${…}` holding `"…"` (the
 *   lexer ends the outer quote at the inner one).
 * - eval, and a quoted string passed to another interpreter (ssh, docker exec).
 * - An outer word whose plain value holds an inner word substituted on the
 *   same line: only the inner word is substituted.
 * - A heredoc fed to a shell any other way than its own pipeline: through a
 *   `{ …; }` group or after `;`, a here-string, process substitution, or a
 *   wrapper not in the list (`ssh host bash <<EOF`). An unquoted-delimiter
 *   body is scanned as written (as a script and for its substitutions), not
 *   as the text the outer shell's expansion produces.
 * - Case arms and other conditions are not evaluated.
 * - npx flags that take a value other than NPX_VALUE_FLAGS, and a
 *   substitution or quote left open across lines.
 * - A redirection between npx and the tool (`npx 2>/dev/null supabase`), and
 *   a quoted command string piped to a shell (`echo 'npx supabase' | bash`)
 *   (SMI-7248).
 * - Before a `sh -c`, a flag bundle holding two or more o/O letters takes
 *   only one value word (`bash -oo a b -c '…'` is missed), and an o bundle
 *   that also holds the c (`bash -oc pipefail '…'`) is not read as -c.
 * - The backtick over-approximations at SHELL_TAIL in
 *   audit-shell-npx-cli-sh-c.mjs, which err towards a flag.
 * - Two rare false positives: a CR, FF or VT between npx and the tool
 *   (`$'npx\rsupabase'`, one word to bash), and a comment that follows `;`
 *   with no space (`echo a;#…`), which the raw pass does not cut (SMI-7248).
 */

import { execFileSync } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

import { lexLine } from './audit-shell-npx-cli-lexer.mjs'
import { endsInShC } from './audit-shell-npx-cli-sh-c.mjs'
import { readWords } from './audit-shell-npx-cli-words.mjs'
import { decodeYamlRun, firstAliasLine, resolvedRunValues } from './audit-shell-npx-cli-yaml.mjs'

const TOOLS = ['supabase', 'wrangler']

// npx flags whose value is a separate word. `-p`/`--package` is checked by
// pinnedByPackageFlag(): its value is what npx installs.
const NPX_VALUE_FLAGS = '--prefix|--cache|--registry|--userconfig|--workspace|-w|--package|-p'
// `npx` as a bare word or a quoted command word ("npx" / 'npx'), then
// optional flags, then a watched tool, bare or quoted, with an optional
// @version (group 3 is the tool, group 4 the version). Bash's blanks are
// space and tab only, so `echo\rnpx` is one word: CR, FF and VT count as word
// characters before `npx`.
const hitFor = (tools) =>
  new RegExp(
    String.raw`(?:(?<![\w.$\r\f\v-])npx|(["'])npx\1)\s+(?:(?:${NPX_VALUE_FLAGS})(?:=|\s+)\S+\s+|--?[A-Za-z-]+(?:=\S+)?\s+)*(["']?)(${tools.join('|')})(@[^\s"';&|()<>]+)?\2(?![A-Za-z0-9@_-])`,
    'g'
  )
const HIT = hitFor(TOOLS)
// The pattern the current scan uses: HIT, or one tool's, set by
// scanShellText's `tools` option for the length of one synchronous call.
let hit = HIT
// An exact pin: npx runs that version, not registry-latest. A prerelease or
// build suffix still names one version.
const EXACT_VERSION = /^@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// `-p <value>` / `--package=<value>` among npx's flags.
const PACKAGE_FLAG = /(?:^|\s)(?:-p|--package)(?:=|\s+)(["']?)([^\s"']+)\1/g

/** True when an npx match pins its tool: an exact @version, or else -p/--package. */
function isPinned(m) {
  return m[4] ? EXACT_VERSION.test(m[4]) : pinnedByPackageFlag(m[0], m[3])
}

/** True when the npx call's -p/--package value pins this tool exactly. */
function pinnedByPackageFlag(call, tool) {
  for (const m of call.matchAll(PACKAGE_FLAG)) {
    const at = m[2].lastIndexOf('@')
    if (at > 0 && m[2].slice(0, at) === tool && EXACT_VERSION.test(m[2].slice(at))) return true
  }
  return false
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
 * A $'…' argument is left to pass 2, which decodes it: its raw text can hold
 * a call that decoding removes (`$'echo\0; npx …'` ends at the NUL).
 */
function firstCall(code, at) {
  const memo = new Map()
  for (const m of code.matchAll(hit)) {
    if (isPinned(m)) continue
    const { q, openAt } = at[m.index]
    if (q === null) return m[3]
    if (q !== 'arith' && q !== "$'" && endsInShC(code, openAt, memo)) return m[3]
  }
  return null
}

// A rebuilt word that bash would read as the same single word unquoted.
const PLAIN_WORD = /^[A-Za-z0-9@._/+-]*$/
// Nesting of `sh -c` arguments and fed heredocs scanned as scripts. Each level
// is strictly shorter than the one above, so recursion ends anyway, but a few
// thousand fed heredocs would exhaust the stack; past this depth any unpinned
// call in the text counts, whatever its context.
const MAX_DEPTH = 16

/** The tool of the first unpinned call in `text`, context ignored. */
function anyCall(text) {
  for (const m of text.matchAll(hit)) if (!isPinned(m)) return m[3]
  return null
}

/** The tool of the first call in `text` read as a script, or null. */
function scriptCall(text, depth) {
  if (depth > MAX_DEPTH) return anyCall(text)
  return scanShellText(text, { depth })[0]?.tool ?? null
}

/** Pass 2: the first word (leftmost) that is a `sh -c` argument holding a call. */
function shCArgCall(code, words, depth) {
  const memo = new Map()
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    if (!endsInShC(code, w.start, memo)) continue
    const tool = scriptCall(w.value, depth + 1)
    if (tool) return tool
  }
  return null
}

/**
 * Pass 3: put every eligible rebuilt word back unquoted into one copy of the
 * line, right to left, and check the copy once. Eligible: its value differs
 * from its raw text, every frame in it closed, the value is a plain word, and
 * a quote or backslash took part or else only parameter expansions did (an
 * unquoted $(…) is usually not empty: `$(echo hi)bash` runs `hibash`); an
 * empty value only when no quote took part (an unquoted expansion that
 * vanishes). A word holding an already substituted word is left as it is.
 */
function inPlaceCall(code, words, heredocBody) {
  const chosen = words
    .filter(
      (w) =>
        w.changed &&
        w.closed &&
        PLAIN_WORD.test(w.value) &&
        (w.quoted || !w.subst) &&
        (w.value || !w.quoted)
    )
    .sort((a, b) => b.start - a.start)
  const pieces = []
  let rest = code.length
  for (const w of chosen) {
    if (w.end > rest) continue
    pieces.push(code.slice(w.end, rest), w.value)
    rest = w.start
  }
  if (pieces.length === 0) return null
  pieces.push(code.slice(0, rest))
  const copy = pieces.reverse().join('')
  return firstCall(copy, lexLine(copy, { heredocBody }).at)
}

/**
 * The call one logical line makes, and which of its heredocs feed a shell.
 * Words are rebuilt only when the raw pass found nothing or the line holds a
 * heredoc operator.
 */
function lineCall(code, lexed, depth, heredocBody) {
  let tool = firstCall(code, lexed.at)
  if (tool !== null && lexed.heredocs.length === 0) return { tool, fed: [] }
  const { words, fed } = readWords(code, lexed, { heredocBody })
  if (tool === null) tool = shCArgCall(code, words, depth) ?? inPlaceCall(code, words, heredocBody)
  return { tool, fed }
}

/**
 * Scan shell (or workflow YAML) text. Returns [{ line, tool, text }].
 * Pass { yaml: true } for a workflow or action file, so a quoted `run:`
 * value is read as the command it holds, and { tools: ['supabase'] } to
 * look for a subset of the watched tools.
 */
export function scanShellText(text, opts = {}) {
  if (opts.tools === undefined) return scan(text, opts)
  if (!opts.tools.every((t) => TOOLS.includes(t))) throw new Error('unwatched tool')
  const saved = hit
  hit = hitFor(opts.tools)
  try {
    return scan(text, opts)
  } finally {
    hit = saved
  }
}

/** The call an unquoted-delimiter heredoc body line makes through its substitutions. */
function expandedLineCall(line, depth) {
  return lineCall(line, lexLine(line, { heredocBody: true }), depth, true)
}

/**
 * Join the physical lines from raw[i] that end in a backslash, as bash does,
 * except that a backslash ending a comment continues nothing. Returns
 * { line, next }. Pieces are collected and joined once (repeated string
 * concatenation re-scanned the growing line, quadratic in its length). The
 * first piece is lexed alone for a comment; a comment in a later piece needs
 * the earlier pieces' context, so the joined line is checked once and cut
 * after the piece holding the comment.
 */
function joinContinued(raw, i) {
  const first = raw[i]
  if (!first.endsWith('\\') || i + 1 >= raw.length || endsInComment(first)) {
    return { line: first, next: i + 1 }
  }
  const pieces = [first.slice(0, -1)]
  const starts = [0]
  let len = pieces[0].length
  let j = i + 1
  for (;;) {
    const piece = raw[j]
    const more = piece.endsWith('\\') && j + 1 < raw.length
    starts.push(len)
    pieces.push(more ? piece.slice(0, -1) : piece)
    len += pieces[pieces.length - 1].length
    j++
    if (!more) break
  }
  const line = pieces.join('')
  const cut = commentStart(line)
  if (cut === -1) return { line, next: j }
  // The first piece starting after the comment is where the logical line ends.
  const k = starts.findIndex((s) => s > cut)
  if (k === -1) return { line, next: j }
  return { line: line.slice(0, starts[k]), next: i + k }
}

/** Index of the comment's `#` in a logical line, or -1. */
function commentStart(line) {
  const full = /^\s*#/.exec(line)
  if (full) return full[0].length - 1
  return line.includes('#') ? trailingCommentIndex(line, lexLine(line).at) : -1
}

/** Does this physical line, read alone, end inside a comment? */
function endsInComment(line) {
  return commentStart(line) !== -1
}

function scan(text, { yaml: isYaml = false, depth = 0 } = {}) {
  const raw = text.split(/\r?\n/)
  const hits = []
  const heredocs = []
  // A fed heredoc's body is scanned as a script once it is complete (past
  // MAX_DEPTH, any call on a body line counts). With an unquoted delimiter the
  // body's substitutions, found line by line as it was read, count too: the
  // outer shell runs them before the inner shell sees the text. One hit per
  // physical line, the script scan's first.
  const flush = (h) => {
    const byLine = new Map()
    if (h.lines.length > 0) {
      const found =
        depth + 1 > MAX_DEPTH
          ? h.lines.map((l, k) => ({ line: k + 1, tool: anyCall(l) })).filter((x) => x.tool)
          : scan(h.lines.join('\n'), { depth: depth + 1 })
      for (const f of found) {
        const at = h.start + f.line - 1
        if (!byLine.has(at)) byLine.set(at, f.tool)
      }
    }
    for (const e of h.expanded) if (!byLine.has(e.line)) byLine.set(e.line, e.tool)
    for (const [at, tool] of [...byLine].sort((a, b) => a[0] - b[0])) {
      hits.push({ line: at, tool, text: raw[at - 1].trim() })
    }
  }
  let i = 0
  while (i < raw.length) {
    const startLine = i + 1
    let line = raw[i]
    if (heredocs.length > 0) {
      const h = heredocs[0]
      // As in bash: the line must be exactly the delimiter; `<<-` strips
      // leading tabs only.
      const body = h.dash ? line.replace(/^\t+/, '') : line
      if (body === h.tag) {
        heredocs.shift()
        if (h.fed) flush(h)
      } else if (h.fed) {
        if (h.lines.length === 0) h.start = startLine
        h.lines.push(body)
        if (h.expands) {
          const { tool } = expandedLineCall(body, depth)
          if (tool) h.expanded.push({ line: startLine, tool })
        }
      } else if (h.expands) {
        const { tool } = expandedLineCall(line, depth)
        if (tool) hits.push({ line: startLine, tool, text: line.trim() })
      }
      i++
      continue
    }
    if (isYaml) {
      const decoded = decodeYamlRun(raw, i)
      if (decoded) {
        for (const h of scan(decoded.command, { depth })) {
          const at = decoded.literal ? i + h.line : i
          hits.push({ line: at + 1, tool: h.tool, text: raw[at].trim() })
        }
        i += decoded.consumed
        continue
      }
    }
    ;({ line, next: i } = joinContinued(raw, i))
    if (/^\s*#/.test(line)) continue
    let lexed = lexLine(line)
    const cut = trailingCommentIndex(line, lexed.at)
    const code = cut === -1 ? line : line.slice(0, cut)
    if (cut !== -1) lexed = lexLine(code)
    const { tool, fed } = lineCall(code, lexed, depth, false)
    if (tool) hits.push({ line: startLine, tool, text: line.trim() })
    lexed.heredocs.forEach((h, k) =>
      heredocs.push({ ...h, fed: fed[k] === true, lines: [], expanded: [] })
    )
  }
  // An unterminated heredoc runs to the end of the text, as bash reads it.
  if (heredocs.length > 0 && heredocs[0].fed) flush(heredocs[0])
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
  const want = count(values.flatMap((v) => scan(v)))
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
