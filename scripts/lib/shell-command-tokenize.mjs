/**
 * Shell-command tokenizer (quote-aware, records command substitutions),
 * shared by `scripts/env-read-guard.mjs` and `scripts/ruflo-host-guard.mjs`
 * via `scripts/lib/shell-command-normalize.mjs`. A backtick the tokenizer
 * interprets as a substitution (unquoted, or inside double quotes) is
 * spelled $(...) in .value, its body unchanged in .subs, so both spellings
 * reach every downstream $-based unresolvable-head test identically; a
 * backtick inside single quotes, behind a backslash, or in a heredoc body
 * is literal text and stays as written.
 *
 * Split out of `shell-command-normalize.mjs` itself (SMI-6744 Wave 4 delta
 * governance round) purely to stay under the 500-line-per-file convention
 * this repo keeps by hand for .mjs files under scripts/ (M3 correction:
 * not enforced by tooling here — `scripts/check-file-length.mjs` only runs
 * via `lint-staged` for `*.ts`/`*.sh`; SMI-5994) once the H-6 ANSI-C-quoting
 * fix and its own docblock corrections pushed that file past the limit —
 * `shell-command-normalize.mjs` imports `tokenize`/`basenameOf` back from
 * here and RE-EXPORTS them, so no consumer's own import path changes.
 */

import { decodeEscapeAt } from './shell-escape-decode.mjs'
// L7 correction: `shell-command-heredoc.mjs` imports `readParen` back from
// THIS file — a real circular import. It is safe only because both sides
// are hoisted function declarations (`function foo() {}`, not `const foo =
// () => {}`) consumed at CALL time, after both modules have finished
// loading, never at each other's own module-evaluation time.
import { consumeHeredocBodies, parseHeredocDelimiter } from './shell-command-heredoc.mjs'

/** @param {string} p */
export function basenameOf(p) {
  return p.split('/').pop()
}

// --- Tokenizer (quote-aware, records command substitutions) ---

/** Index just past the closing `"` starting at s[i] === '"'. */
function skipDouble(s, i) {
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2
      continue
    }
    if (s[j] === '"') return j + 1
    j++
  }
  return s.length
}

/**
 * Balanced-paren read; s[start] === '('. Exported (SMI-6869 Fix B) so
 * `shell-command-heredoc.mjs` can reuse it to scan an unquoted heredoc
 * body for `$(...)` substitutions the same way ordinary quoted text does.
 */
export function readParen(s, start) {
  let depth = 0
  let i = start
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      i = e === -1 ? s.length : e + 1
      continue
    }
    if (c === '"') {
      i = skipDouble(s, i)
      continue
    }
    if (c === '(') {
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth--
      i++
      if (depth === 0) return { inner: s.slice(start + 1, i - 1), next: i }
      continue
    }
    i++
  }
  return { inner: s.slice(start + 1), next: s.length }
}

/**
 * Parses one redirect operator's characters starting at `command[i]` — `c`
 * (`command[i]`) must be `<`, `>`, or `&` (the last only when
 * `command[i+1] === '>'`, i.e. `&>`/`&>>`). Recognizes every POSIX/Bash
 * redirect operator: `<`, `<<`, `<<-`, `<<<`, `<>`, `<&`, `>`, `>>`, `>|`,
 * `>&`, `&>`, `&>>` (SMI-6869 Fix A).
 * @param {string} command
 * @param {number} i
 * @returns {{ op: string, next: number }}
 */
function readRedirectOperator(command, i) {
  const c = command[i]
  if (c === '&') {
    if (command[i + 2] === '>') return { op: '&>>', next: i + 3 }
    return { op: '&>', next: i + 2 }
  }
  if (c === '<') {
    if (command[i + 1] === '<') {
      if (command[i + 2] === '<') return { op: '<<<', next: i + 3 }
      if (command[i + 2] === '-') return { op: '<<-', next: i + 3 }
      return { op: '<<', next: i + 2 }
    }
    if (command[i + 1] === '>') return { op: '<>', next: i + 2 }
    if (command[i + 1] === '&') return { op: '<&', next: i + 2 }
    return { op: '<', next: i + 1 }
  }
  // c === '>'
  if (command[i + 1] === '>') return { op: '>>', next: i + 2 }
  if (command[i + 1] === '|') return { op: '>|', next: i + 2 }
  if (command[i + 1] === '&') return { op: '>&', next: i + 2 }
  return { op: '>', next: i + 1 }
}

/**
 * Split a command string into word/operator tokens. Word tokens carry
 * their unquoted `value` plus any `$(...)` / backtick bodies in `subs`. A
 * redirect operator (and any target GLUED directly onto it, no space) is
 * ONE word token marked `redirect: true` (SMI-6869 Fix A) — consumers that
 * build argv from word tokens must exclude these; `findShellFedLiteralText`
 * deliberately does NOT, since it still needs to see a glued `<<<text`
 * shape. A SEPARATE (space-separated) target word is ALSO marked
 * `redirect: true` (SMI-6869 C1 correction): when a redirect token is
 * flushed with nothing glued onto it, the very next word token — and only
 * that one — is tagged as the pending target and cleared on any operator
 * or newline; the original Fix A left this word untagged, so it became a
 * bare argv[0] (`> ls ruflo memory store` reached `checkBareNameInversion`
 * as `ls ruflo memory store`, and `ls` sits on `NON_EXECUTING_VERBS`,
 * exempting the whole segment — a real bypass, not a cosmetic gap). A
 * heredoc (`<<`/`<<-`) produces its own `{type: 'heredoc', ...}` token
 * instead, filled in once the introducing line's newline is reached
 * (SMI-6869 Fix B) — see `shell-command-heredoc.mjs`.
 * @param {string} command
 */
export function tokenize(command) {
  const tokens = []
  const pendingHeredocs = []
  let cur = null
  let pendingRedirectToken = null
  let pendingRedirectOpText = ''
  const flush = () => {
    if (cur !== null) {
      tokens.push(cur)
      // A redirect operator token flushed with NOTHING glued onto it means
      // its target is the NEXT word (`> out cmd`), which is likewise not
      // part of the command's own argv.
      if (cur === pendingRedirectToken && cur.value === pendingRedirectOpText) {
        awaitingRedirectTarget = true
      }
    }
    cur = null
    pendingRedirectToken = null
  }
  let awaitingRedirectTarget = false
  const word = () => {
    if (cur === null) {
      cur = { type: 'word', value: '', subs: [] }
      if (awaitingRedirectTarget) {
        cur.redirect = true
        awaitingRedirectTarget = false
      }
    }
    return cur
  }
  const pushOp = (value, width, i) => {
    flush()
    awaitingRedirectTarget = false
    tokens.push({ type: 'op', value })
    return i + width
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (c === '\\') {
      if (i + 1 < command.length) word().value += command[i + 1]
      i += 2
      continue
    }
    if (c === "'") {
      const e = command.indexOf("'", i + 1)
      word().value += e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
      i = e === -1 ? command.length : e + 1
      continue
    }
    if (c === '"') {
      const w = word()
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') {
          if (j + 1 < command.length) w.value += command[j + 1]
          j += 2
        } else if (command[j] === '$' && command[j + 1] === '(') {
          const r = readParen(command, j + 1)
          w.subs.push(r.inner)
          w.value += command.slice(j, r.next)
          j = r.next
        } else if (command[j] === '`') {
          const e = command.indexOf('`', j + 1)
          const inner = e === -1 ? command.slice(j + 1) : command.slice(j + 1, e)
          w.subs.push(inner)
          w.value += '$(' + inner + ')'
          j = e === -1 ? command.length : e + 1
        } else {
          w.value += command[j]
          j++
        }
      }
      i = j < command.length ? j + 1 : command.length
      continue
    }
    if (c === '`') {
      const w = word()
      const e = command.indexOf('`', i + 1)
      const inner = e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
      w.subs.push(inner)
      w.value += '$(' + inner + ')'
      i = e === -1 ? command.length : e + 1
      continue
    }
    if (c === '$' && command[i + 1] === "'") {
      // ANSI-C quoting (H-6 fix, SMI-6744 Wave 4 governance round, broadened
      // by the C1 delta-round fix): `$'...'` is a distinct Bash quoting form
      // from a plain `'...'` — unlike single quotes, its body's own
      // backslash escapes ARE processed, so `bash -c $'npx ruflo memory
      // store'` reached `extractShellDashC` with the LITERAL text `$'npx
      // ruflo memory store'` still attached to the `$`, which never equalled
      // the decoded command text `H1`/`H4`/`H5` test for. The escape table
      // itself now lives in the shared `decodeEscapeAt` (SMI-6744 C1 fix) —
      // the ORIGINAL fix here only covered `\n`, `\t`, `\\`, `\'`, and
      // `\xHH`, which left `\NNN` (octal), `\uHHHH`, and `\UHHHHHHHH` still
      // decoding to their own literal text, a live bypass
      // (`$'\162uflo' memory store` reached `decide()` as `\162uflo`, never
      // equalling `ruflo`) — see that module's own docblock for the full
      // table and the bash/zsh divergence its "unrecognized escape" arm
      // preserves. Dropping the `$` and reusing the current word (`word()`,
      // not a fresh one) lets `$'text'` glued directly onto other
      // characters compose the same way a plain quoted segment already
      // does.
      const w = word()
      let j = i + 2
      while (j < command.length && command[j] !== "'") {
        if (command[j] === '\\') {
          const r = decodeEscapeAt(command, j)
          w.value += r.value
          j = r.next
          continue
        }
        w.value += command[j]
        j++
      }
      i = j < command.length ? j + 1 : command.length
      continue
    }
    if ((c === '$' || c === '<' || c === '>') && command[i + 1] === '(') {
      const w = word()
      const r = readParen(command, i + 1)
      w.subs.push(r.inner)
      w.value += command.slice(i, r.next)
      i = r.next
      continue
    }
    // SMI-6869 Fix A: `&>`/`&>>` (redirect both stdout+stderr) — checked
    // before the plain `&` operator dispatch below, and before the `<`/`>`
    // branch (which handles every OTHER redirect form) since this one
    // starts with `&`, not `<`/`>`. No fd-prefix support here (real Bash
    // does not allow a leading digit on `&>`/`&>>` either) — always flush
    // whatever word was in progress.
    if (c === '&' && command[i + 1] === '>') {
      flush()
      const { op, next } = readRedirectOperator(command, i)
      cur = { type: 'word', value: op, subs: [], redirect: true }
      pendingRedirectToken = cur
      pendingRedirectOpText = op
      i = next
      continue
    }
    // SMI-6869 Fix A/B: every other redirect operator (`<`, `<<`, `<<-`,
    // `<<<`, `<>`, `<&`, `>`, `>>`, `>|`, `>&`) and the heredoc forms
    // (`<<`/`<<-`) they include. An unquoted `<`/`>` ends the current word
    // UNLESS that word is a bare digit sequence (a file-descriptor
    // redesignator, e.g. `2>`), in which case the digits stay attached to
    // the operator instead of becoming their own word token.
    if (c === '<' || c === '>') {
      let fdPrefix = ''
      if (cur !== null && cur.subs.length === 0 && /^[0-9]+$/.test(cur.value)) {
        fdPrefix = cur.value
        cur = null
      } else {
        flush()
      }
      const { op, next } = readRedirectOperator(command, i)
      if (op === '<<' || op === '<<-') {
        const dash = op === '<<-'
        const { delim, quoted, next: afterDelim } = parseHeredocDelimiter(command, next)
        const heredocToken = { type: 'heredoc', value: null, quoted, subs: [], delim, dash }
        tokens.push(heredocToken)
        pendingHeredocs.push(heredocToken)
        i = afterDelim
        continue
      }
      cur = { type: 'word', value: fdPrefix + op, subs: [], redirect: true }
      pendingRedirectToken = cur
      pendingRedirectOpText = fdPrefix + op
      i = next
      continue
    }
    if (c === '\n') {
      i = pushOp('\n', 1, i)
      // SMI-6869 Fix B: this newline ends the line that opened every
      // still-pending heredoc — consume their bodies now, before
      // tokenizing continues, so the body lines never get tokenized as
      // ordinary command text (the bug this fix exists to close).
      if (pendingHeredocs.length > 0) {
        i = consumeHeredocBodies(command, i, pendingHeredocs)
      }
      continue
    }
    if (/\s/.test(c)) {
      flush()
      i++
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      i = pushOp(two, 2, i)
      continue
    }
    // `|&` is shorthand for a pipe that also redirects stderr — treated
    // here as plain `|` (SMI-6869 Fix A): this guard's own segmentation
    // only needs to know a pipe boundary occurred, not the stderr detail.
    if (two === '|&') {
      i = pushOp('|', 2, i)
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      i = pushOp(c, 1, i)
      continue
    }
    word().value += c
    i++
  }
  flush()
  // SMI-6869 Fix B safety net: a heredoc whose introducing line has no
  // trailing newline at all (the delimiter word is the literal end of the
  // whole command string) never reaches the newline-triggered consumption
  // above — treat its body as empty rather than leaving `value: null`.
  if (pendingHeredocs.length > 0) {
    for (const token of pendingHeredocs) {
      token.value = ''
      token.subs = []
    }
    pendingHeredocs.length = 0
  }
  return tokens
}
