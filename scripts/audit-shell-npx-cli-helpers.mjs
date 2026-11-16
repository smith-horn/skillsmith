/**
 * Helpers for audit-standards.mjs Check 59, shell sub-check (SMI-7223).
 *
 * Flags a bare `npx supabase` / `npx wrangler` invocation in a tracked shell
 * script or workflow. With no local package, npx downloads registry-latest and
 * ignores any pinned binary on PATH, which is how SMI-7223's deploy outage
 * happened. See docs/internal/implementation/smi-7223-deploy-pinned-supabase-cli.md.
 *
 * This is a line scanner, not a shell parser. It joins backslash
 * continuations, skips heredoc bodies and comments, and tracks quote state
 * ('…', "…", $'…'). An `npx … <tool>` outside quotes counts as an invocation
 * whatever precedes it, so no wrapper list is needed; inside quotes it counts
 * only as the argument of `sh -c` and its siblings. Known blind spots, by
 * design: npx built from a variable, eval, a tool name in a variable, a
 * quoted string passed to another interpreter (ssh, docker exec), and a
 * `<<WORD` inside a quoted string, which starts a heredoc skip.
 */

import { execFileSync } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const TOOLS = ['supabase', 'wrangler']

// `npx` as a bare word or a quoted command word ("npx" / 'npx'), then
// optional flags, then a watched tool with no @version.
const HIT = new RegExp(
  String.raw`(?:(?<![\w.-])npx|(["'])npx\1)\s+(?:--?[A-Za-z-]+(?:=\S+)?\s+)*(${TOOLS.join('|')})(?![A-Za-z0-9@_-])`,
  'g'
)
const SH_C = /(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-c\s*$/
const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/

/**
 * Quote state immediately before `idx`. Returns { q, openAt } where q is
 * null (unquoted), "'" , '"' or "$'" (ANSI-C), and openAt is the index of the
 * opening quote character.
 */
export function quoteStateAt(line, idx) {
  let q = null
  let openAt = -1
  for (let i = 0; i < idx; i++) {
    const c = line[i]
    if (q === null) {
      if (c === '\\') {
        i++
      } else if (c === '$' && line[i + 1] === "'") {
        q = "$'"
        openAt = i + 1
        i++
      } else if (c === '"' || c === "'") {
        q = c
        openAt = i
      }
    } else if (q === '"' || q === "$'") {
      if (c === '\\') i++
      else if ((q === '"' && c === '"') || (q === "$'" && c === "'")) q = null
    } else if (c === "'") {
      q = null
    }
  }
  return { q, openAt }
}

function trailingCommentIndex(line) {
  const re = /(?:^|\s)#/g
  let m
  while ((m = re.exec(line)) !== null) {
    const at = m.index + m[0].length - 1
    if (quoteStateAt(line, at).q === null) return at
  }
  return -1
}

/** Scan shell (or workflow YAML) text. Returns [{ line, tool, text }]. */
export function scanShellText(text) {
  const raw = text.split('\n')
  const hits = []
  let heredoc = null
  let i = 0
  while (i < raw.length) {
    const startLine = i + 1
    let line = raw[i]
    if (heredoc) {
      const body = heredoc.dash ? line.replace(/^\t+/, '') : line
      if (body.trim() === heredoc.tag) heredoc = null
      i++
      continue
    }
    while (/\\$/.test(line) && i + 1 < raw.length) {
      i++
      line = line.slice(0, -1) + ' ' + raw[i].trimStart()
    }
    i++
    const h = line.match(HEREDOC)
    if (!/^\s*#/.test(line)) {
      const cut = trailingCommentIndex(line)
      const code = cut === -1 ? line : line.slice(0, cut)
      for (const m of code.matchAll(HIT)) {
        const { q, openAt } = quoteStateAt(code, m.index)
        if (q === null || SH_C.test(code.slice(0, openAt))) {
          hits.push({ line: startLine, tool: m[2], text: line.trim() })
          break
        }
      }
    }
    if (h) heredoc = { dash: h[1] === '-', tag: h[3] }
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
  return files.sort()
}

/**
 * Scan every tracked scripts/**\/*.sh and .github/workflows/*.y*ml file under
 * repoRoot. Uses `git ls-files`; when git can't answer (a worktree container,
 * where the gitdir points at a host path) it walks the filesystem instead and
 * says so in `via`. Returns { findings: [{ file, line, tool, text }], scanned, via }.
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
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env } : {}) }
    )
    files = [...new Set(out.split('\n').filter(Boolean))]
  } catch {
    files = walkFiles(repoRoot)
    via = 'filesystem'
  }
  const findings = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(join(repoRoot, file), 'utf8')
    } catch {
      continue
    }
    for (const h of scanShellText(text)) findings.push({ file, ...h })
  }
  return { findings, scanned: files.length, via }
}
