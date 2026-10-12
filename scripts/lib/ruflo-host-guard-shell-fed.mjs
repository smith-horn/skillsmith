#!/usr/bin/env node
/**
 * Guard-local shell-fed-text and inline-interpreter-script helpers for
 * scripts/ruflo-host-guard.mjs (SMI-6744 Wave 4 governance round: H-F
 * shell-fed literal text, extended by the delta round's H-1 xargs
 * replacement-token restore, H-4 glued here-string, H-8 inline
 * interpreter text, and M-1/M-2 pipeline-producer walk-back + printf
 * decode).
 *
 * Split out of `ruflo-host-guard-wrappers.mjs` (itself already split out
 * of the guard's own orchestration file) purely to stay under the
 * 500-line-per-file convention this repo keeps by hand for .mjs files
 * under scripts/ (M3 correction: not enforced by tooling here --
 * scripts/check-file-length.mjs only runs via lint-staged for *.ts/*.sh;
 * SMI-5994) once the delta round's fixes grew that file past the limit --
 * these are guard-SPECIFIC helpers, not general-purpose primitives every
 * consumer of shell-command-normalize.mjs would want, so they stay out of
 * that shared module (env-read-guard.mjs needs none of this).
 */

import { basenameOf, SHELL_COMMANDS, tokenize } from './shell-command-normalize.mjs'
import { decodeShellEscapes } from './shell-escape-decode.mjs'
// `isPythonBasename` lives in the inline-script module, the only other
// user, so the edge between these two files runs ONE way (this file ->
// inline-script, for the re-export at the bottom too) and no cycle forms.
import { isPythonBasename } from './ruflo-host-guard-inline-script.mjs'
import {
  HEREDOC_CONSUMER_BASENAMES,
  normalizeHeredocConsumerBody,
} from './ruflo-host-guard-heredoc-consumers.mjs'

/**
 * M-2 fix (SMI-6744 Wave 4 governance round), broadened by the C1 delta-
 * round fix to call the SHARED `decodeShellEscapes` (`shell-escape-
 * decode.mjs`) instead of its own bespoke regex: decodes printf(1)'s own
 * `\xHH` (hex byte), `\NNN` (1-3 digit octal), and the GNU printf
 * `\uHHHH`/`\UHHHHHHHH` (Unicode) escapes, so text piped through
 * `printf '<encoded>' | bash` surfaces as the command printf will
 * actually PRODUCE at runtime, not the literal escape-sequence characters
 * this guard's tokenizer captures verbatim from printf's own single-
 * quoted argument (single quotes never process escapes, so `\x6e\x70\x78`
 * reaches this guard as those 12 literal characters, not the 3 bytes
 * `npx`). The ORIGINAL fix here was deliberately minimal (`\n`/`\t`/etc
 * left alone, since they cannot themselves spell out a runner/path token)
 * but had its own bespoke regex that could silently diverge from the
 * ANSI-C `$'...'` tokenizer branch's table — now both call the same
 * function, so bash's `printf` builtin's own `\n`/`\t`/`\a`/`\cX`/etc
 * escapes decode too (a strictly more conservative superset: it can only
 * make this guard MORE willing to recognize a disguised invocation, never
 * less).
 * @param {string} s
 */
function decodePrintfEscapes(s) {
  return decodeShellEscapes(s)
}

/**
 * Reads one PRODUCER segment's own literal text, decoding it as `head`
 * would produce it at runtime (M-2's printf decode applies here too, so a
 * `printf` producer reached via a pass-through chain is decoded the same
 * way as a direct `printf | bash`).
 * @param {string} head basename of this segment's own argv[0]
 * @param {Array<{value: string}>} words this segment's own word tokens
 * @returns {string | null}
 */
function literalTextFromProducerWords(head, words) {
  const args = words.slice(1).map((t) => t.value)
  if (args.length === 0) return null
  const joined = args.join(' ')
  return head === 'printf' ? decodePrintfEscapes(joined) : joined
}

/**
 * Round-3 governance follow-up (M5, process-substitution form): the LITERAL
 * producer shapes this guard can read statically without executing
 * anything -- `echo`/`printf`'s own positional arguments, or a `cat`/`echo`/
 * `printf` producer's OWN attached heredoc (which it relays verbatim).
 * Factored out of `resolveShellFedProducer`'s own inline checks so a
 * `<(...)` process substitution's inner command (which is never part of a
 * `segments` pipeline the way a producer segment is) can share the exact
 * same "is this literal" definition via `resolveProcessSubstitutionText`
 * below, rather than drifting into a second, subtly different one.
 * @param {string} head basename of the producer's own argv[0]
 * @param {Array<{value: string}>} words the producer's own word tokens
 * @param {Array<{value: string|null}>} heredocToks any heredoc tokens
 *   attached to the SAME segment/token list as `words`
 * @returns {string | null} null means "not a literal producer", not "empty"
 */
function literalProducerText(head, words, heredocToks) {
  if (heredocToks.length > 0 && (head === 'cat' || head === 'echo' || head === 'printf')) {
    return heredocToks.map((t) => t.value ?? '').join('\n')
  }
  if (head === 'echo' || head === 'printf') {
    return literalTextFromProducerWords(head, words)
  }
  return null
}

/**
 * Round-3 governance follow-up (M5, process-substitution form): resolves
 * the literal text (if any) a `<(...)` process substitution's OWN inner
 * command would write to its read end -- the exact same three literal-
 * producer shapes `resolveShellFedProducer` recognizes for a pipe producer,
 * reused here so `bash <(echo '...')` (already handled below) and the
 * awk/sed extractors' own `-f <(...)`/`--file=<(...)` handling
 * (`ruflo-host-guard-consumers-awksed.mjs`) share one definition of
 * "literal producer" instead of two that could silently diverge.
 * @param {string} subText the substitution's own inner text — a WORD
 *   token's `.subs` entry, already stripped of the `<(`/`)` wrapper by the
 *   tokenizer (SMI-6744: `$(...)`/`<(...)`/`>(...)` all record their inner
 *   text into `.subs` identically).
 * @returns {string | null}
 */
export function resolveProcessSubstitutionText(subText) {
  const innerTokens = tokenize(subText)
  const innerWords = innerTokens.filter((t) => t.type === 'word' && !t.redirect)
  if (innerWords.length === 0) return null
  const innerHeredocs = innerTokens.filter((t) => t.type === 'heredoc')
  const innerHead = basenameOf(innerWords[0].value)
  return literalProducerText(innerHead, innerWords, innerHeredocs)
}

/**
 * M-1 pass-through commands whose own stdin is what actually reaches the
 * shell unchanged -- walking through these does not fabricate new
 * content, it just continues the search for the real producer one hop
 * further back in the pipeline.
 */
const PASS_THROUGH_HEADS = new Set(['tee', 'cat'])

/**
 * Resolves the literal text (if any) a PRODUCER segment supplies to a
 * bare shell further down a pipeline, walking BACK through the M-1
 * pass-through commands (`tee`, `cat`, `stdbuf`, a bare `sed -u`) that
 * relay their own stdin unchanged rather than producing text themselves
 * (SMI-6744 Wave 4 governance round). `stdbuf [flags] <wrapped-command>`
 * wraps its real command WITHIN this SAME segment (never a separate pipe
 * hop), so it is unwrapped in place rather than by walking to a different
 * segment index.
 *
 * Returns `{ text: string }` when a literal echo/printf producer was
 * found; `{ text: null }` when the walk reached the start of the
 * pipeline (or a segment that plainly names nothing) without finding an
 * unreadable producer; `null` when a REAL, non-pass-through,
 * non-literal producer sits in the chain — its output cannot be read
 * statically, so the caller must deny (an "unreadable shell input"
 * producer, the fail-closed posture this fix exists to add).
 * @param {Array<{tokens: Array<{type:string,value?:string,subs?:string[]}>, precedingOp: string|null}>} segments
 * @param {number} index the producer segment's own index to inspect
 */
function resolveShellFedProducer(segments, index) {
  if (index < 0) return { text: null }
  const segTokens = segments[index].tokens
  // SMI-6869 Fix A: a redirect-marked word token is never part of this
  // producer's own argv (a trailing `cat file 2>/dev/null` must still
  // resolve `cat`'s real args, not the redirect's own target).
  let words = segTokens.filter((t) => t.type === 'word' && !t.redirect)
  if (words.length === 0) return { text: null }

  if (basenameOf(words[0].value) === 'stdbuf') {
    let i = 1
    while (i < words.length && words[i].value.startsWith('-')) i++
    words = words.slice(i)
    if (words.length === 0) return { text: null }
  }

  const head = basenameOf(words[0].value)

  // SMI-6869 Fix B: a `cat`/`echo`/`printf` producer whose OWN segment
  // carries a heredoc (`cat <<'EOF' | bash`) relays that heredoc's body
  // verbatim to its stdout — the literal text a downstream bare shell
  // actually receives, taking priority over any of the command's own
  // positional arguments (a heredoc redirect on one of these three would
  // never realistically appear alongside them, but if it did, the
  // heredoc is what actually reaches the pipe).
  const heredocToks = segTokens.filter((t) => t.type === 'heredoc')
  if (heredocToks.length > 0 && (head === 'cat' || head === 'echo' || head === 'printf')) {
    return { text: heredocToks.map((t) => t.value ?? '').join('\n') }
  }

  // NOTE: deliberately NOT routed through the shared `literalProducerText`
  // (round-3 governance M5 follow-up) — this arm's contract is "always
  // return `{text}`, even when `text` is null" (a recognized-but-empty
  // echo/printf producer is NOT the same as an unrecognized one three lines
  // below, which must return the bare `null` that signals "unreadable,
  // deny"). `literalProducerText` returns a bare `null` for BOTH cases,
  // which is the right contract for `resolveProcessSubstitutionText` (a
  // `<(...)`'s own inner command is either literal or it silently
  // contributes nothing) but would collapse this distinction here.
  if (head === 'echo' || head === 'printf') {
    const text = literalTextFromProducerWords(head, words)
    return { text }
  }

  const isBareSedU =
    head === 'sed' &&
    words.length === 2 &&
    (words[1].value === '-u' || words[1].value === '--unbuffered')

  if (PASS_THROUGH_HEADS.has(head) || isBareSedU) {
    const precedingOp = segments[index].precedingOp
    if (precedingOp !== '|' || index === 0) return { text: null }
    return resolveShellFedProducer(segments, index - 1)
  }

  return null
}

/**
 * H-F fix (SMI-6744 Wave 4 governance round), extended by the delta
 * round's H-4/M-1 fixes: literal text piped, here-string-fed, or
 * process-substitution-fed into a bare shell invocation (`echo '...' |
 * bash`, `printf '...' | sh`, `bash <<< '...'`, `bash <(echo '...')`) is
 * READABLE TEXT this guard's tokenizer already captures — it just never
 * treated it as a command to evaluate. Runs only when this segment's
 * post-normalize argv[0] resolves to a bare shell (a `-c` body, if any, is
 * handled separately via `normalizeWrappersWithExec`'s own `nested`
 * return, checked by the caller before this is ever reached). Checked in
 * order:
 *   1. (M-1) walks BACK through the pipeline via `resolveShellFedProducer`
 *      when this segment was itself joined by `|` — a chain of pass-
 *      through commands is followed to its real producer; a producer this
 *      guard cannot read statically (anything else) DENIES rather than
 *      silently letting unexamined text reach the shell;
 *   2. a `<<<` here-string operator's following token, OR (H-4) a token
 *      that STARTS WITH `<<<` with no space (`bash <<<"text"` glues the
 *      marker onto the quoted text into ONE word, since this guard's
 *      tokenizer never treats `<<<` as its own operator) — either shape
 *      surfaces as plain WORD token(s), detected here by value;
 *   3. a `<(...)` sub appearing as this shell's own argument whose inner
 *      command is itself `echo`/`printf` — the sub's own literal
 *      arguments are the fed text (NOT the whole "echo '...'" text, which
 *      the caller's top-level subs-recursion already evaluates separately
 *      and harmlessly).
 * Text sourced from a FILE (`source f`, `sh <file>`, `bash -c "$(cat
 * f)"`) stays out of reach by design (design § 8 item 15) — none of these
 * three sources touches the filesystem.
 * @param {string[]} argvLower this segment's post-normalize, lowercased argv
 * @param {Array<{type:string, value?:string, subs?:string[]}>} segmentTokens
 *   the RAW segment (word + op tokens interleaved)
 * @param {Array<{tokens: Array<object>, precedingOp: string|null}>} segments
 *   every segment of the FULL command, in order
 * @param {number} segmentIndex this segment's own index into `segments`
 * @returns {{text: string, embedded?: boolean} | {deny: true, token: string} |
 *   null} a literal-text result to recurse into (L3 correction: `embedded:
 *   true` when the fed text is INTERPRETER PROGRAM SOURCE, not a shell
 *   command line, so the caller evaluates it with the shell-command-line-
 *   only arms turned off; governance round 8 Minor 3: every non-`embedded`
 *   result — a heredoc CONSUMER's body or a bare shell/interpreter's fed
 *   text alike — is likewise an EXTRA place to look, not a replacement for
 *   the segment's own argv checks, so the caller always falls through on a
 *   clean recursion instead of returning; see `scripts/ruflo-host-guard.mjs`
 *   for the one merged arm this collapsed into), a deny signal (M-1's
 *   unreadable-producer case) for the caller to turn into a verdict, or
 *   null (nothing found)
 */
export function findShellFedLiteralText(argvLower, segmentTokens, segments, segmentIndex) {
  const head0 = basenameOf(argvLower[0] ?? '')
  const isShell = SHELL_COMMANDS.has(head0)
  const isInterp = isInlineInterpreterBasename(head0)
  const isHeredocConsumer = HEREDOC_CONSUMER_BASENAMES.has(head0)
  if (!isShell && !isInterp && !isHeredocConsumer) return null

  // SMI-6869 Fix B: a heredoc redirected directly onto THIS segment's own
  // stdin is what the consumer actually executes. ALL heredocs on the line
  // are evaluated, not just the first: real Bash's LAST stdin redirection
  // wins, so picking the first silently skipped the live one.
  const ownHeredocs = segmentTokens.filter((t) => t.type === 'heredoc')
  if (ownHeredocs.length > 0) {
    const raw = ownHeredocs.map((t) => t.value ?? '').join('\n')
    // Round-3 governance fix (Minor 3 follow-up, governance round 8: the
    // caller no longer branches on a flag here — see
    // `scripts/ruflo-host-guard.mjs`'s own merged comment): for a heredoc
    // CONSUMER the body is an ADDITIONAL place to look, not a replacement
    // for this segment's own argv. An unconditional `return`-the-body's-
    // verdict-outright caller would let a benign body short-circuit
    // H1–H7, the consumer step and the bare-name inversion for the
    // segment itself: `make -f - ruflo <<'EOF'…EOF` and `crontab - ruflo
    // <<'EOF'…EOF` both need to keep denying (H4b) via that fall-through.
    // A shell or interpreter's own fed body is the SAME kind of extra
    // place to look, not a replacement for its own argv either — the
    // caller's fall-through applies uniformly to every arm reached here.
    return {
      text: isHeredocConsumer ? normalizeHeredocConsumerBody(head0, raw) : raw,
      embedded: isInterp,
    }
  }
  if (isHeredocConsumer) {
    // SMI-6869 round 2: a pipe-fed literal producer (echo/printf/a cat
    // relaying its own heredoc) supplies text the same way it does for a
    // bare shell below -- but an unreadable/non-literal producer means
    // "nothing extracted", not "deny" (see this function's own docblock).
    if (segments[segmentIndex]?.precedingOp === '|' && segmentIndex > 0) {
      const resolved = resolveShellFedProducer(segments, segmentIndex - 1)
      if (resolved !== null && resolved.text !== null) {
        return {
          text: normalizeHeredocConsumerBody(head0, resolved.text),
        }
      }
    }
    // No heredoc and no literal pipe producer: make/crontab/at/batch read
    // their real Makefile/crontab/job file from disk, out of reach by
    // design (same posture as a shell's own `source f`/`sh <file>`).
    return null
  }
  if (isInterp) {
    // an interpreter fed by a pipe reads its PROGRAM from stdin
    if (segments[segmentIndex]?.precedingOp === '|' && segmentIndex > 0) {
      const resolved = resolveShellFedProducer(segments, segmentIndex - 1)
      if (resolved !== null && resolved.text !== null) {
        return { text: resolved.text, embedded: true }
      }
    }
    return null
  }

  if (segments[segmentIndex]?.precedingOp === '|' && segmentIndex > 0) {
    const resolved = resolveShellFedProducer(segments, segmentIndex - 1)
    if (resolved === null) {
      return {
        deny: true,
        token:
          "(a bare shell's stdin is fed by a pipeline segment this guard cannot read statically)",
      }
    }
    if (resolved.text !== null) return { text: resolved.text }
  }

  // L5 correction: deliberately NOT `&& !t.redirect` here (unlike
  // `evaluateGuardSegment`'s own `wordTokens` filter) -- the `<<<` marker
  // word and/or its following text word must still be SEEN by this scan
  // even if the tokenizer marks either one `.redirect`, or a real here-string
  // operand would never be found at all.
  const words = segmentTokens.filter((t) => t.type === 'word')
  for (let i = 0; i < words.length; i++) {
    const val = words[i].value
    if (val === '<<<' && i + 1 < words.length) return { text: words[i + 1].value }
    if (val.startsWith('<<<') && val.length > 3) return { text: val.slice(3) }
  }

  // Round-3 governance follow-up (M5, process-substitution form): shares
  // `resolveProcessSubstitutionText`'s definition of "literal producer"
  // with the awk/sed extractors' own `-f <(...)` handling — a strict
  // superset of the original echo/printf-only check (now also resolves a
  // `cat`-with-its-own-heredoc producer, e.g. `bash <(cat <<'EOF' …
  // EOF)`), so nothing this already caught stops being caught.
  for (const t of words) {
    for (const sub of t.subs ?? []) {
      const text = resolveProcessSubstitutionText(sub)
      if (text !== null) return { text }
    }
  }

  return null
}

/**
 * xargs `-I`/`-i` (H-1 fix, SMI-6744 Wave 4 governance round): xargs's
 * replacement-string flag almost always takes the literal placeholder
 * `{}` as its value, but this guard's OWN tokenizer treats bare `{`/`}`
 * as command-grouping OPERATORS, not word characters — so an UNQUOTED
 * `-I{}` or `-I {}` loses its value entirely from the word-token stream
 * the rest of this guard's pipeline works from, leaving `-I` positioned
 * to wrongly consume the NEXT REAL WORD (the actual wrapped command's own
 * name, e.g. `ruflo`) as if it were `-I`'s value — `xargs -I{} ruflo {}`
 * would otherwise strip down to just `ruflo`'s OWN trailing `{}`
 * (invisible, also op-tokens) with `ruflo` itself eaten by `-I`. Restores
 * a synthetic `{}` word token immediately after `-I`/`-i` whenever
 * `segmentTokens` shows an adjacent, empty `{`/`}` op-token pair there
 * (glued `-I{}` or space-separated `-I {}` lose the value identically),
 * so the LAUNCHER_TABLE's existing `-I`/`-i` value-flag consumption
 * behaves the same whether the replacement string was quoted (already
 * survives as a real word token, e.g. `-I '{}'`) or not (needs
 * restoring). Scoped to segments whose own first word is `xargs`, via the
 * caller — applying it unconditionally would be harmless (it only ever
 * ADDS a token, and only in this exact adjacency shape) but is kept
 * narrow and explicit to match this fix's own stated scope.
 * @param {Array<{type: string, value?: string, subs?: string[]}>} segmentTokens
 * @returns {Array<{type: string, value: string, subs?: string[]}>} word
 *   tokens only, with a synthetic `{}` entry spliced in where needed
 */
export function restoreXargsReplacementWordTokens(segmentTokens) {
  const result = []
  for (let i = 0; i < segmentTokens.length; i++) {
    const tok = segmentTokens[i]
    // SMI-6869 Fix A: a redirect-marked word token is never real argv.
    if (tok.type !== 'word' || tok.redirect) continue
    result.push(tok)
    if (tok.value !== '-I' && tok.value !== '-i') continue
    const next = segmentTokens[i + 1]
    const nextNext = segmentTokens[i + 2]
    if (
      next?.type === 'op' &&
      next.value === '{' &&
      nextNext?.type === 'op' &&
      nextNext.value === '}'
    ) {
      result.push({ type: 'word', value: '{}' })
      i += 2
    }
  }
  return result
}

/**
 * Interpreters that execute a program read from their own stdin.
 * L1 correction: dropped the unused `export` -- used only locally in this
 * file (the test file's own comment naming it is prose, not an import;
 * confirmed via `grep -rn` across scripts/).
 * SMI-6908 F-16 (a peer's question, measured): `deno run -` reads its
 * program from stdin the way `node -` does, but `deno` was only in the
 * `eval`-subcommand list, so `echo '<program>' | deno run -` was never
 * read while the same text piped to node, bun or python3 denied H5.
 */
function isInlineInterpreterBasename(base) {
  return (
    isPythonBasename(base) ||
    base === 'node' ||
    base === 'nodejs' ||
    base === 'perl' ||
    base === 'ruby' ||
    base === 'php' ||
    base === 'bun' ||
    base === 'deno'
  )
}

// M3 follow-up: `extractInlineScriptText`/`INLINE_SCRIPT_BARE_NAME_RE`
// moved to `ruflo-host-guard-inline-script.mjs` (file-length split) and are
// re-exported here so `scripts/ruflo-host-guard.mjs`'s own import
// statement needed no change.
export {
  extractInlineScriptText,
  INLINE_SCRIPT_BARE_NAME_RE,
} from './ruflo-host-guard-inline-script.mjs'
