/**
 * H-8 inline-interpreter-script-text extraction for
 * `scripts/ruflo-host-guard.mjs`. Split out of `ruflo-host-guard-shell-
 * fed.mjs` (governance-round M3 file-length follow-up) purely to stay
 * under the 500-line-per-file convention this repo keeps by hand for .mjs
 * files under scripts/ (not enforced by tooling here —
 * `scripts/check-file-length.mjs` only runs via `lint-staged` for
 * `*.ts`/`*.sh`; SMI-5994) once that file's own M3/L1/L3/L5 governance-
 * round docblock corrections pushed it to 514 lines. `extractInlineScriptText`
 * and `INLINE_SCRIPT_BARE_NAME_RE` have no dependency on anything defined
 * only in `ruflo-host-guard-shell-fed.mjs` other than `isPythonBasename`
 * (exported from there for this one cross-file use), so they move cleanly.
 * Re-exported from `ruflo-host-guard-shell-fed.mjs` so
 * `scripts/ruflo-host-guard.mjs`'s own import statement needed no change,
 * the same pattern `ruflo-host-guard-predicates.mjs` already documents for
 * `checkH1toH7`/`isSanctionedNpmForm`/`isReadOnlyNpmForm`.
 */

import {
  basenameOf,
  hasInlineScriptFlag,
  INLINE_SCRIPT_LONG_FLAGS,
} from './shell-command-normalize.mjs'
import { isPythonBasename } from './ruflo-host-guard-shell-fed.mjs'

/**
 * H-8 fix (SMI-6744 Wave 4 governance round): per-interpreter short-flag
 * characters for the inline-script-text flags this guard recurses into --
 * reused via the shared `hasInlineScriptFlag` as a first-pass "does this
 * argv even carry an inline-script flag" check (see that function's own
 * doc in shell-command-normalize.mjs for why long flags are checked
 * uniformly instead of per-interpreter).
 */
const INLINE_SCRIPT_SHORT_FLAG_CHARS = {
  node: 'ep',
  perl: 'eE',
  ruby: 'e',
  php: 'r',
}

/**
 * H-8 fix: extracts the inline SCRIPT-TEXT argument from a node, python
 * (any version), perl, ruby, or php interpreter invocation, or `bun -e`,
 * or `deno eval` (a subcommand, not a flag, so it has no short/long flag
 * shape at all). Reuses the shared `hasInlineScriptFlag` (with this
 * guard's OWN per-interpreter short-flag map) to decide whether an
 * inline-script flag is present at all before locating and returning its
 * VALUE — `hasInlineScriptFlag` only ever answers yes/no, it does not
 * locate which argument or return its text.
 * @param {string[]} normalizedArgv post wrapper/launcher-peel argv
 * @param {Array<{value: string}>} alignedTokens original-case tokens
 *   aligned to `normalizedArgv` (see `tokensForArgv`)
 * @returns {string | null} the script text, or null if this segment
 *   isn't one of these interpreter shapes
 */
export function extractInlineScriptText(normalizedArgv, alignedTokens) {
  if (normalizedArgv.length === 0) return null
  const base = basenameOf(normalizedArgv[0])

  if (base === 'deno') {
    return normalizedArgv[1] === 'eval' && alignedTokens[2] ? alignedTokens[2].value : null
  }

  const shortChars = isPythonBasename(base)
    ? 'c'
    : (INLINE_SCRIPT_SHORT_FLAG_CHARS[base] ?? (base === 'bun' ? 'e' : ''))
  if (shortChars === '') return null

  const args = normalizedArgv.slice(1)
  if (!hasInlineScriptFlag(base, args, { [base]: shortChars })) return null

  for (let i = 1; i < normalizedArgv.length; i++) {
    const tok = normalizedArgv[i]
    if (tok === '--') break
    const eqIdx = tok.indexOf('=')
    const flagPart = eqIdx === -1 ? tok : tok.slice(0, eqIdx)
    if (INLINE_SCRIPT_LONG_FLAGS.has(flagPart)) {
      if (eqIdx !== -1) return alignedTokens[i].value.slice(eqIdx + 1)
      return alignedTokens[i + 1] ? alignedTokens[i + 1].value : null
    }
    if (tok.startsWith('-') && tok !== '-' && !tok.startsWith('--')) {
      for (const ch of shortChars) {
        const pos = tok.indexOf(ch, 1)
        if (pos !== -1) {
          const glued = tok.slice(pos + 1)
          if (glued.length > 0) return glued
          return alignedTokens[i + 1] ? alignedTokens[i + 1].value : null
        }
      }
    }
  }
  return null
}

/**
 * H-8 fix: a whole-word `ruflo`/`claude-flow`/`claude-flow-mcp` reference
 * sitting inside a quoted string within inline interpreter script text --
 * `node -e 'require("child_process").execSync("ruflo")'` never spells any
 * shell-tokenizable "ruflo" argv element (it is JS source text handed to
 * node's OWN parser), so H1–H8's argv-shaped predicates cannot see it.
 * The first alternative matches ANY quote-delimited run (single, double,
 * or backtick) containing the target word with word boundaries anywhere
 * inside it, which alone covers every one of this fix's own red arms
 * (`execSync("ruflo")`, `execSync("ruflo memory store")`,
 * `os.system("ruflo")`, `exec "ruflo"`). The second alternative is
 * defense-in-depth for an unquoted call-site form
 * (`system(`/`exec(`/`execSync(`/`spawn(` immediately followed by the
 * target word) that no red arm here exercises but the design's own
 * wording names explicitly.
 */
export const INLINE_SCRIPT_BARE_NAME_RE =
  /(['"`])(?:(?!\1).)*?\b(ruflo|claude-flow-mcp|claude-flow)\b(?:(?!\1).)*?\1|\b(?:system|exec|execSync|spawn)\(\s*['"`]?(ruflo|claude-flow-mcp|claude-flow)\b/i
