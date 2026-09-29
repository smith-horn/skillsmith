/**
 * npm-specific Stage-1 allowlist predicates for `scripts/ruflo-host-guard.mjs`
 * (SMI-6744 Wave 4 Stage 1 row 3; SMI-6869 Fix D). Split out of
 * `ruflo-host-guard-predicates.mjs` purely to stay under the 500-line-per-
 * file convention this repo keeps by hand for .mjs files under scripts/
 * (M3 correction: not enforced by tooling here — `scripts/check-file-
 * length.mjs` only runs via `lint-staged` for `*.ts`/`*.sh`; SMI-5994)
 * once Fix D's read-only-subcommand predicate pushed that file over the
 * limit — both
 * exports here are pure functions/constants, no I/O, no state, grouped
 * together because they are the two halves of "which npm invocations this
 * guard already knows are safe regardless of what H1–H8 would otherwise
 * say about them."
 */

import { basenameOf } from './shell-command-normalize.mjs'

/** The exact npm inspection/remediation forms Stage 1 allows (design § 1(b) row 3). */
const NPM_ALLOW_FORMS = [
  ['ls', '-g', 'ruflo'],
  ['view', 'ruflo'],
  ['uninstall', '-g', 'ruflo'],
]

/** The uninstall form, named separately so the L-B `--dry-run` allowance below can reference it. */
const NPM_UNINSTALL_FORM = ['uninstall', '-g', 'ruflo']

/**
 * Stage 1 row 3 — the three exact npm inspection/remediation forms,
 * evaluated AFTER normal wrapper normalization (same stage as H1–H8).
 *
 * `npm uninstall -g ruflo --dry-run` is also sanctioned (L-B fix, SMI-6744
 * Wave 4 governance round) — named as its own exact suffix, not a generic
 * "any extra flag is fine" widening: `--dry-run` makes this form STRICTLY
 * SAFER than the already-sanctioned bare uninstall (no actual removal
 * happens), so accepting it narrows nothing this Stage 1 allowlist
 * otherwise protects.
 * @param {string[]} argvLower the post-normalize, lowercased argv
 */
export function isSanctionedNpmForm(argvLower) {
  if (argvLower.length === 0) return false
  if (basenameOf(argvLower[0]) !== 'npm') return false
  const rest = argvLower.slice(1)
  if (
    NPM_ALLOW_FORMS.some(
      (form) => rest.length === form.length && form.every((tok, i) => rest[i] === tok)
    )
  ) {
    return true
  }
  return (
    rest.length === NPM_UNINSTALL_FORM.length + 1 &&
    NPM_UNINSTALL_FORM.every((tok, i) => rest[i] === tok) &&
    rest[NPM_UNINSTALL_FORM.length] === '--dry-run'
  )
}

/**
 * npm subcommands whose OWN semantics never execute a package-name
 * argument as a process — they only inspect metadata (dependency-tree
 * queries, registry lookups) (SMI-6869 Fix D). `ll`/`la` are documented
 * npm aliases for `ls -l`/`ls -a`; `config get` is handled as its own
 * two-token pair below rather than added here, since `config` alone has
 * OTHER subcommands (`config set`, `config edit`) that are out of scope.
 */
const READ_ONLY_NPM_SUBCOMMANDS = new Set([
  'ls',
  'list',
  'll',
  'la',
  'view',
  'info',
  'show',
  'explain',
  'why',
  'outdated',
  'search',
])

/**
 * Fix D (SMI-6869) — `npm ls ruflo` (and its siblings: `view`, `explain`,
 * `outdated`, `search`, `config get`, …) denied via the H5 arm before this:
 * H5 only ever checks "does a RUNNER_TOKEN_RE-shaped token appear anywhere
 * after a runner basename", with no notion that npm's OWN subcommand
 * determines whether the argument that follows is ever executed. These
 * subcommands print or query metadata; they never spawn the named package
 * as a process, unlike `npm exec`/`npm x`/a bare `npx`, which stay on the
 * normal H5/H8(ii) path untouched by this check (their own subcommand is
 * not in `READ_ONLY_NPM_SUBCOMMANDS`). Checked in `evaluateGuardSegment`
 * alongside `isSanctionedNpmForm`, before H1–H7 — unlike that function's
 * own EXACT-form matching, this one recognizes the whole subcommand
 * SHAPE regardless of what flags or package-name argument follows, since
 * none of these subcommands' own arguments are ever executed no matter
 * what they name.
 * @param {string[]} argvLower the post-normalize, lowercased argv
 */
export function isReadOnlyNpmForm(argvLower) {
  if (argvLower.length < 2) return false
  if (basenameOf(argvLower[0]) !== 'npm') return false
  const sub = argvLower[1]
  if (READ_ONLY_NPM_SUBCOMMANDS.has(sub)) return true
  return sub === 'config' && argvLower[2] === 'get'
}
