/**
 * SMI-6033 Wave 2 (Gap 3): Edge password-protected archive evasion detector
 * @module scripts/indexer/_shared/security-scanner-edge.archive (Node port)
 *
 * Port of @skillsmith/core SecurityScanner.archive.ts — zero zip/archive/
 * password logic existed anywhere in the edge scanner before this file. Two
 * sub-signals, single finding type (`archive_evasion`), two-tier severity
 * within that one type:
 *
 * - CLI invocation syntax (`unzip -P`, `unrar x -p<pw>`, `7z x -p<pw>`,
 *   `zip -P <pw> ... -e`) — precise, low-FP.
 * - Prose co-occurrence (an archive noun + a password noun within a bounded
 *   ±2-line window) — the FP-prone fuzzy case, a SEPARATE code path from the
 *   CLI-syntax case so its confidence/severity stays capped independently.
 *
 * Per the plan's §9 provenance-conditioned quarantine policy: a signal may
 * quarantine alone only when a provenance condition specific to THIS skill's
 * own content removes the legitimate interpretations. For archive passwords
 * that condition is "inline literal password AND correlated with a fetch
 * destination in the same content" — every legitimate counter-example
 * (licensed SDK, commercial font/media pack, encrypted export, vendor
 * support bundle) delivers the password out-of-band. Every other shape
 * (out-of-band `$VAR`/placeholder password, uncorrelated CLI usage, or
 * prose-only mention) stays medium (advisory) — never split into a second
 * finding type; severity alone carries the two-tier design.
 *
 * Byte-identical body across both _shared twins (parity test enforces); only
 * the @module header line above differs. Pure Deno/Web APIs, no Node deps.
 */

import type { SecurityFinding, LineContext } from './security-scanner-edge.context.ts'
import { isDocumentationContext, classifyMatch } from './security-scanner-edge.context.ts'
import { looksLikePlaceholderSecret } from './security-scanner-edge.paths.ts'
import {
  FETCH_COMMAND_PATTERN,
  isCorrelatedWithFetchDestination,
} from './security-scanner-edge.fetch-correlation.ts'

// ReDoS protection: maximum line length for regex matching (mirrors scanner).
const MAX_LINE_LENGTH = 10000

function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}

// ============================================================================
// Sub-signal A: CLI invocation syntax
// ============================================================================

// Bounded per-tool invocation captures (mirrors CHMOD_TARGET's
// capture-then-inspect style rather than one large combined alternation).
// The password is extracted from the captured (bounded-length) segment via
// a lightweight follow-up regex, per tool syntax:
//   - unzip: `-P <password>` (space-separated; real unzip CLI syntax).
//   - unrar/7z: `-p<password>` (ATTACHED, no space — real unrar/7z CLI
//     syntax; a bare `-p` with nothing attached means "prompt
//     interactively," i.e. no inline password at all, so it is correctly
//     NOT matched by the one-or-more `\S+` capture below).
//   - zip: `-P <password>` (space-separated) AND the `-e` encrypt flag
//     present somewhere on the same bounded segment.
const UNZIP_INVOCATION = /\bunzip\b[^\n]{0,200}/i
const UNRAR_INVOCATION = /\bunrar\s+x\b[^\n]{0,200}/i
const SEVENZIP_INVOCATION = /\b7z\s+x\b[^\n]{0,200}/i
const ZIP_INVOCATION = /\bzip\b[^\n]{0,200}/i

const UNZIP_PASSWORD_ARG = /-P\s+(\S{1,200})/
const UNRAR_SEVENZIP_PASSWORD_ARG = /-p(\S{1,200})/i
const ZIP_PASSWORD_ARG = /-P\s+(\S{1,200})/
const ZIP_ENCRYPT_FLAG = /(?:^|\s)-e(?:\s|$)/

// First archive-extension-bearing token on the line — the CLI's target file.
const ARCHIVE_FILENAME = /(\S+\.(?:zip|rar|7z|tar\.gz|tgz))\b/i

interface ArchiveCliMatch {
  tool: 'unzip' | 'unrar' | '7z' | 'zip'
  password: string
  index: number
}

function findArchiveCliPassword(line: string): ArchiveCliMatch | null {
  const unzip = safeRegexTest(UNZIP_INVOCATION, line)
  if (unzip) {
    const pw = unzip[0].match(UNZIP_PASSWORD_ARG)
    if (pw) return { tool: 'unzip', password: pw[1], index: unzip.index ?? 0 }
  }
  const unrar = safeRegexTest(UNRAR_INVOCATION, line)
  if (unrar) {
    const pw = unrar[0].match(UNRAR_SEVENZIP_PASSWORD_ARG)
    if (pw) return { tool: 'unrar', password: pw[1], index: unrar.index ?? 0 }
  }
  const sevenZip = safeRegexTest(SEVENZIP_INVOCATION, line)
  if (sevenZip) {
    const pw = sevenZip[0].match(UNRAR_SEVENZIP_PASSWORD_ARG)
    if (pw) return { tool: '7z', password: pw[1], index: sevenZip.index ?? 0 }
  }
  const zip = safeRegexTest(ZIP_INVOCATION, line)
  if (zip) {
    const pw = zip[0].match(ZIP_PASSWORD_ARG)
    if (pw && ZIP_ENCRYPT_FLAG.test(zip[0])) {
      return { tool: 'zip', password: pw[1], index: zip.index ?? 0 }
    }
  }
  return null
}

function extractArchiveTargetBasename(line: string): string {
  const m = line.match(ARCHIVE_FILENAME)
  if (!m) return ''
  return m[1].replace(/['"]/g, '').split('/').pop() ?? ''
}

// `$VAR` / `${VAR}` bare shell-variable reference — an out-of-band password.
const SHELL_VAR_REF = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/

// Is `password` an inline LITERAL secret (not a shell-variable reference,
// not a placeholder/low-entropy example value)? Reuses the same
// looksLikePlaceholderSecret gate the sensitive_path/PII detectors use.
//
// SMI-6033 Wave 4 bugfix (byte-identical fix to core's SecurityScanner.archive.ts):
// the CLI password-arg regexes capture RAW (quotes included), so
// `unzip -P "$VAR" x.zip` arrived here as `"$VAR"` — SHELL_VAR_REF never
// matched a leading quote, so this fell through to looksLikePlaceholderSecret
// (which also doesn't recognize it) and was misclassified as an inline
// LITERAL secret, reaching standalone-critical on a benign shell idiom when
// correlated. Strip surrounding quotes first.
function isInlineLiteralPassword(password: string): boolean {
  if (!password) return false
  const unquoted = password.replace(/^['"]|['"]$/g, '')
  if (SHELL_VAR_REF.test(unquoted)) return false
  return !looksLikePlaceholderSecret(unquoted)
}

// ============================================================================
// Sub-signal B: prose co-occurrence (fuzzy, medium-only)
// ============================================================================

const ARCHIVE_NOUN = /\b(?:zip|rar|7z|tar\.gz|tgz|archive)\b/i
const PASSWORD_NOUN = /\bpassword\b|\bpasscode\b|\bpassphrase\b/i

// Line numbers (1-indexed) where an archive noun co-occurs with a password
// noun within a bounded ±2-line window (same line or 2 lines either side).
function findArchivePasswordProseLines(lines: string[]): number[] {
  const flagged = new Set<number>()
  lines.forEach((line, index) => {
    if (!ARCHIVE_NOUN.test(line)) return
    const start = Math.max(0, index - 2)
    const end = Math.min(lines.length - 1, index + 2)
    for (let i = start; i <= end; i++) {
      if (PASSWORD_NOUN.test(lines[i])) {
        flagged.add(index + 1)
        break
      }
    }
  })
  return Array.from(flagged)
}

// ============================================================================
// Detector
// ============================================================================

export function scanArchiveEvasion(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const fetchLines = lines.filter((l) => FETCH_COMMAND_PATTERN.test(l))
  const emittedLines = new Set<number>()

  // Sub-signal A: CLI invocation syntax.
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const cli = findArchiveCliPassword(line)
    if (!cli) continue

    const { inDocContext, confidence } = classifyMatch(contexts[index], line, cli.index)

    const inlineLiteral = isInlineLiteralPassword(cli.password)
    const targetBasename = extractArchiveTargetBasename(line)
    const correlated =
      targetBasename.length >= 3 && isCorrelatedWithFetchDestination(targetBasename, fetchLines)
    const critical = !inDocContext && inlineLiteral && correlated

    findings.push({
      type: 'archive_evasion',
      severity: inDocContext ? 'low' : critical ? 'critical' : 'medium',
      message: `Password-protected archive CLI usage (${cli.tool}): "${line.trim().slice(0, 100)}"`,
      lineNumber,
      location: line.trim().slice(0, 100),
      inDocumentationContext: inDocContext,
      confidence,
    })
    emittedLines.add(lineNumber)
  }

  // Sub-signal B: prose co-occurrence — the fuzzy, FP-prone case. NEVER
  // critical, and capped at 'medium' confidence to reflect the heuristic's
  // own uncertainty.
  for (const lineNumber of findArchivePasswordProseLines(lines)) {
    if (emittedLines.has(lineNumber)) continue
    const inDocContext = isDocumentationContext(contexts[lineNumber - 1])
    findings.push({
      type: 'archive_evasion',
      severity: inDocContext ? 'low' : 'medium',
      message: `Archive and password mentioned in close proximity: "${lines[lineNumber - 1].trim().slice(0, 100)}"`,
      lineNumber,
      location: lines[lineNumber - 1].trim().slice(0, 100),
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'medium',
    })
  }

  return findings
}
