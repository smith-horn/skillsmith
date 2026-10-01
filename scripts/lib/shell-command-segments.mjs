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
 * Caps on the glob-group expansion below. Past either one the expansion is
 * abandoned entirely (no extra readings) rather than truncated: a partial
 * cross product would silently check some alternatives and not others, which
 * reads as coverage it did not give. Abandoning leaves exactly the behaviour
 * that existed before the expansion, which is the honest degradation and is
 * recorded as a stated limit rather than a silent one.
 */
const MAX_GLOB_READINGS = 16
const MAX_GLOB_GROUPS = 4

/**
 * One word-position paren group: its `(`/`)` indices and its `|`-separated
 * alternatives. Returns null for a group containing a nested paren, which
 * this expansion deliberately does not handle (skipping it only forgoes extra
 * denials, never adds a wrong one).
 * @param {Array<object>} tokens
 * @param {number} open index of the `(` op token
 */
function readWordGroup(tokens, open) {
  let close = open + 1
  while (close < tokens.length) {
    const t = tokens[close]
    if (t.type === 'op' && t.value === '(') return null
    if (t.type === 'op' && t.value === ')') break
    close++
  }
  if (close >= tokens.length || tokens[close].wordGroup !== true) return null
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
 * the overwhelming majority of command lines. Deliberately ADDITIVE: the
 * caller keeps its own primary reading and only ADDS verdicts from these, so
 * an approximate rebuild (a multi-word alternative is concatenated; a group
 * containing a nested paren is skipped) can only ever over-block, never
 * under-block. Changing the primary reading instead was measured and rejected
 * — it moved 21 real repository command lines from deny to allow.
 * @param {Array<object>} tokens
 * @returns {Array<Array<object>>}
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
  if (groups.length === 0 || groups.length > MAX_GLOB_GROUPS) return []
  let total = 1
  for (const g of groups) total *= Math.max(g.alts.length, 1)
  if (total > MAX_GLOB_READINGS) return []
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
