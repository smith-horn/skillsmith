/**
 * `checkUnresolvedCommand` for `scripts/ruflo-host-guard.mjs`. Split into
 * its own file (SMI-6869 governance-round patch) purely to stay under the
 * 500-line-per-file convention this repo keeps by hand for .mjs files
 * under scripts/ (M3 correction: not enforced by tooling here —
 * `scripts/check-file-length.mjs` only runs via `lint-staged` for
 * `*.ts`/`*.sh`; SMI-5994) once that file's own C1/C2 patch additions
 * pushed it over — this predicate has no
 * dependency on anything defined only in the orchestration file, so it
 * moves cleanly; `ruflo-host-guard-predicates.mjs` was the next-closest
 * home (same "predicate logic" theme) but was itself too close to the
 * limit to absorb it without repeating the same problem one file over.
 */

import { denyWith } from './ruflo-host-guard-verdicts.mjs'

/**
 * A fix (SMI-6744 Wave 4 governance round) — fail-closed fall-through,
 * closing H-1/H-2/H-5/H-7/L-1/M-6 at the MECHANISM level rather than
 * one-off per instance. Once wrappers/launchers are peeled and Stage 1
 * has not matched, argv[0] must be a REAL, resolvable command name for
 * the H1–H8 predicates to mean anything: a launcher's own arity table, or
 * a wrapper's own flag-skipping, can be mis-modelled against a command
 * this guard never actually gets to see — in that case the "residual"
 * argv evaluated is not the command the shell will actually run, and
 * every H-predicate tests the WRONG thing. Denies when:
 *   - the residual argv is EMPTY (a launcher/wrapper claimed the whole
 *     rest of argv was its own flags) — UNLESS every raw token in this
 *     segment was itself `VAR=val`-shaped, meaning there never was a
 *     command here to lose (a bare `FOO=bar` statement is genuinely
 *     empty, not mis-modelled; `V=ru; npx "${V}flo" …`'s own first
 *     segment is exactly this shape, and must stay allowed so the
 *     SECOND segment's own H8(ii) denial is the one this guard reports);
 *   - argv[0] is `--` (a stray separator with nothing after it);
 *   - argv[0] is a bare, all-digit token (a launcher's arity table
 *     over-consumed a real command name, leaving only its own numeric
 *     argument, e.g. a mis-modelled `chrt`/`timeout` positional);
 *   - argv[0] is a `/dev/*` path (a launcher's own output-file argument
 *     mistaken for a command);
 *   - argv[0]'s own token carries `$` in `.value` or a non-empty `.subs`
 *     — an UNRESOLVABLE command name this guard cannot statically
 *     resolve (the motivating case: `NPX=npx; $NPX ruflo …`).
 * A mis-modelled arity must never fall through to an ALLOW.
 *
 * `embedded` (SMI-6869 Fix C, corrected) skips the empty-residual,
 * all-digit, `/dev/*`, and `$`-in-head arms — all four presume real shell
 * text, false once re-scanning INLINE SCRIPT TEXT (`node -e '...'`):
 * `padEnd(15)`-shaped punctuation trips the first three; a bare `$` in a
 * JS/Python string (`readFileSync('$SP/x','utf8')`) is not a shell
 * expansion, so the fourth must gate too (the original Fix C left it on,
 * denying a real script that never invoked ruflo). Only `--` stays active.
 * @param {string[]} rawValues pre-strip word values for this segment
 * @param {string[]} normalizedArgv post wrapper/launcher-peel argv
 * @param {Array<{value: string, subs?: string[]}>} alignedTokens original
 *   tokens aligned to `normalizedArgv` (see `tokensForArgv`)
 * @param {boolean} embedded
 */
export function checkUnresolvedCommand(rawValues, normalizedArgv, alignedTokens, embedded) {
  if (normalizedArgv.length === 0) {
    if (embedded) return null
    const allAssignments =
      rawValues.length > 0 && rawValues.every((v) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(v))
    if (allAssignments) return null
    return denyWith('unresolved-command', '(empty residual command after wrapper/launcher peeling)')
  }
  const head = normalizedArgv[0]
  const headToken = alignedTokens[0]
  if (head === '--') return denyWith('unresolved-command', head)
  if (!embedded && /^[0-9]+$/.test(head)) return denyWith('unresolved-command', head)
  if (!embedded && head.startsWith('/dev/')) return denyWith('unresolved-command', head)
  // SMI-6869 Fix C correction: a `$` in JS/Python string text isn't a
  // shell expansion — gate this arm too when embedded (see docblock).
  if (
    !embedded &&
    headToken &&
    (headToken.value.includes('$') || (headToken.subs && headToken.subs.length > 0))
  ) {
    return denyWith('unresolved-command', headToken.value)
  }
  return null
}
