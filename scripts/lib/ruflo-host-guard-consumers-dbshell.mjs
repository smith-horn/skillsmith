#!/usr/bin/env node
/**
 * sqlite3/psql/osascript consumer-string extraction (SMI-6869 round-4
 * cross-family gate follow-up). Split into its own file from the start,
 * same precedent as `ruflo-host-guard-consumers-awksed.mjs`/`-git.mjs`/
 * `-tmux.mjs`, since three families' worth of extractors plus docblocks
 * would push `ruflo-host-guard-consumers.mjs` well past the 500-line-per-file
 * convention this repo keeps by hand for .mjs files under scripts/ (M3
 * correction: not enforced by tooling here — `scripts/check-file-length.mjs`
 * only runs via `lint-staged` for `*.ts`/`*.sh`; SMI-5994).
 * Exported as `extractSqliteTexts`/`extractPsqlTexts`/`extractOsascriptTexts`
 * and wired into `ruflo-host-guard-consumers.mjs`'s own `EXTRACTORS` list.
 */

import { READABLE_STDIN_RE } from './ruflo-host-guard-consumers-awksed.mjs'
import { decodeShellEscapes } from './shell-escape-decode.mjs'

const SQLITE_BASENAMES = new Set(['sqlite3', 'sqlite'])

// A line/statement starting with sqlite3's own `.shell`/`.system` dot-command
// hands the remainder straight to a shell. `[ \t]*` (not `\s*`) so a blank
// line doesn't also match via `\n`.
const SQLITE_SHELL_COMMAND_RE = /^[ \t]*\.(?:shell|system)[ \t]+(.+)$/gm
// `.once`/`.output` normally redirect query output to a FILE, but a leading
// `|` instead pipes it to a program sqlite3 itself spawns via popen(3).
const SQLITE_PIPE_OUTPUT_RE = /^[ \t]*\.(?:once|output)[ \t]+\|[ \t]*(.+)$/gm

function extractSqliteDotCommandTexts(text) {
  const results = []
  for (const m of text.matchAll(SQLITE_SHELL_COMMAND_RE)) {
    results.push({ text: m[1], kind: 'shell' })
  }
  for (const m of text.matchAll(SQLITE_PIPE_OUTPUT_RE)) {
    results.push({ text: m[1], kind: 'shell' })
  }
  return results
}

/**
 * sqlite3/sqlite: every `-cmd`/`--cmd` value, and every positional argument
 * AFTER the (first, optional) database-path positional, is sqlite3 command
 * text -- ordinary SQL passed this way is not itself extracted; only a
 * `.shell`/`.system`/piped-`.once`/piped-`.output` dot-command inside that
 * text is (measured: `sqlite3 x.db '.tables'` finds nothing and allows,
 * `sqlite3 /tmp/x.db '.shell ruflo memory store'` extracts the remainder as
 * real shell text).
 */
export function extractSqliteTexts(base, argv, alignedTokens) {
  if (!SQLITE_BASENAMES.has(base)) return null
  const candidates = []
  let sawDbPath = false
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '-cmd' || a === '--cmd') {
      if (alignedTokens[i + 1]) candidates.push(alignedTokens[i + 1].value)
      i += 2
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    if (!sawDbPath) {
      sawDbPath = true
      i++
      continue
    }
    if (alignedTokens[i]) candidates.push(alignedTokens[i].value)
    i++
  }
  const results = candidates.flatMap(extractSqliteDotCommandTexts)
  return results.length > 0 ? results : null
}

// psql's `\!` meta-command shells out to whatever text follows it on the
// same line/statement -- with or without whitespace: `\s*` (round-4
// confirmation-round finding), since real psql accepts the GLUED form
// (`\!ruflo memory store`, no space) identically to the spaced one
// (measured: the guard's own `.\s+` original missed the glued form).
const PSQL_BACKSLASH_BANG_RE = /\\!\s*(.+)$/gm

// (Round-4 confirmation-round Class 2 fix) `program` is only executable
// syntax inside an actual `COPY ... TO/FROM` clause or a `\copy ... to/from`
// meta-command -- NOT anywhere the bare word "program" appears, including
// inside an unrelated string literal (`select 'program ...'`). Anchor to a
// COPY/`\copy` keyword, then a TO/FROM keyword, then PROGRAM, all within the
// SAME statement (bounded by `;` or a newline -- `[^;\n]*?` never crosses
// either, so an earlier statement's COPY can't license a later statement's
// unrelated `program` mention). This is a keyword scanner, not a real SQL
// parser: it cannot tell a GENUINE COPY clause from a STRING LITERAL that
// merely CONTAINS the words "copy ... to ... program" as data (see the
// `known over-deny` test in the guard test file for the measured case and
// why this guard accepts that tradeoff).
const PSQL_COPY_PROGRAM_CONTEXT_RE =
  /(?:\bcopy\b|\\copy\b)[^;\n]*?\b(?:to|from)\b[^;\n]*?\bprogram\b/gi

/**
 * Scans a single-quoted PostgreSQL string literal starting at `text[pos]`
 * (which MUST be `'`). Doubled quotes (`''`) are the standard SQL escape for
 * a literal quote inside the string -- not a backslash. For an E-prefixed
 * literal (`isEString`), a backslash-escaped quote (`\'`) ALSO continues the
 * string (both forms are valid inside an E-string), and every OTHER
 * backslash escape in the raw content is decoded via the shared
 * `decodeShellEscapes` table AFTER the doubled-quote unescape -- the same
 * hex/octal/unicode escape hazard class this guard's own `$'...'`
 * ANSI-C-quoting fix closed for bash, applied here so a hex-obfuscated
 * "ruflo" (`E'\x72uflo...'`) cannot hide inside a PROGRAM operand. A plain
 * (non-E) literal's backslashes are NOT escapes in modern PostgreSQL
 * (`standard_conforming_strings` defaults on) -- only the doubled-quote
 * unescape applies.
 * @returns {{ value: string, endPos: number } | null} `endPos` is the index
 *   just past the CLOSING quote; `null` if the string is never closed.
 */
function scanQuotedLiteral(text, pos, isEString) {
  let i = pos + 1
  let raw = ''
  while (i < text.length) {
    const ch = text[i]
    if (isEString && ch === '\\' && i + 1 < text.length) {
      raw += ch + text[i + 1]
      i += 2
      continue
    }
    if (ch === "'") {
      if (text[i + 1] === "'") {
        raw += "''"
        i += 2
        continue
      }
      const unescaped = raw.replace(/''/g, "'")
      return { value: isEString ? decodeShellEscapes(unescaped) : unescaped, endPos: i + 1 }
    }
    raw += ch
    i++
  }
  return null
}

/**
 * Scans a PostgreSQL dollar-quoted string literal (`$$...$$` or
 * `$tag$...$tag$`) starting at `text[pos]` (which MUST be `$`). No escape
 * processing inside one -- its whole design point is that nothing is
 * special until the matching closing tag reappears.
 * @returns {{ value: string, endPos: number } | null}
 */
function scanDollarQuotedLiteral(text, pos) {
  const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(pos))
  if (!tagMatch) return null
  const opener = tagMatch[0]
  const closeIdx = text.indexOf(opener, pos + opener.length)
  if (closeIdx === -1) return null
  return { value: text.slice(pos + opener.length, closeIdx), endPos: closeIdx + opener.length }
}

/**
 * Parses the PROGRAM operand starting at `text[pos]` (already past
 * `program` and its following whitespace) as a real PostgreSQL string:
 * optional `E`/`e` prefix + single-quoted literal, or a dollar-quoted
 * string, in that order. Falls back to the bare-text shape (round-4
 * measured: bash's own quote removal can strip every Postgres-level quote
 * character before this guard ever sees the argument -- `psql -c '\copy t
 * to program ''ruflo memory store'''` decodes to the fully bare `...program
 * ruflo memory store`) only when NONE of the quoted forms match.
 */
function parsePsqlProgramOperand(text, pos) {
  if (/^[Ee]'/.test(text.slice(pos))) {
    const scanned = scanQuotedLiteral(text, pos + 1, true)
    if (scanned) return scanned.value
  }
  if (text[pos] === "'") {
    const scanned = scanQuotedLiteral(text, pos, false)
    if (scanned) return scanned.value
  }
  if (text[pos] === '$') {
    const scanned = scanDollarQuotedLiteral(text, pos)
    if (scanned) return scanned.value
  }
  const bareMatch = /^(\S[^\n]*)/.exec(text.slice(pos))
  return bareMatch ? bareMatch[1] : null
}

function extractPsqlProgramTexts(text) {
  const results = []
  for (const m of text.matchAll(PSQL_COPY_PROGRAM_CONTEXT_RE)) {
    const afterKeyword = m.index + m[0].length
    const wsMatch = /^\s+/.exec(text.slice(afterKeyword))
    const operandStart = afterKeyword + (wsMatch ? wsMatch[0].length : 0)
    const value = parsePsqlProgramOperand(text, operandStart)
    if (value) results.push({ text: value, kind: 'shell' })
  }
  return results
}

function extractPsqlStatementTexts(text) {
  const results = []
  for (const m of text.matchAll(PSQL_BACKSLASH_BANG_RE)) {
    results.push({ text: m[1], kind: 'shell' })
  }
  results.push(...extractPsqlProgramTexts(text))
  return results
}

/**
 * psql: every `-c`/`--command` value is psql text, as is a heredoc feeding
 * `-f -`/`-f /dev/stdin`/`-f /dev/fd/N` (the same READABLE_STDIN_RE +
 * segment-heredoc lookup `extractAwkTexts`/`extractSedTexts` already use for
 * `-f`, imported rather than duplicated). Ordinary SQL inside that text is
 * not itself extracted; only a `\!` shell-out or a `PROGRAM`-clause COPY/
 * `\copy` is.
 */
export function extractPsqlTexts(base, argv, alignedTokens, segmentTokens) {
  if (base !== 'psql') return null
  const texts = []
  let sawDashF = false
  let dashFValue = null
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '-c' || a === '--command') {
      if (alignedTokens[i + 1]) texts.push(alignedTokens[i + 1].value)
      i += 2
      continue
    }
    if (a.startsWith('--command=')) {
      texts.push(a.slice('--command='.length))
      i++
      continue
    }
    if (a.startsWith('-c') && a !== '-c') {
      texts.push(a.slice(2))
      i++
      continue
    }
    if (a === '-f' || a === '--file') {
      sawDashF = true
      dashFValue = argv[i + 1] ?? null
      i += 2
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      i++
      continue
    }
    i++
  }
  if (sawDashF && dashFValue && READABLE_STDIN_RE.test(dashFValue) && segmentTokens) {
    const heredocToks = segmentTokens.filter((t) => t.type === 'heredoc')
    if (heredocToks.length > 0) {
      texts.push(heredocToks.map((t) => t.value ?? '').join('\n'))
    }
  }
  const results = texts.flatMap(extractPsqlStatementTexts)
  return results.length > 0 ? results : null
}

/**
 * osascript: every `-e` value is AppleScript SOURCE, given the same
 * `INLINE_SCRIPT_BARE_NAME_RE`-then-embedded-recursion treatment as any
 * other `kind: 'source'` text (see `ruflo-host-guard-consumers.mjs`'s own
 * docblock). Measured (not assumed): a `do shell script "ruflo memory
 * store"` value is caught by the EXISTING quoted-bare-name alternative of
 * `INLINE_SCRIPT_BARE_NAME_RE` -- a quoted string containing a bare `ruflo`
 * mention -- with no `do shell script`-specific extraction needed; the
 * "with administrator privileges" suffix variant matches identically. A
 * script FILE argument (no `-e`) is unreadable and ignored, same posture as
 * any other file-sourced program text this guard cannot see into.
 */
export function extractOsascriptTexts(base, argv, alignedTokens) {
  if (base !== 'osascript') return null
  const results = []
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '-e') {
      if (alignedTokens[i + 1]) results.push({ text: alignedTokens[i + 1].value, kind: 'source' })
      i += 2
      continue
    }
    if (a.startsWith('-e') && a !== '-e') {
      results.push({ text: a.slice(2), kind: 'source' })
      i++
      continue
    }
    i++
  }
  return results.length > 0 ? results : null
}
