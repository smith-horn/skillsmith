/**
 * SMI-6944 Check 4: Vercel dispatch surfaces that do not show up as a `vercel` /
 * `vc` command word, scoped to CREDENTIALED jobs (a job, or the workflow-level
 * preamble it inherits, that references a Vercel token).
 *
 *   - `workflow-vercel-action`: a `uses:` whose owner/repo contains "vercel"
 *     (case-insensitive), e.g. a third-party deploy action. It receives the token
 *     and runs whatever CLI it bundles, outside the lockfile.
 *   - `workflow-vercel-indirect-dispatch`: a variable assigned a value whose first
 *     word is the Vercel CLI (`CLI=vercel`, `export V="vc deploy"`,
 *     `local x=/usr/local/bin/vercel`, `CLI="$GITHUB_WORKSPACE/node_modules/.bin/vercel"`),
 *     so a later `"$CLI" deploy` or `eval "$CMD"` runs it while the command word
 *     the scanner sees is `$CLI`. The exact absolute path is refused here too:
 *     call sites must spell the path literally, which is what Check 4 can see.
 *
 * Forms read as an assignment: leading `NAME=value` words of a command, and the
 * arguments of `export` / `local` / `declare` / `readonly` / `typeset`. NOT read
 * (documented limits): `printf -v NAME vercel`, `read`, a `for NAME in vercel`
 * loop list, a value assembled from pieces (`ver"cel"`, `${A}${B}`), a value
 * read from a file or another step's output, and an action whose owner/repo does
 * not contain "vercel". A wrapper such as `npx vercel` is handled as a command
 * word in check-supply-chain-pins.commands.mjs.
 *
 * Pure functions. ASCII only.
 *
 * @see scripts/ci/check-supply-chain-pins.helpers.mjs (consumer)
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { allTokenLists, bare, isVercelWord } from './check-supply-chain-pins.commands.mjs'

/** A job (or preamble) text that holds a Vercel deploy credential. */
const CREDENTIAL = /\bvercel[-_](?:prod[-_])?token\b/i
const DECLARERS = new Set(['export', 'local', 'declare', 'readonly', 'typeset'])
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
const USES = /^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/

/**
 * Header lines (as `jobOf` returns them) of every credentialed job. When the
 * preamble before the first job is credentialed, every job is, and key 0 (a
 * composite action, or text before `jobs:`) is included.
 */
export function credentialedJobKeys(cleanedSource, boundaries) {
  const lines = cleanedSource.split('\n')
  const keys = new Set()
  const firstJob = boundaries.length ? boundaries[0].line : lines.length + 1
  const preamble = lines.slice(0, firstJob - 1).join('\n')
  const all = CREDENTIAL.test(preamble)
  if (all) keys.add(0)
  boundaries.forEach((b, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length
    if (all || CREDENTIAL.test(lines.slice(b.line - 1, end).join('\n'))) keys.add(b.line)
  })
  return keys
}

/** `[{ line, ref }]` for every `uses:` whose owner/repo names Vercel. */
export function vercelUses(cleanedSource) {
  const out = []
  cleanedSource.split('\n').forEach((l, i) => {
    const m = l.match(USES)
    if (!m) return
    const ref = m[1]
    if (ref.startsWith('./') || ref.startsWith('../')) return
    const target = ref.startsWith('docker://')
      ? ref.slice('docker://'.length).split(/[@:]/)[0]
      : ref.split('@')[0].split('/').slice(0, 2).join('/')
    if (/vercel/i.test(target)) out.push({ line: i + 1, ref })
  })
  return out
}

function valueHead(value) {
  let v = value.trim()
  if (v.startsWith('$(') || v.startsWith('`')) return '' // a substitution is scanned as a command
  if (v.startsWith('$') && /^\$['"]/.test(v)) v = v.slice(1) // $'...' ANSI-C quoting
  const m = v.match(/^(["'])([\s\S]*)\1$/)
  if (m) v = m[2]
  return v.trim().split(/\s+/)[0] || ''
}

/** `[{ name, value }]` for every assignment in `body` whose value starts with the CLI. */
export function vercelAssignments(body) {
  const out = []
  const check = (tok) => {
    const m = tok.match(ASSIGN)
    if (m && isVercelWord(valueHead(m[2]))) out.push({ name: m[1], value: m[2] })
  }
  for (const toks of allTokenLists(body)) {
    let i = 0
    for (; i < toks.length; i++) {
      if (ASSIGN.test(toks[i])) check(toks[i])
      else if (!KEYWORDS.has(bare(toks[i]))) break
    }
    if (i < toks.length && DECLARERS.has(bare(toks[i]))) {
      for (let j = i + 1; j < toks.length; j++) check(toks[j])
    }
  }
  return out
}
