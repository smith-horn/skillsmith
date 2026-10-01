/**
 * Command segmentation over a `tokenize` stream (SMI-6892 round-15 fix).
 *
 * Split out of `shell-command-normalize.mjs` for the same reason
 * `shell-command-tokenize.mjs` was: to keep every file under the hand-kept
 * 500-line convention (`scripts/check-file-length.mjs` only runs via
 * `lint-staged` for `*.ts`/`*.sh`, so this one is honoured by hand; SMI-5994),
 * and because ADR-172's own Consequences say further shared behaviour goes
 * into a shared module rather than into `env-read-guard.mjs`. Re-exported by
 * `shell-command-normalize.mjs`, so every existing import keeps working.
 */

/**
 * Op values that really END a command. `{`/`}`/`(`/`)` come back from
 * `tokenize` as op tokens unconditionally, but `{`/`}` are bash RESERVED
 * WORDS, not separators, so a consumer that splits on them tears `${VAR}`
 * into pieces -- which is how `cat ${HOME}/.env` reached ALLOW while
 * `cat "${HOME}/.env"` and `cat $HOME/.env` both denied. Deliberately the
 * same set as `ruflo-host-guard-segments.mjs`'s `SPLIT_OPS` and (minus
 * `(`/`)`, which cannot appear in that position) the git consumer's
 * `SEGMENT_BOUNDARY_OPS`; the third copy of this rule, now shared.
 */
export const SEGMENT_SEPARATOR_OPS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')'])

/**
 * Split a token stream into command segments on `SEGMENT_SEPARATOR_OPS`,
 * dropping every other op token and keeping word AND heredoc tokens in the
 * segment they belong to.
 * @param {Array<{type: string, value?: string}>} tokens
 * @returns {Array<Array<object>>}
 */
export function splitCommandSegments(tokens) {
  const segments = []
  let current = []
  for (const token of tokens) {
    if (token.type === 'op') {
      if (!SEGMENT_SEPARATOR_OPS.has(token.value)) continue
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * Every run of words that BEGINS immediately after a dropped op token -- one
 * `splitCommandSegments` skipped rather than split on, i.e. a `{` or a `}`.
 *
 * Not splitting on a brace is what lets `cat ${HOME}/.env` be read as one
 * command, but it also MERGES the words on either side of that brace into one
 * segment, and a consumer that reads `argv[0]` as the command NAME then reads
 * the wrong word: `${X} cat .env` tokenizes as `$` `{` `X` `}` `cat` `.env`,
 * so the merged segment's `argv[0]` is the bare `$` while the shell's own
 * command name is `cat`. Measured in bash 3.2 AND zsh 5.9 (the shell Claude
 * Code's Bash tool runs on this machine): `${X} cat f`, `${X}cat f`,
 * `${A}${B} cat f`, `{ ${X} cat f; }` and `V=${X} cat f` all read `f`, and in
 * zsh `${} cat f` does too (bash rejects that one as a bad substitution).
 * @param {Array<{type: string, value?: string}>} tokens
 * @returns {Array<Array<object>>}
 */
export function groupingOpSubRuns(tokens) {
  const runs = []
  let current = []
  let afterDroppedOp = false
  const flush = () => {
    if (current.length > 0 && afterDroppedOp) runs.push(current)
    current = []
  }
  for (const token of tokens) {
    if (token.type === 'op') {
      const separator = SEGMENT_SEPARATOR_OPS.has(token.value)
      flush()
      // A real separator ends the run AND clears the flag: what follows it is
      // already its own coarse segment, so its run carries nothing extra. A
      // dropped brace ends the run and SETS the flag, because what follows it
      // was merged into the coarse segment that preceded the brace.
      afterDroppedOp = !separator
      continue
    }
    current.push(token)
  }
  flush()
  return runs
}

/**
 * `splitCommandSegments` PLUS `groupingOpSubRuns`, for a consumer that checks
 * a segment's `argv[0]` as its command name. A violation found in either
 * segmentation denies, which is strictly more conservative than either alone
 * and so cannot move a verdict toward ALLOW.
 * @param {Array<{type: string, value?: string}>} tokens
 * @returns {Array<Array<object>>}
 */
export function splitCommandSegmentsWithSubRuns(tokens) {
  return splitCommandSegments(tokens).concat(groupingOpSubRuns(tokens))
}
