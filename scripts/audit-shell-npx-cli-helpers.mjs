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
 * as bash does (a backslash ending a comment continues nothing;
 * audit-shell-npx-cli-join.mjs), skips comments, and lexes each logical line
 * once (audit-shell-npx-cli-lexer.mjs). Each logical line yields at most one
 * hit, at its first physical line, from the first of three passes that finds
 * a call (the npx pattern: audit-shell-npx-cli-match.mjs):
 * 1. Raw: an `npx … <tool>` in command context, or inside quotes that are a
 *    `sh -c` argument.
 * 2. Rebuilt `sh -c` argument: every word is rebuilt as bash joins it
 *    (quotes, $'…' decoded, backslashes, expansions taken as empty;
 *    audit-shell-npx-cli-words.mjs). A word that is a `sh -c` argument is
 *    scanned as a script of its own.
 * 3. Rebuilt words in place: a quoted, escaped or expanded word whose value is
 *    a plain word is put back unquoted into one copy of the line, which is
 *    lexed and checked once.
 * With the `quotedArgs` option (package.json script bodies, whose runners
 * such as concurrently and nodemon execute their string arguments), every
 * quoted word is then also scanned as a script.
 * A heredoc whose command, or a later stage of its pipeline, reads its script
 * from stdin (sh, bash, zsh, dash, ksh with no -c, behind the wrappers in
 * audit-shell-npx-cli-words.mjs; `source`/`.` of /dev/stdin or /dev/fd/0,
 * also behind `command`/`builtin`; or a `( … )` group holding one of these,
 * as any command or pipeline stage, with the heredoc on the group's `)`, the
 * group open across lines or not) has its body scanned as a script, hits at
 * their physical lines. Any other heredoc body is text. With an unquoted
 * delimiter the outer shell expands the body first, so its command
 * substitutions are scanned too, fed or not (at most one hit per physical
 * line; a substitution on a continued line is not counted again when the
 * script scan found it on that logical line). A tool pinned to an exact
 * x.y.z version (or by an exact `-p`/`--package` value) is not flagged;
 * `@latest` or `@3` is. In a workflow or action file, each `run:` value is
 * decoded with js-yaml and scanned as the command it holds
 * (audit-shell-npx-cli-yaml.mjs).
 * Known blind spots, by design (plan Addendum B.8):
 * - npx or the tool name built from a variable, or from an expansion that is
 *   not empty at run time. Expansions are taken as empty, which also flags
 *   `"$(echo hi)"bash -c 'npx …'` (bash runs `hibash`).
 * - A `${x:-word}` default (taken as empty), and a `${…}` holding `"…"` (the
 *   lexer ends the outer quote at the inner one).
 * - A `#` the raw comment cut reads as starting a comment although bash does
 *   not, inside `${…}` or after an escaped space: `echo ${y:- #} ; npx
 *   supabase status` and `x=a\ #b npx …` are missed (SMI-7248).
 * - eval, and a quoted string passed to another interpreter (ssh, docker exec)
 *   outside package.json scripts.
 * - An outer word whose plain value holds an inner word substituted on the
 *   same line: only the inner word is substituted.
 * - A heredoc fed to a shell any other way than its own pipeline or a
 *   `( … )` group: through a `{ …; }` group or after `;`, a here-string,
 *   process substitution, or a wrapper not in the list (`ssh host bash
 *   <<EOF`), or a pipeline into a group holding `&&` or `;` (`cat <<EOF | (
 *   cd /tmp && bash )`, SMI-7248). A group counts as fed when any command in
 *   it without a heredoc of its own reads stdin, even one an earlier command
 *   starves (`( cat; bash ) <<EOF`, `( true | bash ) <<EOF`), or one whose
 *   stdin is redirected some other way (`( bash </dev/null ) <<EOF`, `<<<`).
 *   A `)` that is not the group's closes it early: a case pattern's, or the
 *   close of a `$( … )`, `$(( … ))` or quote spanning lines inside a
 *   multi-line group. A group opened on the line of an open `$(` is not
 *   tracked. A `(` left open by a quote the line lexer misreads can hold
 *   later commands until a stray `)` (a rare false positive). An unquoted-delimiter
 *   body is scanned as written (as a script and for its substitutions), not
 *   as the text the outer shell's expansion produces.
 * - `bash -c 'source /dev/stdin' <<EOF`: a `-c` string is not read for a
 *   stdin reader (missed), and `command -v source /dev/stdin <<EOF` is read
 *   as sourcing stdin (a false positive) (SMI-7248).
 * - A quoted version spec holding characters outside a plain word
 *   (`npx supabase@"^2"`) or an empty one (`npx supabase@`) (SMI-7248).
 * - Case arms and other conditions are not evaluated.
 * - npx flags that take a value other than NPX_VALUE_FLAGS, and a
 *   substitution or quote left open across lines.
 * - A redirection between npx and the tool (`npx 2>/dev/null supabase`), and
 *   a quoted command string piped to a shell (`echo 'npx supabase' | bash`)
 *   (SMI-7248).
 * - Before a `sh -c`, a flag bundle holding two or more o/O letters takes
 *   only one value word (`bash -oo a b -c '…'` is missed), and an o bundle
 *   that also holds the c (`bash -oc pipefail '…'`) is not read as -c. A `+`
 *   bundle holding a c that bash does not run (`bash +lc '…'` ran nothing
 *   under bash 5.2) is still read as -c, a false positive. After the -c, an
 *   option taking a value (`bash -c -o pipefail '…'`, also `+o`, `-euo`,
 *   `+O`) ends the shape, and so does `--rcfile`/`--init-file <file>` before
 *   it (SMI-7248).
 * - The backtick over-approximations at SHELL_TAIL in
 *   audit-shell-npx-cli-sh-c.mjs, which err towards a flag.
 * - Two rare false positives: a CR, FF or VT between npx and the tool
 *   (`$'npx\rsupabase'`, one word to bash), and a comment that follows `;`
 *   with no space (`echo a;#…`), which the raw pass does not cut (SMI-7248).
 */

import { execFileSync } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

import { makeJoiner, trailingCommentIndex } from './audit-shell-npx-cli-join.mjs'
import { CMD, lexLine } from './audit-shell-npx-cli-lexer.mjs'
import { TOOLS, anyCall, counts, matcher } from './audit-shell-npx-cli-match.mjs'
import { endsInShC } from './audit-shell-npx-cli-sh-c.mjs'
import { readWords } from './audit-shell-npx-cli-words.mjs'
import { decodeYamlRun, firstAliasLine, resolvedRunValues } from './audit-shell-npx-cli-yaml.mjs'

/**
 * The first counted npx match in `code` that runs (command context, or
 * quotes that are a `sh -c` argument), or null. `at` comes from lexLine.
 * One memo serves every quote opening on the line, so many openings (or many
 * hits in one quote) behind one long flag run don't each re-walk it. A
 * heredoc body's sticky frame has opening -1, and endsInShC answers false.
 * A $'…' argument is left to pass 2, which decodes it: its raw text can hold
 * a call that decoding removes (`$'echo\0; npx …'` ends at the NUL).
 */
function firstCall(code, at, pat, memo = new Map()) {
  for (const m of code.matchAll(pat.re)) {
    if (!counts(pat, m)) continue
    const { q, openAt } = at[m.index]
    if (q === null) return m
    if (q !== 'arith' && q !== "$'" && endsInShC(code, openAt, memo)) return m
  }
  return null
}

/** Is index `i` inside a command substitution, per lexLine's match table? */
function insideCmd(frames, i) {
  for (let k = 0; k < i; k++) {
    if (frames.kind[k] === CMD && frames.body[k] <= i && i < frames.close[k]) return true
  }
  return false
}

// A rebuilt word that bash would read as the same single word unquoted.
const PLAIN_WORD = /^[A-Za-z0-9@._/+-]*$/
// Nesting of `sh -c` arguments and fed heredocs scanned as scripts. Each level
// is strictly shorter than the one above, so recursion ends anyway, but a few
// thousand fed heredocs would exhaust the stack; past this depth any unpinned
// call in the text counts, whatever its context.
const MAX_DEPTH = 16

/** The tool of the first call in `text` read as a script, or null. */
function scriptCall(text, depth, pat) {
  if (depth > MAX_DEPTH) return anyCall(text, pat)
  return scan(text, { depth, pat })[0]?.tool ?? null
}

/** Pass 2 (and `quotedArgs`): the leftmost word passing `pick` that holds a call. */
function wordArgCall(words, depth, pat, pick) {
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    if (!pick(w)) continue
    const tool = scriptCall(w.value, depth + 1, pat)
    if (tool) return { tool, at: w.start }
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
function inPlaceCall(code, words, heredocBody, pat) {
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
  const lexed = lexLine(copy, { heredocBody })
  const m = firstCall(copy, lexed.at, pat)
  return m && { tool: m[3], inSubst: insideCmd(lexed.frames, m.index) }
}

/**
 * The call one logical line makes, as { tool, inSubst, fed }: `inSubst` says
 * the call sits inside a command substitution, `fed` which of the line's
 * heredocs feed a shell. Words are rebuilt only when the raw pass found
 * nothing, the line holds a heredoc operator, or `groups` (the text's open
 * `( … )` groups, updated in place) is open or may change on this line.
 */
function lineCall(code, lexed, depth, heredocBody, pat, groups = null) {
  const memo = new Map() // one endsInShC memo for every reader of this line
  const m = firstCall(code, lexed.at, pat, memo)
  const raw = m && { tool: m[3], inSubst: insideCmd(lexed.frames, m.index) }
  const tracking = groups !== null && (groups.length > 0 || /[()]/.test(code))
  if (raw !== null && lexed.heredocs.length === 0 && !tracking) return { ...raw, fed: [] }
  const { words, fed } = readWords(code, lexed, { heredocBody, groups: groups ?? [] })
  if (raw !== null) return { ...raw, fed }
  const sh = wordArgCall(words, depth, pat, (w) => endsInShC(code, w.start, memo))
  if (sh) return { tool: sh.tool, inSubst: insideCmd(lexed.frames, sh.at), fed }
  const inPlace = inPlaceCall(code, words, heredocBody, pat)
  if (inPlace) return { ...inPlace, fed }
  const q = pat.quotedArgs ? wordArgCall(words, depth, pat, (w) => w.quoted) : null
  if (q) return { tool: q.tool, inSubst: insideCmd(lexed.frames, q.at), fed }
  return { tool: null, inSubst: false, fed }
}

/**
 * Scan shell (or workflow YAML) text. Returns [{ line, tool, text }].
 * Options: `yaml: true` for a workflow or action file, so a quoted `run:`
 * value is read as the command it holds; `tools: ['supabase']` to look for a
 * non-empty subset of the watched tools (anything else throws, naming the
 * tool); `versioned` and `quotedArgs` as in matcher()
 * (audit-shell-npx-cli-match.mjs).
 */
export function scanShellText(text, opts = {}) {
  const { tools = TOOLS, yaml = false, versioned = false, quotedArgs = false } = opts
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('scanShellText: `tools` must be a non-empty array of watched tools')
  }
  const bad = tools.find((t) => !TOOLS.includes(t))
  if (bad !== undefined) {
    throw new Error(`scanShellText: unwatched tool ${JSON.stringify(bad)} (watched: ${TOOLS})`)
  }
  const pat = matcher(tools, { versioned, quotedArgs })
  return scan(text, { yaml, pat }).map((h) => ({ line: h.line, tool: h.tool, text: h.text }))
}

/** The call an unquoted-delimiter heredoc body line makes through its substitutions. */
function expandedLineCall(line, depth, pat) {
  return lineCall(line, lexLine(line, { heredocBody: true }), depth, true, pat)
}

/**
 * Internal scan. Hits are { line, last, tool, text, inSubst }: `last` is the
 * logical line's last physical line, `inSubst` whether its call sits inside
 * a command substitution.
 */
function scan(text, { yaml: isYaml = false, depth = 0, pat }) {
  const raw = text.split(/\r?\n/)
  const join = makeJoiner(raw)
  const hits = []
  const heredocs = []
  // `( … )` groups still open, shared by every logical line of this text so a
  // group can close on a later line (readWords). A fed heredoc body or a
  // decoded YAML `run:` value is its own script and starts with none.
  const groups = []
  const push = (line, last, tool, inSubst) =>
    hits.push({ line, last, tool, text: raw[line - 1].trim(), inSubst })
  // A fed heredoc's body is scanned as a script once it is complete (past
  // MAX_DEPTH, any call on a body line counts). With an unquoted delimiter the
  // body's substitutions, found line by line as it was read, count too: the
  // outer shell runs them before the inner shell sees the text. One hit per
  // physical line, the script scan's first. The outer shell joins continued
  // lines before it runs a substitution, so a substitution found on a later
  // physical line of a logical line whose script hit sits inside a
  // substitution is that same call, already reported at the logical line.
  const flush = (h) => {
    const byLine = new Map()
    const same = new Set()
    if (h.lines.length > 0) {
      const found =
        depth + 1 > MAX_DEPTH
          ? h.lines.map((l, k) => ({ line: k + 1, tool: anyCall(l, pat) })).filter((x) => x.tool)
          : scan(h.lines.join('\n'), { depth: depth + 1, pat })
      for (const f of found) {
        const at = h.start + f.line - 1
        if (!byLine.has(at)) byLine.set(at, f.tool)
        if (f.inSubst) for (let l = at + 1; l <= h.start + f.last - 1; l++) same.add(l)
      }
    }
    for (const e of h.expanded) {
      if (!byLine.has(e.line) && !same.has(e.line)) byLine.set(e.line, e.tool)
    }
    for (const [at, tool] of [...byLine].sort((a, b) => a[0] - b[0])) push(at, at, tool, false)
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
          const { tool } = expandedLineCall(body, depth, pat)
          if (tool) h.expanded.push({ line: startLine, tool })
        }
      } else if (h.expands) {
        const { tool } = expandedLineCall(line, depth, pat)
        if (tool) push(startLine, startLine, tool, false)
      }
      i++
      continue
    }
    if (isYaml) {
      const decoded = decodeYamlRun(raw, i)
      if (decoded) {
        for (const h of scan(decoded.command, { depth, pat })) {
          const at = decoded.literal ? i + h.line : i
          push(at + 1, at + 1, h.tool, false)
        }
        i += decoded.consumed
        continue
      }
    }
    ;({ line, next: i } = join(i))
    if (/^\s*#/.test(line)) continue
    let lexed = lexLine(line)
    const cut = trailingCommentIndex(line, lexed.at)
    const code = cut === -1 ? line : line.slice(0, cut)
    if (cut !== -1) lexed = lexLine(code)
    const { tool, inSubst, fed } = lineCall(code, lexed, depth, false, pat, groups)
    if (tool) hits.push({ line: startLine, last: i, tool, text: line.trim(), inSubst })
    lexed.heredocs.forEach((h, k) =>
      heredocs.push({ ...h, fed: fed[k] === true, lines: [], expanded: [] })
    )
  }
  // An unterminated heredoc runs to the end of the text, as bash reads it.
  if (heredocs.length > 0 && heredocs[0].fed) flush(heredocs[0])
  if (isYaml) reconcileAliases(text, raw, hits, pat)
  return hits
}

/**
 * A `run` value reached through a YAML alias is invisible line by line. If
 * the file's resolved `run` values hold more unpinned calls per tool than the
 * line pass found, report the difference at the first alias reference, so the
 * check fails even when it cannot name the exact step.
 */
function reconcileAliases(text, raw, hits, pat) {
  const values = resolvedRunValues(text)
  if (!values) return
  const count = (list) => list.reduce((m, h) => m.set(h.tool, (m.get(h.tool) || 0) + 1), new Map())
  const want = count(values.flatMap((v) => scan(v, { pat })))
  const have = count(hits)
  const at = firstAliasLine(raw)
  for (const [tool, n] of want) {
    for (let k = have.get(tool) || 0; k < n; k++) {
      hits.push({ line: at + 1, last: at + 1, tool, text: raw[at].trim(), inSubst: false })
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
