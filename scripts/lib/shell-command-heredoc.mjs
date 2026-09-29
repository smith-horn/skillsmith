/**
 * Heredoc delimiter parsing and body consumption for the shell-command
 * tokenizer (SMI-6869 Fix B). Split out of `shell-command-tokenize.mjs`
 * purely to stay under the 500-line file-length gate
 * (`scripts/check-file-length.mjs`) once the redirect-operator and heredoc
 * handling pushed that file toward the limit.
 *
 * Scope, per the fix's own spec: only three delimiter forms are
 * recognised — a bare word, a fully single-quoted word, or a fully
 * double-quoted word (`<<EOF`, `<<'EOF'`, `<<"EOF"`, each optionally with a
 * space before the delimiter, and `<<-` for the tab-stripping form). A
 * partially-quoted or backslash-quoted delimiter (`E"O"F`, `\EOF`) is out
 * of scope — real bash treats ANY quoting/escaping in the delimiter as
 * disabling body substitution, but this tokenizer only needs to recognise
 * the three forms the fix's own case table exercises; a delimiter of
 * neither of those three exact shapes still tokenizes (as a bare word),
 * it just cannot be distinguished from the bare-word case here.
 */

import { readParen } from './shell-command-tokenize.mjs'

/** Characters that end a BARE (unquoted) heredoc delimiter word. */
function isDelimBoundary(ch) {
  return (
    ch === undefined ||
    /\s/.test(ch) ||
    ch === ';' ||
    ch === '|' ||
    ch === '&' ||
    ch === '<' ||
    ch === '>' ||
    ch === '(' ||
    ch === ')'
  )
}

/**
 * Parses the delimiter word immediately following a `<<`/`<<-` operator.
 * Skips leading spaces/tabs (not newlines, per `<< DELIM`'s own grammar).
 * @param {string} command
 * @param {number} pos index right after the `<<`/`<<-` operator text
 * @returns {{ delim: string, quoted: boolean, next: number }}
 */
export function parseHeredocDelimiter(command, pos) {
  let i = pos
  while (command[i] === ' ' || command[i] === '\t') i++
  if (command[i] === "'" || command[i] === '"') {
    const quoteChar = command[i]
    const e = command.indexOf(quoteChar, i + 1)
    const delim = e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
    return { delim, quoted: true, next: e === -1 ? command.length : e + 1 }
  }
  let j = i
  while (j < command.length && !isDelimBoundary(command[j])) j++
  return { delim: command.slice(i, j), quoted: false, next: j }
}

/**
 * Scans literal text for `$(...)` and backtick substitutions. Only called
 * for UNQUOTED heredoc bodies — a quoted delimiter (`<<'EOF'`) disables
 * substitution entirely, so the caller never invokes this for one.
 * @param {string} text
 * @returns {string[]}
 */
function extractSubsFromText(text) {
  const subs = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '$' && text[i + 1] === '(') {
      const r = readParen(text, i + 1)
      subs.push(r.inner)
      i = r.next
      continue
    }
    if (c === '`') {
      const e = text.indexOf('`', i + 1)
      subs.push(e === -1 ? text.slice(i + 1) : text.slice(i + 1, e))
      i = e === -1 ? text.length : e + 1
      continue
    }
    i++
  }
  return subs
}

/**
 * Fills in every pending heredoc token's `.value`/`.subs`, consuming body
 * lines starting at `pos` (the position right after the newline that ended
 * the heredoc-introducing line). Several heredocs opened on one line are
 * filled in the order they were opened, matching real bash's own ordering.
 * A terminator line is matched EXACTLY (after optional `<<-` tab-strip);
 * if it is never found, the body runs to end of input (design choice,
 * matching real bash's own "unterminated heredoc" behavior at EOF rather
 * than erroring).
 * @param {string} command
 * @param {number} pos
 * @param {Array<{delim: string, quoted: boolean, dash: boolean, value: string|null, subs: string[]}>} pendingHeredocs
 * @returns {number} the position right after the last consumed terminator line
 */
export function consumeHeredocBodies(command, pos, pendingHeredocs) {
  let cursor = pos
  for (const token of pendingHeredocs) {
    const lines = []
    for (;;) {
      const lineEnd = command.indexOf('\n', cursor)
      const rawLine = lineEnd === -1 ? command.slice(cursor) : command.slice(cursor, lineEnd)
      const line = token.dash ? rawLine.replace(/^\t+/, '') : rawLine
      if (line === token.delim) {
        cursor = lineEnd === -1 ? command.length : lineEnd + 1
        break
      }
      if (lineEnd === -1) {
        lines.push(line)
        cursor = command.length
        break
      }
      lines.push(line)
      cursor = lineEnd + 1
    }
    token.value = lines.length > 0 ? lines.join('\n') + '\n' : ''
    token.subs = token.quoted ? [] : extractSubsFromText(token.value)
  }
  pendingHeredocs.length = 0
  return cursor
}
