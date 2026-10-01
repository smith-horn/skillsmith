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

import { nestedGroupAlternatives, transparentHeadReadings } from './shell-command-readings.mjs'

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
 *
 * A source that is itself a command substitution supplies its OUTPUT as the
 * filename, so the body's own words are read targets of this segment exactly
 * as they are when the substitution sits in an argv slot: `cat < $(echo .env)`
 * and `cat <$(echo .env)` emit a decoy file's contents in bash 3.2, bash 5.2
 * and zsh 5.9 while the argv twin `cat $(echo .env)` already denied (measured,
 * SMI-6903 round 21). Pass the caller's own `flattenSubWords` to recover them;
 * omit it for literal sources only. ADR-172 sec 1 names both classes -- an
 * input-redirect source AND a command-substitution body at any depth -- so
 * this is one enumerated class reaching another, not a new one.
 *
 * Truncation past `MAX_DEPTH` needs no handling here: the caller recurses
 * every word's `.subs` (redirect-marked words included) BEFORE this runs and
 * returns its own `depth-cap` violation at the same constant -- the argument
 * `checkUnresolvedHeadTail`'s `onTruncated` docblock makes for its own caller,
 * and executed here (a 7-deep redirect source denies `depth-cap`, pinned).
 * @param {Array<{type: string, value?: string, redirect?: boolean, subs?: string[]}>} segment
 * @param {((words: Array<object>) => {words: string[]}) | null} [flattenSubWords]
 * @returns {string[]}
 */
export function inputRedirectSources(segment, flattenSubWords = null) {
  const sources = []
  const sourceWords = []
  for (let i = 0; i < segment.length; i++) {
    const w = segment[i]
    if (w.type !== 'word' || w.redirect !== true) continue
    const op = INPUT_REDIRECT_OP_RE.exec(w.value)
    if (op === null) continue
    const glued = w.value.slice(op[0].length)
    if (glued !== '') {
      sources.push(glued)
      sourceWords.push(w)
      continue
    }
    // A bare operator's target is the NEXT token, tagged `redirect: true`
    // as its pending target by the tokenizer (`awaitingRedirectTarget`).
    const target = segment[i + 1]
    if (target?.type === 'word' && target.redirect === true) {
      sources.push(target.value)
      sourceWords.push(target)
    }
  }
  if (flattenSubWords === null || sourceWords.length === 0) return sources
  return sources.concat(flattenSubWords(sourceWords).words)
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
 * The argv of each segment of a shell BODY (a `bash -c` string), redirect
 * words excluded. Whole argvs rather than head words, so a caller's
 * flag-sensitive exceptions still see their flags: with heads alone
 * `bash -c 'grep -q K' < .env` denied while `grep -q K .env` allowed
 * (measured on the first draft of the fix below).
 * @param {(command: string) => Array<object>} tokenizeFn the caller's `tokenize`
 * @param {string} body
 * @returns {string[][]}
 */
export function shellBodySegmentArgvs(tokenizeFn, body) {
  if (typeof body !== 'string' || body.trim() === '') return []
  const argvs = []
  for (const segment of splitCommandSegments(tokenizeFn(body))) {
    const argv = segment.filter((t) => t.type === 'word' && t.redirect !== true).map((t) => t.value)
    if (argv.length > 0) argvs.push(argv)
  }
  return argvs
}

/**
 * The caller's own `checkArgv`, re-run over each command in a WRAPPER's nested
 * body with that wrapper's own input-redirect sources appended.
 *
 * A wrapper's redirect feeds the BODY's stdin, so the source is a read target
 * of whichever command in the body reads it -- but the body is evaluated as
 * TEXT, so there is no argv for the caller to append the source to, and
 * `bash -c 'cat' < .env`, `sh -c 'cat' < .env`,
 * `docker exec c bash -c 'cat' < /app/.env` and
 * `varlock run -- bash -c 'cat' < .env` all reached ALLOW while their argv
 * twins denied, every one of them emitting a decoy file's contents in bash
 * 3.2, bash 5.2 and zsh 5.9 (SMI-6903 round 21). Every existing exception
 * still applies, since the caller's own `checkArgv` runs:
 * `bash -c 'wc -l' < .env` stays allowed exactly as `wc .env` is.
 *
 * Stated limit: ONE level. A body that is itself a wrapper
 * (`bash -c "bash -c 'cat'" < .env`) is not descended into -- the caller's own
 * recursion covers the body's argv paths; only the source injection stops here.
 * @param {string} body the wrapper's nested command text
 * @param {string[]} sources this segment's input-redirect sources
 * @param {{tokenize: Function, normalizeWrappers: Function, checkArgv: Function}} deps
 * @returns {object|null} the caller's own violation shape, or null
 */
export function checkNestedRedirectSources(body, sources, deps) {
  if (sources.length === 0) return null
  for (const argv of shellBodySegmentArgvs(deps.tokenize, body)) {
    const violation = deps.checkArgv(deps.normalizeWrappers(argv).argv.concat(sources))
    if (violation) return violation
  }
  return null
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
 * The one cap on the glob-group expansion below: the size of the cross
 * product. Past it the expansion is abandoned whole rather than truncated and
 * reports `null`, distinct from the `[]` of "nothing to expand", so a consumer
 * can FAIL CLOSED (SMI-6903 round 22 F2: `[]` for both left the ruflo guard
 * allowing a five-group path zsh 5.9 invokes). The round-21 cap on the NUMBER
 * of groups is gone: a one-alternative group is one reading, and inline
 * scripts (`node -e 'a(1); b(2); …'`) and SQL text carry many, so that cap
 * plus a fail-closed consumer denied real text (measured). 64 is 2^6 two-way
 * alternations, each one evaluator pass.
 */
export const MAX_GLOB_READINGS = 64

/**
 * One word-position paren group: its `(`/`)` indices and its `|`-separated
 * alternatives. A group containing a NESTED paren is read through
 * `nestedGroupAlternatives` (SMI-6903 round 21 F4) -- zsh nests glob
 * alternations and invokes through them, so skipping such a group left the H1
 * fix bypassable by one extra paren; see that function for the measurement and
 * for the approximation it accepts.
 * @param {Array<object>} tokens
 * @param {number} open index of the `(` op token
 */
function readWordGroup(tokens, open) {
  let close = open + 1
  let depth = 0
  let nested = false
  while (close < tokens.length) {
    const t = tokens[close]
    if (t.type === 'op' && t.value === '(') {
      depth++
      nested = true
    } else if (t.type === 'op' && t.value === ')') {
      if (depth === 0) break
      depth--
    }
    close++
  }
  if (close >= tokens.length || tokens[close].wordGroup !== true) return null
  if (nested) {
    const alts = nestedGroupAlternatives(tokens, open, close)
    return alts === null ? null : { open, close, alts }
  }
  // Alternatives are the `|`-separated word runs inside the group. Any other
  // op inside is skipped rather than treated as a separator.
  const alts = [[]]
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k]
    if (t.type === 'op') {
      if (t.value === '|') alts.push([])
      continue
    }
    alts[alts.length - 1].push(t)
  }
  // A zsh glob alternative cannot contain an unquoted blank -- a blank would
  // end the word, which is what makes the group a glob in the first place. So
  // a group holding a MULTI-WORD alternative is not a glob alternation at
  // all; it is an array assignment or append (`a=(1 2)`,
  // `args+=(--profile "$p")`), the divergent shape rounds 16-17 already
  // singled out. Expanding one concatenated its words into a single bogus
  // word, and that cost a real false positive: the repository's own
  // `compose_profile_args+=(--profile "$profile")` rebuilt as a `$`-bearing
  // `argv[0]` and denied `unresolved-command` (measured on the corpus, the
  // only difference of the 8,534 -- now zero). Skipping loses no glob,
  // because no glob has that shape.
  if (alts.some((a) => a.length > 1)) return null
  return { open, close, alts }
}

/**
 * Group the collected groups into WELD CHAINS: maximal runs that the shell
 * fuses into one word. Two groups join a chain when they are directly
 * adjacent (`(a|b)(c|d)`) or separated by a single word welded to both
 * (`./(a|node_modules)/(x|.bin)/ruflo`, where the `/` between them belongs to
 * BOTH). Chaining is not cosmetic: treating such groups independently made
 * their rebuild spans overlap, and the shared word was consumed twice, so the
 * two-group path shape silently produced no usable reading at all (measured —
 * zsh 5.9 runs `./(a|node_modules)/(x|.bin)/tool`).
 * @param {Array<object>} tokens
 * @param {Array<{open: number, close: number, alts: Array<Array<object>>}>} groups
 */
function weldChains(tokens, groups) {
  const isWord = (i) => i >= 0 && i < tokens.length && tokens[i]?.type === 'word'
  const chains = []
  for (const g of groups) {
    const prev = chains[chains.length - 1]
    const last = prev?.groups[prev.groups.length - 1]
    const adjacent = last !== undefined && g.open === last.close + 1
    const sharedWord =
      last !== undefined &&
      g.open === last.close + 2 &&
      isWord(last.close + 1) &&
      tokens[last.close].gluedRight === true &&
      tokens[g.open].gluedLeft === true
    if (prev !== undefined && (adjacent || sharedWord)) {
      prev.groups.push(g)
      continue
    }
    chains.push({ groups: [g] })
  }
  for (const chain of chains) {
    const first = chain.groups[0]
    const lastG = chain.groups[chain.groups.length - 1]
    chain.start =
      tokens[first.open].gluedLeft === true && isWord(first.open - 1) ? first.open - 1 : first.open
    chain.end =
      tokens[lastG.close].gluedRight === true && isWord(lastG.close + 1)
        ? lastG.close + 1
        : lastG.close
  }
  return chains
}

/**
 * One reading of `tokens` with every chain collapsed to a single word built
 * from the chosen alternative of each of its groups.
 * @param {Array<object>} tokens
 * @param {Array<object>} chains
 * @param {Map<object, number>} chosen group -> chosen alternative index
 */
function buildGlobReading(tokens, chains, chosen) {
  const replaceAt = new Map()
  const skip = new Set()
  for (const chain of chains) {
    const parts = []
    let i = chain.start
    while (i <= chain.end) {
      const group = chain.groups.find((g) => g.open === i)
      if (group !== undefined) {
        parts.push(...(group.alts[chosen.get(group)] ?? []))
        i = group.close + 1
        continue
      }
      if (tokens[i].type === 'word') parts.push(tokens[i])
      i++
    }
    replaceAt.set(chain.start, {
      type: 'word',
      value: parts.map((w) => w.value).join(''),
      subs: parts.flatMap((w) => w.subs ?? []),
    })
    for (let k = chain.start; k <= chain.end; k++) skip.add(k)
  }
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    if (replaceAt.has(i)) out.push(replaceAt.get(i))
    if (!skip.has(i)) out.push(tokens[i])
  }
  return out
}

/**
 * Every reading of `tokens` in which each WORD-position paren group is
 * replaced by one of its alternatives, welded back onto the words glued to it.
 *
 * zsh's glob alternation makes `./(node_modules|x)/.bin/ruflo` ONE word that
 * expands to `./node_modules/.bin/ruflo` — measured in zsh 5.9, the shell
 * Claude Code's Bash tool runs here, with the executable actually invoked.
 * A segmentation that splits on `(`, `|` and `)` leaves `x` as the segment's
 * `argv[0]` and `/.bin/ruflo` as a mere argument, so an `argv[0]`-keyed check
 * never sees the real command name. This rebuilds the words the shell would
 * actually form, so the SAME per-segment checks can run over each one.
 *
 * Returns `[]` when there is nothing to expand, so a caller pays nothing on
 * the overwhelming majority of command lines, and `null` when there IS
 * something to expand but it is past a cap, so a caller can refuse what it
 * could not read. Deliberately ADDITIVE otherwise: the caller keeps its own
 * primary reading and only ADDS verdicts from these, so an approximate rebuild
 * (a multi-word alternative is concatenated; a nested group is flattened) can
 * only ever over-block, never under-block. Changing the primary reading instead
 * was measured and rejected — it moved 21 real repository command lines from
 * deny to allow.
 * @param {Array<object>} tokens
 * @returns {Array<Array<object>>|null}
 */
export function globGroupAlternativeReadings(tokens) {
  const groups = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'op' || t.value !== '(' || t.wordGroup !== true) continue
    const group = readWordGroup(tokens, i)
    if (group === null) continue
    groups.push(group)
    i = group.close
  }
  if (groups.length === 0) return []
  let total = 1
  for (const g of groups) total *= Math.max(g.alts.length, 1)
  if (total > MAX_GLOB_READINGS) return null
  const chains = weldChains(tokens, groups)
  const readings = []
  const walk = (gi, chosen) => {
    if (gi === groups.length) {
      readings.push(buildGlobReading(tokens, chains, chosen))
      return
    }
    const g = groups[gi]
    for (let a = 0; a < Math.max(g.alts.length, 1); a++) {
      chosen.set(g, a)
      walk(gi + 1, chosen)
    }
    chosen.delete(g)
  }
  walk(0, new Map())
  return readings
}

/**
 * `splitCommandSegments` PLUS `groupingOpSubRuns` PLUS the paren-grouping
 * reading PLUS the transparent-head reading of each of the first and third
 * (SMI-6903 round 21), for a consumer that checks a segment's `argv[0]` as its
 * command name. A violation in ANY of the four denies, so adding a reading can
 * only add denials. `peelWrappers` is the caller's own wrapper normalizer,
 * handed to the transparent-head reading so a launcher behind a wrapper the
 * caller peels (`sudo timeout 5 cat .env`) is read through (round 22 F1).
 * @param {Array<{type: string, value?: string}>} tokens
 * @param {((argv: string[]) => {argv: string[], nested: string|null}) | null} [peelWrappers]
 * @returns {Array<Array<object>>}
 */
export function splitCommandSegmentsWithSubRuns(tokens, peelWrappers = null) {
  const separator = splitCommandSegments(tokens)
  const grouping = splitCommandSegmentsParensGrouping(tokens)
  return separator
    .concat(groupingOpSubRuns(tokens))
    .concat(grouping)
    .concat(transparentHeadReadings(separator, peelWrappers))
    .concat(transparentHeadReadings(grouping, peelWrappers))
}
