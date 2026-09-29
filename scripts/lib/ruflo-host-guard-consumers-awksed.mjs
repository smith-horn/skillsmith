#!/usr/bin/env node
/**
 * awk/sed consumer-string extraction -- split out of
 * `ruflo-host-guard-consumers.mjs` (M5 follow-up, post round-3 governance
 * round) purely to stay under the 500-line file-length gate once the
 * readable-stdin heredoc lookup grew that file past the limit, same
 * precedent as `ruflo-host-guard-consumers-git.mjs` and
 * `ruflo-host-guard-consumers-tmux.mjs`. Exported as `extractAwkTexts`/
 * `extractSedTexts` and wired into `ruflo-host-guard-consumers.mjs`'s own
 * `EXTRACTORS` list.
 */

import { resolveProcessSubstitutionText } from './ruflo-host-guard-shell-fed.mjs'

const AWK_BASENAMES = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/**
 * M5 follow-up (post round-3 governance): `-f`/`--file` naming a READABLE
 * stdin alias (a bare `-`, `/dev/stdin`, or `/dev/fd/N`) is not "the program
 * is in a file" (out of reach by design) when a heredoc feeds this same
 * segment's stdin -- the program is sitting right there in the heredoc
 * body, and this guard's own tokenizer already captures it. A REAL file
 * path does not match this and falls through unchanged (still out of
 * reach). A process-substitution `<(...)` value ALSO does not match this
 * regex (its own literal text is `<(...)`, not a bare dash/`/dev/...`
 * spelling) -- handled separately below via `resolveProcessSubstitutionText`,
 * the exact same "is this a literal echo/printf/cat-with-heredoc producer"
 * check `bash <(echo '...')` already uses for shells (round-3 governance
 * follow-up, second pass: `awk -f <(echo '...')` was measured allowing
 * before this, since the guard's own top-level `.subs` recursion evaluates
 * the substituted command as an ordinary top-level shell line, which is not
 * itself a ruflo invocation). Exported (round-4 db/shell-consumer follow-up)
 * so `ruflo-host-guard-consumers-dbshell.mjs`'s psql `-f -` check shares the
 * exact same "readable stdin alias" definition rather than a second copy.
 */
export const READABLE_STDIN_RE = /^(?:-|\/dev\/stdin|\/dev\/fd\/[0-9]+)$/

/** awk/gawk/mawk/nawk: `system("...")`/pipe-to-command live inside the PROGRAM text. */
export function extractAwkTexts(base, argv, alignedTokens, segmentTokens) {
  if (!AWK_BASENAMES.has(base)) return null
  let i = 1
  let sawDashF = false
  let dashFValue = null
  let dashFToken = null
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (a === '-f' || a === '--file') {
      sawDashF = true
      dashFValue = argv[i + 1] ?? null
      dashFToken = alignedTokens[i + 1] ?? null
      i += 2
      continue
    }
    if (a === '-v' || a === '-F' || a === '--assign') {
      i += 2
      continue
    }
    if (a.startsWith('--file=')) {
      sawDashF = true
      dashFValue = a.slice('--file='.length)
      dashFToken = alignedTokens[i] ?? null
      i++
      continue
    }
    if (a.startsWith('-f') && a !== '-f') {
      sawDashF = true
      dashFValue = a.slice(2)
      dashFToken = alignedTokens[i] ?? null
      i++
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    break
  }
  if (sawDashF) {
    if (dashFValue && READABLE_STDIN_RE.test(dashFValue) && segmentTokens) {
      const heredocToks = segmentTokens.filter((t) => t.type === 'heredoc')
      if (heredocToks.length > 0) {
        return [{ text: heredocToks.map((t) => t.value ?? '').join('\n'), kind: 'source' }]
      }
    }
    for (const sub of dashFToken?.subs ?? []) {
      const text = resolveProcessSubstitutionText(sub)
      if (text !== null) return [{ text, kind: 'source' }]
    }
    // `-f progfile` (a REAL file, a readable-stdin alias with no heredoc
    // feeding it, or a `<(...)` whose inner command isn't a literal
    // producer) reads the program from a FILE -- unreadable, out of reach
    // by design (same posture as a shell's own `source f`/`sh <file>`).
    return null
  }
  if (i >= argv.length || !alignedTokens[i]) return null
  return [{ text: alignedTokens[i].value, kind: 'source' }]
}

const SED_BASENAMES = new Set(['sed', 'gsed'])
// `s<delim>pattern<delim>replacement<delim>flags` -- delimiter-agnostic via
// a backreference to whatever character follows `s`, the same technique
// `INLINE_SCRIPT_BARE_NAME_RE` uses for quote-agnostic matching.
const SED_S_COMMAND_RE = /s(.)((?:\\.|(?!\1)[\s\S])*)\1((?:\\.|(?!\1)[\s\S])*)\1([a-zA-Z0-9]*)/g
// sed's `[addr]e command` -- executes `command` and inserts its output;
// distinct from the `s///e` FLAG above (a single trailing character on an
// s-command) -- this `e` is its own command letter, optionally preceded by
// a numeric or `$` address.
// Round-3 governance fix: `g`-flagged (was a single non-global `.exec`, so
// only the FIRST `e` command in a multi-command script was ever extracted --
// `sed '1e date;2e ruflo memory store' f` reached ALLOW, measured).
const SED_E_COMMAND_RE = /(?:^|;|\n)\s*(?:[0-9]+|\$)?\s*e\s+([^\n;]+)/g

function extractSedScriptTexts(script) {
  const results = []
  for (const m of script.matchAll(SED_S_COMMAND_RE)) {
    if (/e/.test(m[4])) results.push({ text: m[3], kind: 'shell' })
  }
  for (const m of script.matchAll(SED_E_COMMAND_RE)) {
    results.push({ text: m[1], kind: 'shell' })
  }
  return results
}

/**
 * sed/gsed: the `s///e` flag and the `Ne command` form both hand a shell
 * command to /bin/sh. M5 follow-up: `-f`/`--file` naming a READABLE stdin
 * alias with a heredoc feeding this segment, OR a `<(...)` process
 * substitution whose inner command is a literal producer, reads a sed
 * SCRIPT (the same syntax `-e`/a positional script carries, not a whole
 * program like awk's), so its body is pushed into `scripts` alongside any
 * `-e` values rather than returned directly as its own kind — see
 * `extractAwkTexts`'s own docblock for the shared `READABLE_STDIN_RE`/
 * `resolveProcessSubstitutionText` rationale.
 */
export function extractSedTexts(base, argv, alignedTokens, segmentTokens) {
  if (!SED_BASENAMES.has(base)) return null
  const scripts = []
  let sawDashF = false
  let dashFValue = null
  let dashFToken = null
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (a === '-e' || a === '--expression') {
      if (alignedTokens[i + 1]) scripts.push(alignedTokens[i + 1].value)
      i += 2
      continue
    }
    if (a.startsWith('--expression=')) {
      scripts.push(a.slice('--expression='.length))
      i++
      continue
    }
    if (a.startsWith('-e') && a !== '-e') {
      scripts.push(a.slice(2))
      i++
      continue
    }
    if (a === '-f' || a === '--file') {
      sawDashF = true
      dashFValue = argv[i + 1] ?? null
      dashFToken = alignedTokens[i + 1] ?? null
      i += 2
      continue
    }
    if (a.startsWith('-f') && a !== '-f') {
      sawDashF = true
      dashFValue = a.slice(2)
      dashFToken = alignedTokens[i] ?? null
      i++
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    break
  }
  if (sawDashF && dashFValue && READABLE_STDIN_RE.test(dashFValue) && segmentTokens) {
    const heredocToks = segmentTokens.filter((t) => t.type === 'heredoc')
    if (heredocToks.length > 0) {
      scripts.push(heredocToks.map((t) => t.value ?? '').join('\n'))
    }
  }
  if (sawDashF) {
    for (const sub of dashFToken?.subs ?? []) {
      const text = resolveProcessSubstitutionText(sub)
      if (text !== null) scripts.push(text)
    }
  }
  if (scripts.length === 0 && !sawDashF && alignedTokens[i]) {
    scripts.push(alignedTokens[i].value)
  }
  if (scripts.length === 0) return null
  const results = scripts.flatMap(extractSedScriptTexts)
  return results.length > 0 ? results : null
}
