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

import { lexLine } from './audit-shell-npx-cli-lexer.mjs'
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
