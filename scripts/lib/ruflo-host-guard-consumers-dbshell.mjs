#!/usr/bin/env node
/**
 * sqlite3/psql/osascript consumer-string extraction (SMI-6869 round-4
 * cross-family gate follow-up). Split into its own file from the start,
 * same precedent as `ruflo-host-guard-consumers-awksed.mjs`/`-git.mjs`/
 * `-tmux.mjs`, since three families' worth of extractors plus docblocks
 * would push `ruflo-host-guard-consumers.mjs` well past the 500-line gate.
 * Exported as `extractSqliteTexts`/`extractPsqlTexts`/`extractOsascriptTexts`
 * and wired into `ruflo-host-guard-consumers.mjs`'s own `EXTRACTORS` list.
 */

import { READABLE_STDIN_RE } from './ruflo-host-guard-consumers-awksed.mjs'

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
// same line/statement.
const PSQL_BACKSLASH_BANG_RE = /\\!\s+(.+)$/gm
// `COPY ... TO/FROM PROGRAM '...'` (server-side) and `\copy ... program
// '...'` (client-side) both hand the quoted program to a shell. The first
// alternative matches the ordinary quoted form; the second is a fallback for
// when the shell's OWN quoting has already stripped every quote character
// around the program name before this guard ever sees the argument text
// (measured: `psql -c '\copy t to program ''ruflo memory store'''` decodes,
// via this guard's own bash-quote-removal tokenizer, to the fully bare
// `\copy t to program ruflo memory store` -- no quote characters survive to
// anchor a quoted-only regex against). Alternation order matters: the
// quoted form is tried first, so it wins whenever a quote is actually
// present; the bare-text fallback only fires when `program` is immediately
// followed by non-quote text.
const PSQL_PROGRAM_RE = /\bprogram\s+'([^']*)'|\bprogram\s+(\S[^\n]*)/gi

function extractPsqlStatementTexts(text) {
  const results = []
  for (const m of text.matchAll(PSQL_BACKSLASH_BANG_RE)) {
    results.push({ text: m[1], kind: 'shell' })
  }
  for (const m of text.matchAll(PSQL_PROGRAM_RE)) {
    const shellText = m[1] ?? m[2]
    if (shellText) results.push({ text: shellText, kind: 'shell' })
  }
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
