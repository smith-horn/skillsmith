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
 * 500-line file-length gate (scripts/check-file-length.mjs) once the
 * delta round's fixes grew that file past the limit -- these are guard-
 * SPECIFIC helpers, not general-purpose primitives every consumer of
 * shell-command-normalize.mjs would want, so they stay out of that shared
 * module (env-read-guard.mjs needs none of this).
 */

import {
  basenameOf,
  hasInlineScriptFlag,
  INLINE_SCRIPT_LONG_FLAGS,
  SHELL_COMMANDS,
  tokenize,
} from './shell-command-normalize.mjs'
import { decodeShellEscapes } from './shell-escape-decode.mjs'

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
 * SMI-6869 consumer-string round, group 10 — commands whose stdin (fed via
 * a heredoc redirect on this same line) is itself a script/config body a
 * LATER process will run as real shell text: `make -f -` reads a Makefile
 * from stdin (a tab-indented recipe line runs via `/bin/sh -c`), `crontab -`
 * installs a crontab from stdin (each line's trailing command field runs
 * via shell), and `at`/`batch` read a job script from stdin (run via shell
 * when the job fires). The body text is handed to `evaluateGuardCommand`
 * NON-embedded, same as a bash heredoc — it is real shell text, not program
 * source — and the guard's own `\n`-as-statement-separator segmentation
 * naturally isolates a Makefile recipe line or an `at` job line as its own
 * segment; a crontab line's 5 leading schedule fields land in front of the
 * command, closed there by M-6's bare-name inversion rather than H4.
 * (SMI-6869 round 2) ALSO extended to a pipe-fed producer (`printf '* * *
 * * * ruflo memory store\n' | crontab -`) — but unlike the shell/
 * interpreter branches below, an UNREADABLE producer here is NOT a deny
 * signal, only a "nothing extracted" one: `resolveShellFedProducer` only
 * ever yields text from a LITERAL producer (`echo`/`printf`, or a `cat`
 * relaying a heredoc), so a non-literal producer (`crontab -l | crontab -`
 * round-tripping) correctly yields nothing and stays allow, never a false
 * deny on ordinary crontab/make pipeline usage.
 */
const HEREDOC_CONSUMER_BASENAMES = new Set(['make', 'gmake', 'crontab', 'at', 'batch'])

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
 * @returns {{text: string} | {deny: true, token: string} | null} a literal-
 *   text result to recurse into, a deny signal (M-1's unreadable-producer
 *   case) for the caller to turn into a verdict, or null (nothing found)
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
    return { text: ownHeredocs.map((t) => t.value ?? '').join('\n'), embedded: isInterp }
  }
  if (isHeredocConsumer) {
    // SMI-6869 round 2: a pipe-fed literal producer (echo/printf/a cat
    // relaying its own heredoc) supplies text the same way it does for a
    // bare shell below -- but an unreadable/non-literal producer means
    // "nothing extracted", not "deny" (see this function's own docblock).
    if (segments[segmentIndex]?.precedingOp === '|' && segmentIndex > 0) {
      const resolved = resolveShellFedProducer(segments, segmentIndex - 1)
      if (resolved !== null && resolved.text !== null) {
        return { text: resolved.text }
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

  const words = segmentTokens.filter((t) => t.type === 'word')
  for (let i = 0; i < words.length; i++) {
    const val = words[i].value
    if (val === '<<<' && i + 1 < words.length) return { text: words[i + 1].value }
    if (val.startsWith('<<<') && val.length > 3) return { text: val.slice(3) }
  }

  for (const t of words) {
    for (const sub of t.subs ?? []) {
      const innerWords = tokenize(sub).filter((tk) => tk.type === 'word')
      if (innerWords.length === 0) continue
      const innerHead = basenameOf(innerWords[0].value)
      if (innerHead === 'echo' || innerHead === 'printf') {
        const text = literalTextFromProducerWords(innerHead, innerWords)
        if (text !== null) return { text }
      }
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
 * H-8 fix (SMI-6744 Wave 4 governance round): per-interpreter short-flag
 * characters for the inline-script-text flags this guard recurses into --
 * reused via the shared `hasInlineScriptFlag` as a first-pass "does this
 * argv even carry an inline-script flag" check (see that function's own
 * doc in shell-command-normalize.mjs for why long flags are checked
 * uniformly instead of per-interpreter).
 */
const INLINE_SCRIPT_SHORT_FLAG_CHARS = {
  node: 'ep',
  perl: 'eE',
  ruby: 'e',
  php: 'r',
}

function isPythonBasename(base) {
  return /^python[0-9]*(\.[0-9]+)?$/.test(base)
}

/** Interpreters that execute a program read from their own stdin. */
export function isInlineInterpreterBasename(base) {
  return (
    isPythonBasename(base) ||
    base === 'node' ||
    base === 'nodejs' ||
    base === 'perl' ||
    base === 'ruby' ||
    base === 'php' ||
    base === 'bun'
  )
}

/**
 * H-8 fix: extracts the inline SCRIPT-TEXT argument from a node, python
 * (any version), perl, ruby, or php interpreter invocation, or `bun -e`,
 * or `deno eval` (a subcommand, not a flag, so it has no short/long flag
 * shape at all). Reuses the shared `hasInlineScriptFlag` (with this
 * guard's OWN per-interpreter short-flag map) to decide whether an
 * inline-script flag is present at all before locating and returning its
 * VALUE — `hasInlineScriptFlag` only ever answers yes/no, it does not
 * locate which argument or return its text.
 * @param {string[]} normalizedArgv post wrapper/launcher-peel argv
 * @param {Array<{value: string}>} alignedTokens original-case tokens
 *   aligned to `normalizedArgv` (see `tokensForArgv`)
 * @returns {string | null} the script text, or null if this segment
 *   isn't one of these interpreter shapes
 */
export function extractInlineScriptText(normalizedArgv, alignedTokens) {
  if (normalizedArgv.length === 0) return null
  const base = basenameOf(normalizedArgv[0])

  if (base === 'deno') {
    return normalizedArgv[1] === 'eval' && alignedTokens[2] ? alignedTokens[2].value : null
  }

  const shortChars = isPythonBasename(base)
    ? 'c'
    : (INLINE_SCRIPT_SHORT_FLAG_CHARS[base] ?? (base === 'bun' ? 'e' : ''))
  if (shortChars === '') return null

  const args = normalizedArgv.slice(1)
  if (!hasInlineScriptFlag(base, args, { [base]: shortChars })) return null

  for (let i = 1; i < normalizedArgv.length; i++) {
    const tok = normalizedArgv[i]
    if (tok === '--') break
    const eqIdx = tok.indexOf('=')
    const flagPart = eqIdx === -1 ? tok : tok.slice(0, eqIdx)
    if (INLINE_SCRIPT_LONG_FLAGS.has(flagPart)) {
      if (eqIdx !== -1) return alignedTokens[i].value.slice(eqIdx + 1)
      return alignedTokens[i + 1] ? alignedTokens[i + 1].value : null
    }
    if (tok.startsWith('-') && tok !== '-' && !tok.startsWith('--')) {
      for (const ch of shortChars) {
        const pos = tok.indexOf(ch, 1)
        if (pos !== -1) {
          const glued = tok.slice(pos + 1)
          if (glued.length > 0) return glued
          return alignedTokens[i + 1] ? alignedTokens[i + 1].value : null
        }
      }
    }
  }
  return null
}

/**
 * H-8 fix: a whole-word `ruflo`/`claude-flow`/`claude-flow-mcp` reference
 * sitting inside a quoted string within inline interpreter script text --
 * `node -e 'require("child_process").execSync("ruflo")'` never spells any
 * shell-tokenizable "ruflo" argv element (it is JS source text handed to
 * node's OWN parser), so H1–H8's argv-shaped predicates cannot see it.
 * The first alternative matches ANY quote-delimited run (single, double,
 * or backtick) containing the target word with word boundaries anywhere
 * inside it, which alone covers every one of this fix's own red arms
 * (`execSync("ruflo")`, `execSync("ruflo memory store")`,
 * `os.system("ruflo")`, `exec "ruflo"`). The second alternative is
 * defense-in-depth for an unquoted call-site form
 * (`system(`/`exec(`/`execSync(`/`spawn(` immediately followed by the
 * target word) that no red arm here exercises but the design's own
 * wording names explicitly.
 */
export const INLINE_SCRIPT_BARE_NAME_RE =
  /(['"`])(?:(?!\1).)*?\b(ruflo|claude-flow-mcp|claude-flow)\b(?:(?!\1).)*?\1|\b(?:system|exec|execSync|spawn)\(\s*['"`]?(ruflo|claude-flow-mcp|claude-flow)\b/i
