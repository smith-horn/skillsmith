/**
 * `checkRunnerVariableArgument` (H8(ii)) for `scripts/ruflo-host-guard.mjs`.
 * Split out of `ruflo-host-guard-predicates.mjs` (governance-round M3 file-
 * length follow-up) purely to stay under the 500-line-per-file convention
 * this repo keeps by hand for .mjs files under scripts/ (not enforced by
 * tooling here — `scripts/check-file-length.mjs` only runs via
 * `lint-staged` for `*.ts`/`*.sh`; SMI-5994) once that file's own M3/L2/L4
 * governance-round docblock corrections pushed it to 502 lines — this
 * predicate and its two supporting tables (`RUNNER_VALUE_FLAGS`,
 * `RUNNER_SUBCOMMANDS`) have no dependency on anything defined only in
 * `ruflo-host-guard-predicates.mjs` (unlike `checkAssignmentValuePredicate`/
 * `checkBraceSegment`, which both still need that file's own `H4B_NAMES`),
 * so it moves cleanly. Re-exported from `ruflo-host-guard-predicates.mjs`
 * so `scripts/ruflo-host-guard.mjs`'s own import statement needed no
 * change, the same pattern that file's own docblock already documents for
 * `checkH1toH7`/`isSanctionedNpmForm`/`isReadOnlyNpmForm`.
 */

import { basenameOf } from './shell-command-normalize.mjs'
import { RUNNER_BASENAMES } from './ruflo-host-guard-h1to7.mjs'
import { denyWith } from './ruflo-host-guard-verdicts.mjs'

/**
 * Value-taking flags shared across npx/npm/pnpm/yarn/bun/corepack/deno's
 * own top-level options (H-5 fix, SMI-6744 Wave 4 governance round): each
 * consumes the FOLLOWING token as ITS OWN value, so the generic
 * "unrecognized flag, skip just it" fallback below must not treat that
 * value as the runner's package-name slot. Before this fix, `npx --cache
 * /tmp "$V"` wrongly identified `/tmp` (the flag's own value) as the
 * package-name slot and never examined `$V` at all — a live bypass, not a
 * cosmetic mis-scan.
 */
const RUNNER_VALUE_FLAGS = new Set([
  '--cache',
  '--userconfig',
  '--prefix',
  '--registry',
  '--workspace',
  '-w',
  '--node-options',
  '--shell',
  '-c',
])

/**
 * Runner subcommands that themselves precede the real package-name
 * argument, keyed by the runner's own basename (H-5 fix): `pnpm dlx`/
 * `yarn dlx`, `bun x`, `deno run`/`deno install`. `npm`'s own `exec`/`x`
 * subcommand is handled separately below (pre-existing) since it also
 * needs its own `--` handling; `corepack`'s nested-runner-name token
 * (`corepack npx …`, `corepack pnpm …`) is handled separately too — it
 * substitutes for a runner rather than being one of a FIXED runner's own
 * subcommands.
 */
const RUNNER_SUBCOMMANDS = new Map([
  ['pnpm', new Set(['dlx'])],
  ['yarn', new Set(['dlx'])],
  ['bun', new Set(['x'])],
  ['deno', new Set(['run', 'install'])],
])

/**
 * H8(ii) — "deny the runner-with-a-variable-argument shape" (a44 § 5 D11
 * candidate closure (ii), the owner's chosen primary closure). Runs on the
 * POST-normalize argv/tokens: argv[0]'s basename must be a runner, and the
 * runner's own PACKAGE-NAME SLOT must have EITHER a `$` in its raw
 * `.value` OR a non-empty `.subs` (the `.subs` half covers `<(...)`/`>(...)`
 * process substitutions, whose `.value` keeps `<(`/`>(` and holds no `$`).
 *
 * Narrowed from "any later token" to "the package-name slot only" (M-A
 * fix, SMI-6744 Wave 4 governance round): the original scanned every
 * position after the runner, denying ordinary repo commands whose TARGET
 * argument (not the package name) carries a shell variable — `npx vitest
 * run "$F"`, `npx prettier --write "$f"`, `npm run build --workspace=$W`.
 * The slot is: the first non-flag argument after the runner (skipping the
 * runner's own leading flags — now RUNNER_VALUE_FLAGS-aware, H-5 fix —
 * and, for `npm`, an `exec`/`x` subcommand and its own `--`, or for
 * `pnpm`/`yarn`/`bun`/`deno`, their own RUNNER_SUBCOMMANDS entry, or for
 * `corepack`, its nested runner-name token), plus the value of
 * `-p`/`--package`/`--package=`/`-p=` (L-3 fix: `-p=` was missing beside
 * the already-recognized `--package=`).
 *
 * H-5 fail-closed fallback: when this scan never identifies ANY slot at
 * all (every remaining token looked like a flag, including one of
 * RUNNER_VALUE_FLAGS whose OWN value ran off the end of argv, e.g. `npx
 * --cache "$V"` with nothing after `$V`), deny if any later token still
 * carries an unresolved `$`/`.subs` — a runner invocation whose shape this
 * scan cannot parse must not silently let a variable argument through
 * completely unexamined just because it happened to sit in a flag's own
 * value position.
 * @param {string[]} argvLower
 * @param {Array<{value: string, subs?: string[]}>} alignedTokens the
 *   ORIGINAL (non-lowercased) tokens aligned 1:1 with argvLower — see
 *   `tokensForArgv` in the guard's own orchestration file.
 */
export function checkRunnerVariableArgument(argvLower, alignedTokens) {
  if (argvLower.length === 0) return null
  const runnerBase = basenameOf(argvLower[0])
  if (!RUNNER_BASENAMES.has(runnerBase)) return null

  const slots = new Set()
  let i = 1

  if (runnerBase === 'corepack') {
    if (i < argvLower.length) i++ // the nested package-manager name
  } else if (runnerBase === 'npm' && (argvLower[i] === 'exec' || argvLower[i] === 'x')) {
    i++
    if (argvLower[i] === '--') i++
  } else {
    const subcommands = RUNNER_SUBCOMMANDS.get(runnerBase)
    if (subcommands && subcommands.has(argvLower[i])) i++
  }

  while (i < argvLower.length) {
    const tok = argvLower[i]
    if (tok === '-p' || tok === '--package') {
      if (i + 1 < argvLower.length) slots.add(i + 1)
      i += 2
      continue
    }
    if (tok.startsWith('--package=') || tok.startsWith('-p=')) {
      slots.add(i)
      i += 1
      continue
    }
    if (RUNNER_VALUE_FLAGS.has(tok)) {
      i += 2
      continue
    }
    if (tok.startsWith('-') && tok !== '-') {
      i += 1
      continue
    }
    slots.add(i)
    break
  }

  if (slots.size === 0) {
    // No slot could be identified at all -- every remaining token looked
    // like a flag (possibly one of RUNNER_VALUE_FLAGS whose own value ran
    // off the end of argv, e.g. `npx --cache "$V"`). Re-scan every token
    // after the runner name, since nothing was actually examined above.
    for (let idx = 1; idx < alignedTokens.length; idx++) {
      const tok = alignedTokens[idx]
      if (tok && (tok.value.includes('$') || (tok.subs && tok.subs.length > 0))) {
        return denyWith('H8', tok.value)
      }
    }
  }

  for (const idx of slots) {
    const tok = alignedTokens[idx]
    if (!tok) continue
    if (tok.value.includes('$') || (tok.subs && tok.subs.length > 0)) {
      return denyWith('H8', tok.value)
    }
  }
  return null
}
