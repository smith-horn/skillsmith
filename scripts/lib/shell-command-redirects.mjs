/**
 * Input-redirect sources and the wrapper-body check (SMI-6903 C1, round 21 F2
 * and F3; rebuilt in SMI-6908 F-1).
 *
 * Split out of `shell-command-segments.mjs`, which sat at exactly the
 * hand-kept 500-line convention with the SMI-6908 fix still to land
 * (`scripts/check-file-length.mjs` only runs via `lint-staged` for
 * `*.ts`/`*.sh`, so this one is honoured by hand; SMI-5994), the same way
 * `shell-command-comment.mjs` was split out of the tokenizer. Re-exported by
 * `shell-command-normalize.mjs`, so every existing import keeps working. This
 * module imports the segments module and never the reverse.
 */

import { splitCommandSegmentsWithSubRuns } from './shell-command-segments.mjs'

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
 * The caller's own `checkArgv`, re-run over every reading of every command in
 * a WRAPPER's nested body with that wrapper's own input-redirect sources
 * appended, recursing into a body that is itself a wrapper.
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
 * Round 21's version read the body with the SEPARATOR reading only and
 * stopped at one level, so a body whose reader sat behind a reserved word,
 * a launcher or a second wrapper never reached `checkArgv`: of 37 body heads
 * the post-merge retro of PR #2973 swept, 35 allowed, and `bash -c "eval
 * cat" < D`, `"nohup cat"`, `"if true; then cat; fi"`, `"nice -n 5 cat"`,
 * `"bash -c 'cat'"`, `sh -c "bash -c cat" < D` (bash 3.2 and zsh 5.9),
 * `"timeout 5 cat"`, `"stdbuf -oL cat"` (bash 5.2) all printed a decoy
 * (SMI-6908 F-1). The body is now read with the caller's FULL set of
 * readings (`splitCommandSegmentsWithSubRuns` with the caller's own
 * `normalizeWrappers`: separator, brace sub-run, parens-grouping and the
 * transparent-head reading of each, launchers included), and a body segment
 * whose own wrapper reports a nested body recurses here, so the sources
 * follow stdin inward as the shell passes it. The recursion shares the
 * caller's depth counter and cap, so a chain past `maxDepth` denies with the
 * caller's own `depth-cap` violation rather than falling through.
 * @param {string} body the wrapper's nested command text
 * @param {string[]} sources this segment's input-redirect sources
 * @param {{tokenize: Function, normalizeWrappers: Function, checkArgv: Function, maxDepth: number, onDepthCap: Function}} deps
 * @param {number} [depth] the caller's recursion depth for this body
 * @returns {object|null} the caller's own violation shape, or null
 */
export function checkNestedRedirectSources(body, sources, deps, depth = 0) {
  if (sources.length === 0 || typeof body !== 'string' || body.trim() === '') return null
  if (depth > deps.maxDepth) return deps.onDepthCap()
  const readings = splitCommandSegmentsWithSubRuns(deps.tokenize(body), deps.normalizeWrappers)
  for (const segment of readings) {
    const argv = segment.filter((t) => t.type === 'word' && t.redirect !== true).map((t) => t.value)
    if (argv.length === 0) continue
    const { argv: peeled, nested } = deps.normalizeWrappers(argv)
    const violation =
      nested !== null
        ? checkNestedRedirectSources(nested, sources, deps, depth + 1)
        : deps.checkArgv(peeled.concat(sources))
    if (violation) return violation
  }
  return null
}
