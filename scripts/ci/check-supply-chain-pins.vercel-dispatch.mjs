/**
 * SMI-6944 Check 4: Vercel dispatch surfaces that do not show up as a `vercel` /
 * `vc` command word. They apply to EVERY job in every workflow and composite
 * action: the property is "nothing runs the Vercel CLI except through the
 * lockfile binary's literal path", and the name of a secret (`VERCEL_TOKEN`,
 * `DEPLOY_TOKEN`, a repo-level credential) is not part of it, so no rule here is
 * gated on one.
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

const DECLARERS = new Set(['export', 'local', 'declare', 'readonly', 'typeset'])
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
const USES = /^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/

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
