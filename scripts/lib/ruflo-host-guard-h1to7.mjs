/**
 * H1–H7 path/token predicates for `scripts/ruflo-host-guard.mjs` (SMI-6744
 * Wave 4). Split out of `ruflo-host-guard-predicates.mjs` (governance-round
 * split, same rationale as `ruflo-host-guard-verdicts.mjs`'s own header) to
 * stay under the 500-line-per-file convention this repo keeps by hand for
 * .mjs files under scripts/ (M3 correction: not enforced by tooling here —
 * `scripts/check-file-length.mjs` only runs via `lint-staged` for
 * `*.ts`/`*.sh`; SMI-5994).
 *
 * All matching is against LOWERCASED argv (`argvLower`/`scanArgvLower`) —
 * a deliberate, stated choice (plan § Predicate Specification): Bash rule
 * case-sensitivity is undocumented, so this guard covers both cases.
 */

import { basenameOf } from './shell-command-normalize.mjs'
import { denyWith, denyWithReadOnlyHint } from './ruflo-host-guard-verdicts.mjs'

/** Package runners H5/H8/the brace check treat as "a runner". */
export const RUNNER_BASENAMES = new Set([
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bunx',
  'bun',
  'corepack',
  'deno',
])

/** H3's basename set (post `.bin/` resolution). */
const H3_NAMES = new Set(['ruflo', 'claude-flow', 'claude-flow-mcp', 'cli'])

/** H4's exact-string set — argv[0] itself, NOT its basename (see H4 vs H3). */
const H4_NAMES = new Set(['ruflo', 'claude-flow', 'claude-flow-mcp'])

// H1/H2/H7's first clause deliberately has NO leading `(?:^|\/)` boundary
// requirement (round 1 smoke-test finding, not in the original design
// draft's literal regex): `git config alias.x '!node
// node_modules/ruflo/bin/ruflo.js memory store' && git x`, `rg --pre
// 'node node_modules/ruflo/bin/ruflo.js' .` and the `cat … | node` pipe
// form all embed the path INSIDE a larger single argv token (one shell
// word holding an alias body, a `--pre` command, etc.), preceded by a
// SPACE or `!`, never a `/` or the start of the whole token -- a leading
// anchor silently allowed exactly the laundering inputs the queen's own
// pre-review correction names as must-deny. The trailing boundary
// (`(?:\/|$)`) is kept: it is what makes the C9/`ruflo-eslint-plugin`
// negative case ("ruflo followed by `-`, not `/` or end, does not match")
// still correct — only the leading requirement was dropped.
const H1_RE1 = /node_modules\/ruflo(?:\/|$)/
// L-D fix (SMI-6744 Wave 4 governance round): the trailing `$` anchor
// required the match to sit at the true END of the token, so an embedded
// occurrence like `import("ruflo/bin/ruflo.js")` (a `node -e` argument)
// never matched -- "bin/ruflo.js" there is followed by a closing `")`,
// not end-of-string. Replaced with a delimiter class so the match can be
// followed by a quote, whitespace, or a closing paren instead of only
// string-end.
const H1_RE2 = /(?:^|\/)bin\/ruflo\.js(?:$|["'\s)])/
const H2_RE1 = /node_modules\/@claude-flow\/cli\/bin\//
const H2_RE2 = /\/bin\/mcp-server\.js(?:$|["'\s)])/
// L-D fix companion (SMI-6744 Wave 4 governance round): H1_RE2 has a bare,
// node_modules-agnostic form ("bin/ruflo.js" is specific enough on its
// own, no package-path prefix needed), but H2 had no equivalent -- H2_RE1
// requires a full "node_modules/@claude-flow/cli/bin/" path, so a bare
// resolution specifier like `import("@claude-flow/cli/bin/cli.js")` (a
// `node -e` argument, no "node_modules/" text at all) matched neither
// H2_RE1 nor H2_RE2 (which only covers the alternate mcp-server.js
// binary). "bin/cli.js" alone is too generic a filename to match
// unqualified (unlike ruflo.js/mcp-server.js), so this requires the
// distinctive `@claude-flow/cli/` package-path prefix immediately before
// it, with no leading anchor (matching H1_RE1's own "no leading boundary"
// choice — an `@` symbol is not the kind of thing legitimate unrelated
// text produces immediately before this exact substring).
const H2_RE3 = /@claude-flow\/cli\/bin\/cli\.js(?:$|["'\s)])/
/** L-D fix companion: a bare runner specifier as node's `-r`/`--require` value. */
const REQUIRE_FLAG_RE = /^(?:-r|--require)$/
const REQUIRE_FLAG_EQ_RE = /^--require=(.+)$/
/** H5's runner-token forms; also reused (bare form only) by H8(i). */
export const RUNNER_TOKEN_RE = /^(@claude-flow\/cli|ruflo|claude-flow)(@.*)?$/
const H5_NPM_COLON_RE = /^npm:(ruflo|@claude-flow\/cli)/
const H5_PACKAGE_FLAG_RE = /^--package=(ruflo|@claude-flow\/cli)$/
const H6_NPX_DIR_RE = /_npx\/[0-9a-f]{16}\//
const H7_RE1 = /lib\/node_modules\/ruflo(?:\/|$)/
const H7_RE2 = /(?:^|\/)versions\/node\/v[0-9.]+\/bin\/(ruflo|claude-flow|claude-flow-mcp|cli)$/

function stripDotSlash(s) {
  return s.startsWith('./') ? s.slice(2) : s
}

/**
 * Removes every backslash-escape in `s` (SMI-6744 Wave 4 residual finding
 * from the hook implementation): a token can carry LITERAL backslash
 * characters before its slashes without ever reaching a shell's own escape
 * processing -- e.g. `sed 's/^/node node_modules\/ruflo\/bin\/ruflo.js/e'`
 * (the `e` flag executes the substituted line as a shell command) is
 * captured by this guard's tokenizer as the literal string
 * `node_modules\/ruflo\/bin\/ruflo.js`, with real `\` characters between
 * `node_modules` and `/ruflo` and between `ruflo` and `/bin` -- sed's own
 * `\/`-escaping of its delimiter, not shell quoting. H1_RE1's contiguous
 * `node_modules/ruflo` substring never matches THAT string as written, so
 * H1–H2/H7 test both the raw element and this de-escaped view. `\X` decodes
 * to `X` for any `X` (matching this file's own convention elsewhere for
 * "unrecognized escape passes the character through").
 */
function deEscape(s) {
  return s.replace(/\\(.)/g, '$1')
}

function dirnameOf(p) {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? '' : p.slice(0, idx)
}

/**
 * Collapses `/{2,}` to a single `/` and removes `/./` segments (H-D fix,
 * SMI-6744 Wave 4 governance round): `node_modules/@claude-flow/cli//bin/`
 * and `node_modules/@claude-flow/cli/./bin/` both defeated H2/H3 before
 * this, since neither the raw token nor the backslash-de-escaped view
 * canonicalises redundant path separators the way a real filesystem
 * resolver would.
 * @param {string} s
 */
function slashNormalize(s) {
  return s.replace(/\/{2,}/g, '/').replace(/(^|\/)\.\//g, '$1')
}

/**
 * The three per-token views H1, H2, H3 (both `basenameOf` and
 * `dirnameOf`), H6 and H7 test against, per token (H-D fix): the raw
 * element, a backslash-de-escaped view (pre-existing, sed-delimiter
 * escapes), and a slash-normalised view (new). H4/H5/H8 stay
 * single-view — they are positional/exact-match checks, not "does this
 * path text contain X" checks, so path-separator noise is not their
 * exposure.
 * @param {string} el
 */
function tokenViews(el) {
  return [el, deEscape(el), slashNormalize(el)]
}

/**
 * H1–H7. Two argv views are needed, not one (queen correction found by the
 * D13 smoke input `NODE_OPTIONS="--require ./node_modules/ruflo/bin/ruflo.js"
 * node -e ''`): the shared `normalizeWrappers` strips ANY leading
 * `VAR=val`-shaped token as part of unwrapping, so a path hidden inside an
 * unrelated env-assignment's VALUE (not a recognized wrapper like `env`)
 * would vanish before an argv[0]-relative check ever ran. H1/H2/H3/H6/H7
 * are pure "does any element contain X" checks with no notion of
 * position, so they run over `scanArgvLower` — the PRE-strip, this-segment
 * lowercased word values, which is always a superset of the post-strip
 * result (wrapper-stripping only ever drops a prefix, never the middle or
 * end). H4/H5 are positional (argv[0]-relative after resolving the real
 * command past its wrappers) and run over `argvLower`, the POST-normalize
 * lowercased argv.
 *
 * H5 is additionally broadened beyond a literal "argv[0] only" reading
 * (design § 1(b)'s own census cites H5 as E4's sole closure —
 * `docker run --rm node:22-slim npx -y ruflo memory store …` — where the
 * runner `npx` sits at position 4, not 0, since `docker run` is not one of
 * `normalizeWrappers`' recognized unwrap shapes, unlike `docker exec`):
 * H5 scans every position for a runner basename, then scans FORWARD from
 * that position (order-preserving — the token must still follow the
 * runner) for a matching token.
 * @param {string[]} scanArgvLower pre-strip, lowercased word values for H1/H2/H3/H6/H7
 * @param {string[]} argvLower post-normalize, lowercased argv for H4/H5
 * @returns {{action:string, json:object|null, stderr:string|null} | null}
 */
export function checkH1toH7(scanArgvLower, argvLower) {
  for (const el of scanArgvLower) {
    for (const view of tokenViews(el)) {
      const stripped = stripDotSlash(view)
      if (H1_RE1.test(stripped) || H1_RE2.test(stripped)) return denyWithReadOnlyHint('H1', el)
    }
  }

  // H1 clause 3 / L-D fix (SMI-6744 Wave 4 governance round): a bare
  // runner specifier passed as node's `-r`/`--require` VALUE has no
  // "bin/ruflo.js" path text for H1_RE1/H1_RE2 to match at all — Node
  // resolves a bare specifier via its own module resolution, so the argv
  // literally only ever contains e.g. "ruflo".
  //
  // Scoped to `argvLower[0]` (post-normalize) resolving to `node`
  // specifically (M-6 residual finding, SMI-6744 Wave 4 delta governance
  // round) — the L-D fix's own comment claimed scoping to "immediately
  // following a require flag" was enough to leave `grep ruflo` etc.
  // unaffected, but that claim was never executed against `-r` as a
  // SEPARATE (not combined) flag: `-r` is also grep's own "recursive"
  // flag, sort's/cut's own "reverse" flag, and tar's own "append" flag,
  // so `grep -r ruflo scripts/`, `sort -r ruflo`, `cut -r ruflo`, `tar -r
  // ruflo` (none of them node, none of them wrapping a real command) all
  // measurably denied via H1 before this fix — confirmed live, not
  // assumed, and closed as part of building the M-6 legitimate-command
  // case table, which could not otherwise honestly include `grep -r ruflo
  // scripts/`.
  if (basenameOf(argvLower[0] ?? '') === 'node') {
    for (let idx = 0; idx < scanArgvLower.length; idx++) {
      const el = scanArgvLower[idx]
      const eqMatch = REQUIRE_FLAG_EQ_RE.exec(el)
      if (eqMatch && RUNNER_TOKEN_RE.test(eqMatch[1])) return denyWithReadOnlyHint('H1', el)
      if (
        REQUIRE_FLAG_RE.test(el) &&
        idx + 1 < scanArgvLower.length &&
        RUNNER_TOKEN_RE.test(scanArgvLower[idx + 1])
      ) {
        return denyWithReadOnlyHint('H1', scanArgvLower[idx + 1])
      }
    }
  }

  for (const el of scanArgvLower) {
    for (const view of tokenViews(el)) {
      if (H2_RE1.test(view) || H2_RE3.test(view)) return denyWithReadOnlyHint('H2', el)
      if (
        H2_RE2.test(view) &&
        scanArgvLower.some((a) => tokenViews(a).some((v) => v.includes('@claude-flow')))
      ) {
        return denyWithReadOnlyHint('H2', el)
      }
    }
  }

  for (const el of scanArgvLower) {
    for (const view of tokenViews(el)) {
      const base = basenameOf(view)
      const dir = dirnameOf(view)
      if (
        H3_NAMES.has(base) &&
        (dir.endsWith('node_modules/.bin') || dir.endsWith('lib/node_modules/ruflo/bin'))
      ) {
        return denyWith('H3', el)
      }
    }
  }

  if (H4_NAMES.has(argvLower[0])) return denyWith('H4', argvLower[0])

  for (let i = 0; i < argvLower.length; i++) {
    if (!RUNNER_BASENAMES.has(basenameOf(argvLower[i]))) continue
    for (const el of argvLower.slice(i + 1)) {
      if (RUNNER_TOKEN_RE.test(el) || H5_NPM_COLON_RE.test(el) || H5_PACKAGE_FLAG_RE.test(el)) {
        return denyWith('H5', el)
      }
    }
  }

  for (const el of scanArgvLower) {
    for (const view of tokenViews(el)) {
      if (
        H6_NPX_DIR_RE.test(view) &&
        scanArgvLower.some((a) =>
          tokenViews(a).some((v) => v.includes('ruflo') || v.includes('@claude-flow'))
        )
      ) {
        return denyWith('H6', el)
      }
    }
  }

  for (const el of scanArgvLower) {
    for (const view of tokenViews(el)) {
      if (H7_RE1.test(view) || H7_RE2.test(view)) return denyWithReadOnlyHint('H7', el)
    }
  }

  return null
}
