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
 * An INPUT-redirect operator, optionally fd-prefixed: `<`, `N<`, `<>`.
 * `<&` (fd duplication) names no file. `<<<` (here-string) carries TEXT,
 * not a filename -- `cat <<< .env` prints those four characters (measured,
 * all three shells) -- and `<<`/`<<-` never reach here, becoming heredoc
 * tokens instead.
 */
const INPUT_REDIRECT_OP_RE = /^[0-9]*(?:<>|<(?![<&]))/

/**
 * Every INPUT-redirect source named in one segment, glued (`<.env`) or
 * space-separated (`< .env`).
 *
 * An input redirect hands the file to the segment's command on stdin, so
 * its source is a read target of that command exactly as an argv path is:
 * `cat < f`, `cat <f`, `cat 0< f`, `grep KEY < f`, `base64 < f` all emit
 * the contents (measured in bash 3.2, bash 5.2 and zsh 5.9). SMI-6869
 * Fix A tagged BOTH the operator word and a space-separated target
 * `redirect: true` so a trailing `2>&1` could not perturb a verdict, and
 * each consumer therefore drops every redirect-marked word from argv. That
 * is right for an OUTPUT redirect and wrong for an input one, which
 * silently turned sixteen spellings of a protected read from deny into
 * allow in `env-read-guard.mjs` (regression at `50d38872d`, found by the
 * post-merge retro of PR #2970). Recovering only the INPUT sources leaves
 * Fix A's own property intact.
 * @param {Array<{type: string, value?: string, redirect?: boolean}>} segment
 * @returns {string[]}
 */
export function inputRedirectSources(segment) {
  const sources = []
  for (let i = 0; i < segment.length; i++) {
    const w = segment[i]
    if (w.type !== 'word' || w.redirect !== true) continue
    const op = INPUT_REDIRECT_OP_RE.exec(w.value)
    if (op === null) continue
    const glued = w.value.slice(op[0].length)
    if (glued !== '') {
      sources.push(glued)
      continue
    }
    // A bare operator's target is the NEXT token, tagged `redirect: true`
    // as its pending target by the tokenizer (`awaitingRedirectTarget`).
    const target = segment[i + 1]
    if (target?.type === 'word' && target.redirect === true) sources.push(target.value)
  }
  return sources
}

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
 * The separators MINUS `(`/`)`, i.e. parens read as GROUPING rather than as
 * statement boundaries -- the same set `ruflo-host-guard-consumers-git.mjs`
 * uses for a git config value (ADR-172 sec 2).
 */
const SEPARATOR_OPS_PARENS_GROUPING = new Set(
  [...SEGMENT_SEPARATOR_OPS].filter((op) => op !== '(' && op !== ')')
)

/**
 * The same split with `(`/`)` treated as grouping. Splitting on a paren is
 * right for a real subshell (`(cat f)` -- its inner command needs its own
 * segment) and WRONG for a `(` in WORD position, where it tears an argument
 * away from the command it belongs to. zsh's glob alternation is exactly
 * that shape: `cat (.env|zzz)` is ONE command reading `.env` (measured in
 * zsh 5.9, the shell Claude Code's Bash tool runs on this machine -- it
 * emits the file's contents; both bashes reject the syntax), but the
 * separator reading produced the three segments `cat` / `.env` / `zzz`, so
 * the reader lost its argument and the path became a harmless-looking
 * `argv[0]`. This is the paren twin of the brace fault round 15 fixed for
 * `cat ${HOME}/.env`, and it is fixed the same way: an extra reading, not a
 * changed shared set -- `SEGMENT_SEPARATOR_OPS` is also the ruflo host
 * guard's own `SPLIT_OPS`.
 * @param {Array<{type: string, value?: string}>} tokens
 * @returns {Array<Array<object>>}
 */
export function splitCommandSegmentsParensGrouping(tokens) {
  const segments = []
  let current = []
  // Depth of open WORD-position paren groups. Inside one, NO op is a
  // statement separator: zsh's `cat (zzz|.env)` is a single word whose `|`
  // is a glob alternation, not a pipe, so splitting there put `.env` in its
  // own segment and the read went unseen. The tokenizer tags both paren op
  // tokens with `wordGroup` for exactly this (a real subshell's `|` IS a
  // pipe and still splits).
  let wordGroupDepth = 0
  for (const token of tokens) {
    if (token.type === 'op') {
      if (token.value === '(') {
        if (token.wordGroup === true) wordGroupDepth++
        continue
      }
      if (token.value === ')') {
        if (token.wordGroup === true && wordGroupDepth > 0) wordGroupDepth--
        continue
      }
      if (wordGroupDepth > 0) continue
      if (!SEPARATOR_OPS_PARENS_GROUPING.has(token.value)) continue
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
 * `splitCommandSegments` PLUS `groupingOpSubRuns` PLUS the paren-grouping
 * reading, for a consumer that checks a segment's `argv[0]` as its command
 * name. A violation found in ANY of the three denies, which is strictly more
 * conservative than any one alone and so cannot move a verdict toward ALLOW:
 * the caller scans every segment and returns on the first violation, so
 * adding segments can only add denials.
 * @param {Array<{type: string, value?: string}>} tokens
 * @returns {Array<Array<object>>}
 */
export function splitCommandSegmentsWithSubRuns(tokens) {
  return splitCommandSegments(tokens)
    .concat(groupingOpSubRuns(tokens))
    .concat(splitCommandSegmentsParensGrouping(tokens))
}
