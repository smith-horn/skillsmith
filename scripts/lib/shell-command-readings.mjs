/**
 * Two readings of a tokenized command that exist because a single reading was
 * wrong about a real shell (SMI-6903 rounds 21 to 23). Both are ADDITIVE: a
 * caller keeps its own primary reading and only ADDS verdicts from these, so
 * an approximate rebuild can only ever over-block, never under-block.
 *
 *   - `transparentHeadReadings` (F1): a shell RESERVED WORD, a command
 *     modifier, a process LAUNCHER with its own operands, or a wrapper the
 *     caller already peels, at a segment's head, is not the command; and a
 *     launcher's own `-c` body is shell text.
 *   - `nestedGroupAlternatives` (F4): a zsh glob group may contain another
 *     glob group.
 *
 * Every shell claim below was measured in bash 3.2 (host), bash 5.2
 * (container) and zsh 5.9 (host, the shell Claude Code's Bash tool runs on
 * this machine), with a decoy file read or a decoy executable invoked.
 */

import {
  DASH_C_LAUNCHERS,
  LAUNCHER_TABLE,
  launcherDashCCommand,
  launcherStops,
  stripLauncher,
} from './shell-command-launchers.mjs'
import { basenameOf, tokenize } from './shell-command-tokenize.mjs'

/**
 * Words that introduce or modify a command without BEING it, and take no
 * operands of their own. A head that takes operands (`timeout 5`, `nice -n 5`,
 * `exec -a name`) is read through `LAUNCHER_TABLE` instead, which is consulted
 * FIRST so `exec -a x cat .env` peels its flag and not just its name.
 *
 * None of these is an operator, so no segmentation can split there -- which
 * left the modifier as `argv[0]` and the reader's own name as a mere
 * argument. Every one of these ALLOWED in `env-read-guard.mjs` before this
 * reading (round 21), while emitting a decoy file's contents in all three
 * shells:
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
 * the peel (`for f in …` peels `for`, then halts on `f`). `timeout`, `nice`
 * and the other launchers were absent from round 21's version of this set
 * and PINNED as allowed, which the round 22 cross-family gate named as a leak
 * (`timeout 5 cat .env` prints the file in bash 5.2; `nice -n 5 cat .env` in
 * all three) -- they are launcher-table rows now. `xargs` stays out of
 * contract by ADR-172 sec 1: its command's arguments arrive on stdin as text.
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
  // zsh's `nocorrect` precommand modifier (its sibling `noglob` is a
  // launcher-table row): `nocorrect cat D` printed a decoy in zsh 5.9, the
  // shell the Bash tool runs here, and allowed (SMI-6908 F-5). Silent in bash,
  // where the word is a command not found.
  'nocorrect',
])

/**
 * `argv` with every leading transparent word and every leading launcher
 * (with that launcher's own flags and positionals) removed, iteratively
 * (`then timeout 5 cat .env` peels to `cat .env`). Returns the SAME array
 * identity when nothing was peeled, so a caller pays nothing on the ordinary
 * line and can test identity rather than length.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function stripTransparentHeadWords(argv) {
  let a = argv
  while (a.length > 0) {
    const entry = LAUNCHER_TABLE.get(basenameOf(a[0]))
    if (entry !== undefined) {
      if (launcherStops(a.slice(1), entry)) break
      a = stripLauncher(a.slice(1), entry)
      continue
    }
    if (!TRANSPARENT_HEAD_WORDS.has(a[0])) break
    a = a.slice(1)
  }
  return a === argv ? argv : a
}

/**
 * The readings of ONE segment with its transparent head peeled: a launcher
 * (flags and positionals included), a transparent word, or a wrapper prefix
 * the caller's own `peelWrappers` strips, repeated until the head is none of
 * those. Redirect-marked words passed over on the way are KEPT, in order, in
 * front of the remainder, so `timeout 5 cat < .env` still carries its source.
 * A `DASH_C_LAUNCHERS` head whose `-c` body is present yields that body's
 * own segments instead (`script -q -c 'ls; cat .env' /dev/null` reads
 * `ls` and `cat .env`; round 23, measured printing in bash 5.2), split by the
 * caller's `splitFn`, PLUS this same reading of each of those segments, so a
 * launcher inside the body is peeled too (`script -q -c 'timeout 5 cat .env'
 * /dev/null` printed a decoy while the body's `timeout` sat as argv[0];
 * round 24) and a body inside the body is extracted up to
 * `MAX_DASH_C_DEPTH` levels (`script -q --command="script -q -c 'cat D' f" f`
 * printed too). Past that depth the launcher row's own peel still applies.
 * Returns null when nothing was peeled, or when peeling consumed every word
 * (`timeout 5` alone has no command to judge). A nested shell body reported
 * by `peelWrappers` ends the peel with the reading kept, so the caller's own
 * wrapper arm can pair the body with the redirect words carried in front.
 * @param {Array<{type: string, value?: string, redirect?: boolean}>} segment
 * @param {((argv: string[]) => {argv: string[], nested: string|null}) | null} peelWrappers
 * @param {(tokens: Array<object>) => Array<Array<object>>} splitFn
 * @param {number} depth how many `-c` bodies enclose this segment
 * @returns {Array<Array<object>>|null}
 */
const MAX_DASH_C_DEPTH = 2

function peelHead(segment, peelWrappers, splitFn, depth) {
  const kept = []
  let i = 0
  let peeled = false
  // The values of the plain (non-redirect) words from `i` to the segment's
  // next non-word token, which is what a launcher or wrapper consumes from.
  const plainValuesFrom = (start) => {
    const out = []
    for (let k = start; k < segment.length && segment[k].type === 'word'; k++) {
      if (segment[k].redirect !== true) out.push(segment[k].value)
    }
    return out
  }
  // Advance `i` past `n` plain words, keeping any redirect words in between.
  const advancePlain = (n) => {
    let seen = 0
    while (i < segment.length && seen < n && segment[i].type === 'word') {
      if (segment[i].redirect === true) kept.push(segment[i])
      else seen++
      i++
    }
  }
  while (i < segment.length) {
    const t = segment[i]
    if (t.type !== 'word') break
    if (t.redirect === true) {
      kept.push(t)
      i++
      continue
    }
    const base = basenameOf(t.value)
    if (DASH_C_LAUNCHERS.has(base) && depth < MAX_DASH_C_DEPTH) {
      const body = launcherDashCCommand(plainValuesFrom(i))
      if (body !== null) {
        const segs = splitFn(tokenize(body))
        return segs.concat(transparentHeadReadings(segs, peelWrappers, splitFn, depth + 1))
      }
    }
    const entry = LAUNCHER_TABLE.get(base)
    if (entry !== undefined) {
      const after = plainValuesFrom(i + 1)
      if (launcherStops(after, entry)) break
      const consumed = after.length - stripLauncher(after, entry).length
      i++
      advancePlain(consumed)
      peeled = true
      continue
    }
    if (TRANSPARENT_HEAD_WORDS.has(t.value)) {
      i++
      peeled = true
      continue
    }
    if (peelWrappers !== null) {
      const values = plainValuesFrom(i)
      const { argv: after, nested } = peelWrappers(values)
      // A nested shell body stops the peel but keeps the reading: the
      // caller's own wrapper arm then sees `bash -c cat` beside the redirect
      // words kept above (`timeout 5 bash -c cat < .env`, measured leaking
      // when this returned null instead).
      if (nested !== null) break
      const consumed = values.length - after.length
      if (consumed > 0) {
        advancePlain(consumed)
        peeled = true
        continue
      }
    }
    break
  }
  if (!peeled || i >= segment.length) return null
  return [kept.concat(segment.slice(i))]
}

/**
 * The extra segments for every segment whose head is transparent (see
 * `peelHead`). Returns `[]` when no segment has such a head, the overwhelming
 * majority of command lines. `peelWrappers` is the caller's own wrapper
 * normalizer (`normalizeWrappers`) and `splitFn` its own segment splitter,
 * both passed in rather than imported so this module stays below
 * `shell-command-normalize.mjs` and `shell-command-segments.mjs` in the
 * import graph; with the first, `sudo timeout 5 cat .env` and
 * `docker exec c timeout 5 cat /app/.env` read through to the reader, which
 * the wrapper peel alone could not reach because it stops at the first
 * non-wrapper word; with the second, a `-c` body's own `;`-separated commands
 * are read one by one.
 * `splitFn` is required (SMI-6908 F-13): a default of "one unsplit segment"
 * would let a future caller lose a `-c` body's segmentation silently.
 * @param {Array<Array<{type: string, value?: string, redirect?: boolean}>>} segments
 * @param {((argv: string[]) => {argv: string[], nested: string|null}) | null} peelWrappers
 * @param {(tokens: Array<object>) => Array<Array<object>>} splitFn
 * @param {number} [depth] internal: how many `-c` bodies enclose `segments`
 * @returns {Array<Array<object>>}
 */
export function transparentHeadReadings(segments, peelWrappers, splitFn, depth = 0) {
  if (typeof splitFn !== 'function')
    throw new TypeError('transparentHeadReadings: splitFn is required')
  const extra = []
  for (const segment of segments) {
    const readings = peelHead(segment, peelWrappers, splitFn, depth)
    if (readings !== null) extra.push(...readings)
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
