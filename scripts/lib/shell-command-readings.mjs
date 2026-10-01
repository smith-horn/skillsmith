/**
 * Two readings of a tokenized command that exist because a single reading was
 * wrong about a real shell (SMI-6903 round 21). Both are ADDITIVE: a caller
 * keeps its own primary reading and only ADDS verdicts from these, so an
 * approximate rebuild can only ever over-block, never under-block.
 *
 *   - `transparentHeadReadings` (F1): a shell RESERVED WORD or command
 *     modifier at a segment's head is not the command.
 *   - `nestedGroupAlternatives` (F4): a zsh glob group may contain another
 *     glob group.
 *
 * Every shell claim below was measured in bash 3.2 (host), bash 5.2
 * (container) and zsh 5.9 (host, the shell Claude Code's Bash tool runs on
 * this machine), with a decoy file read or a decoy executable invoked.
 */

/**
 * Words that introduce or modify a command without BEING it.
 *
 * None of them is an operator, so no segmentation can split there -- which
 * left the modifier as `argv[0]` and the reader's own name as a mere
 * argument. Every one of these ALLOWED in `env-read-guard.mjs` before this
 * reading, while emitting a decoy file's contents in all three shells:
 *
 *   if true; then cat .env; fi        if true; then :; else cat .env; fi
 *   for f in a b; do cat .env; done   for ((i=0;i<1;i++)); do cat .env; done
 *   while :; do cat .env; done        until false; do cat .env; done
 *   select f in a; do cat .env; done  time cat .env
 *   command cat .env                  exec cat .env       eval cat .env
 *
 * This is the WORD twin of the brace fault SMI-6892 round 15 fixed for
 * `cat ${HOME}/.env` and the paren fault SMI-6903 C3 fixed for
 * `cat (.env|zzz)`, and it is fixed the same way: an EXTRA reading, never a
 * changed one. ADR-172 sec 1 class 1 (an argv path of a reader command).
 *
 * `fi`/`done`/`esac` are absent: they END a statement and never precede the
 * command they would hide. `in` is absent because the word before it stops
 * the peel (`for f in …` peels `for`, then halts on `f`).
 * `timeout`/`nice`/`xargs` are absent because each takes its OWN operands
 * before the command, so a one-word peel cannot reach it
 * (`timeout 5 cat .env` peels to `5 cat .env`); `xargs` is additionally named
 * out of contract in ADR-172 sec 1 (`echo .env | xargs cat`). Those two are
 * pinned as such in the tests rather than left unstated.
 */
export const TRANSPARENT_HEAD_WORDS = new Set([
  '!',
  'if',
  'elif',
  'then',
  'else',
  'while',
  'until',
  'do',
  'command',
  'exec',
  'eval',
  'builtin',
  'time',
])

/**
 * `argv` with every leading `TRANSPARENT_HEAD_WORDS` entry removed,
 * iteratively (`then command cat .env` peels twice). Returns the SAME array
 * identity when nothing was peeled, so a caller pays nothing on the ordinary
 * line and can test identity rather than length.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function stripTransparentHeadWords(argv) {
  let i = 0
  while (i < argv.length && TRANSPARENT_HEAD_WORDS.has(argv[i])) i++
  return i === 0 ? argv : argv.slice(i)
}

/**
 * One extra segment per segment whose head is transparent, holding the same
 * tokens with the leading transparent WORD tokens dropped. Redirect-marked
 * words stay in place, so the segment's own input-redirect sources still
 * reach the caller's check (`then cat < .env`). A segment that is ENTIRELY
 * transparent words yields nothing: there is no command there to judge.
 *
 * Returns `[]` when no segment has a transparent head, the overwhelming
 * majority of command lines.
 * @param {Array<Array<{type: string, value?: string, redirect?: boolean}>>} segments
 * @returns {Array<Array<object>>}
 */
export function transparentHeadReadings(segments) {
  const extra = []
  for (const segment of segments) {
    let i = 0
    while (
      i < segment.length &&
      segment[i].type === 'word' &&
      segment[i].redirect !== true &&
      TRANSPARENT_HEAD_WORDS.has(segment[i].value)
    ) {
      i++
    }
    if (i > 0 && i < segment.length) extra.push(segment.slice(i))
  }
  return extra
}

/**
 * The alternatives to read for a word-position paren group that CONTAINS
 * another paren group: every word in the group's balanced span, each as its
 * own single-word alternative.
 *
 * zsh nests glob alternations. Measured in zsh 5.9 with a decoy executable
 * actually invoked, all three of `./((a|node_modules)|y)/.bin/tool`,
 * `./(y|(a|node_modules))/.bin/tool` and `./(a(x|node_modules))/.bin/tool`
 * RUN it -- so skipping such a group left the SMI-6903 H1 fix bypassable by
 * one extra paren, which is the whole shape that fix exists to see. Both
 * bashes reject the syntax.
 *
 * Flattening is an over-APPROXIMATION of the real cross product: it yields
 * `./a/.bin/…`, `./node_modules/.bin/…` and `./y/.bin/…` for the first of
 * those, where zsh yields the first two only. That direction is sound here
 * precisely because the reading is additive -- a reading the shell would not
 * form can add a denial and can never remove one -- and it is why the
 * alternative (a full recursive expansion) is not worth its own cross-product
 * caps. The known residue: a group whose words are not path components, e.g.
 * `cat (a(.env|c)|d)`, gains a `.env`-alone reading zsh never forms, so that
 * shape over-blocks (SMI-6900 residue, measured).
 *
 * Returns null when the span holds no word at all, so the caller skips the
 * group exactly as it did before.
 * @param {Array<{type: string, value?: string}>} tokens
 * @param {number} open index of the group's `(` op token
 * @param {number} close index of its matching `)` op token
 * @returns {Array<Array<object>>|null}
 */
export function nestedGroupAlternatives(tokens, open, close) {
  const alts = []
  for (let k = open + 1; k < close; k++) {
    if (tokens[k].type === 'word') alts.push([tokens[k]])
  }
  return alts.length === 0 ? null : alts
}
