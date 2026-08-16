/**
 * Security Scanner — password-protected archive evasion detector
 * @module @skillsmith/core/security/scanner/SecurityScanner.archive
 *
 * SMI-6033 Wave 2 (Gap 3): zero zip/archive/password logic existed anywhere
 * in the scanner before this file. Two sub-signals, single finding type
 * (`archive_evasion`), two-tier severity within that one type:
 *
 * - CLI invocation syntax (`unzip -P`, `unrar x -p<pw>`, `7z x -p<pw>`,
 *   `zip -P <pw> ... -e`) — precise, low-FP.
 * - Prose co-occurrence (an archive noun + a password noun within a bounded
 *   ±2-line window) — the FP-prone fuzzy case, kept as a SEPARATE code path
 *   from the CLI-syntax case so its confidence/severity can stay capped
 *   independently.
 *
 * Per the plan's §9 provenance-conditioned quarantine policy: a signal may
 * quarantine alone only when a provenance condition specific to THIS skill's
 * own content removes the legitimate interpretations. For archive passwords
 * that condition is "inline literal password AND correlated with a fetch
 * destination in the same content" — every legitimate counter-example
 * (licensed SDK, commercial font/media pack, encrypted export, vendor
 * support bundle) delivers the password out-of-band; shipping it inline next
 * to the fetched archive nullifies the encryption's only non-evasion
 * purpose. Every other shape (out-of-band `$VAR`/placeholder password,
 * uncorrelated CLI usage, or prose-only mention) stays medium (advisory,
 * co-signal-eligible) — never split into a second finding type, per the
 * plan's explicit instruction; severity alone carries the two-tier design,
 * mirroring how scanChmodFetchCompound's own compound signal uses ONE type
 * (privilege_escalation) with severity (not weight) doing the tiering.
 */

import type { SecurityFinding } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
} from './SecurityScanner.helpers.js'
import { safeRegexTest } from './regex-utils.js'
import { looksLikePlaceholderSecret } from './SecurityScanner.pii.js'
import {
  FETCH_COMMAND_PATTERN,
  correlationTargetBasename,
  isCorrelatedWithFetchDestination,
} from './SecurityScanner.fetch-correlation.js'

// ============================================================================
// Sub-signal A: CLI invocation syntax
// ============================================================================

/**
 * Bounded per-tool invocation captures (mirrors CHMOD_TARGET's
 * capture-then-inspect style rather than one large combined alternation —
 * simpler to reason about and to keep ReDoS-safe). The password itself is
 * extracted from the captured (bounded-length) segment via a lightweight
 * follow-up regex, per tool syntax:
 *   - unzip: `-P <password>` (space-separated; real unzip CLI syntax).
 *   - unrar/7z: `-p<password>` (ATTACHED, no space — real unrar/7z CLI
 *     syntax; a bare `-p` with nothing attached means "prompt
 *     interactively," i.e. no inline password at all, so it is correctly
 *     NOT matched by the one-or-more `\S+` capture below).
 *   - zip: `-P <password>` (space-separated) AND the `-e` encrypt flag
 *     present somewhere on the same bounded segment (zip's `-P` only makes
 *     sense alongside `-e`).
 */
const UNZIP_INVOCATION = /\bunzip\b[^\n]{0,200}/i
const UNRAR_INVOCATION = /\bunrar\s+x\b[^\n]{0,200}/i
const SEVENZIP_INVOCATION = /\b7z\s+x\b[^\n]{0,200}/i
const ZIP_INVOCATION = /\bzip\b[^\n]{0,200}/i

const UNZIP_PASSWORD_ARG = /-P\s+(\S{1,200})/
const UNRAR_SEVENZIP_PASSWORD_ARG = /-p(\S{1,200})/i
const ZIP_PASSWORD_ARG = /-P\s+(\S{1,200})/
const ZIP_ENCRYPT_FLAG = /(?:^|\s)-e(?:\s|$)/

/** First archive-extension-bearing token on the line — the CLI's target file. */
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

/**
 * SMI-6033 Wave 3: returns the FULL captured path (quotes stripped), not a
 * bare basename — the shared correlation utility is now directory-aware and
 * must not be handed a path-stripped target.
 */
function extractArchiveTargetPath(line: string): string {
  const m = line.match(ARCHIVE_FILENAME)
  if (!m) return ''
  return m[1].replace(/['"]/g, '')
}

/** `$VAR` / `${VAR}` bare shell-variable reference — an out-of-band password. */
const SHELL_VAR_REF = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/

/**
 * Is `password` an inline LITERAL secret (not a shell-variable reference,
 * not a placeholder/low-entropy example value)? Reuses the same
 * looksLikePlaceholderSecret gate the sensitive_path/PII detectors use — the
 * value has no `key:`/`key=` prefix to strip here (it's a bare CLI
 * argument), which looksLikePlaceholderSecret's internal extraction already
 * tolerates (no `:`/`=` present means the whole string passes through
 * unchanged).
 *
 * SMI-6033 Wave 4 bugfix (found during Wave 4's own verification, fixed here
 * since PR #2371/Wave 3 — the file this bug shipped in — was still open):
 * `\S{1,200}` in UNZIP_PASSWORD_ARG/ZIP_PASSWORD_ARG/UNRAR_SEVENZIP_PASSWORD_ARG
 * captures the CLI argument RAW, quotes included, so a perfectly ordinary,
 * shell-safe out-of-band reference like `unzip -P "$TOOLKIT_PASSWORD" x.zip`
 * arrived here as `"$TOOLKIT_PASSWORD"` (with literal quote characters) —
 * `SHELL_VAR_REF` never matched (it anchors on a bare `$`, not a leading
 * quote), so this fell through to `looksLikePlaceholderSecret`, which also
 * doesn't recognize it, and the whole thing was misclassified as an inline
 * LITERAL secret. Combined with a correlated fetch target, that reached
 * standalone-`critical` on a completely benign shell idiom — a real
 * quarantine-level false positive, confirmed empirically. Strip surrounding
 * quotes first (mirrors `extractArchiveTargetPath`'s own
 * `.replace(/['"]/g, '')` treatment of the same class of CLI capture) so
 * `SHELL_VAR_REF` sees the actual `$VAR` shape underneath.
 */
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

/**
 * Line numbers (1-indexed) where an archive noun co-occurs with a password
 * noun within a bounded ±2-line window (same line or 2 lines either side).
 */
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

export function scanArchiveEvasion(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  const fetchLines = lines.filter((l) => safeRegexTest(FETCH_COMMAND_PATTERN, l) !== null)
  const emittedLines = new Set<number>()

  // Sub-signal A: CLI invocation syntax.
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const cli = findArchiveCliPassword(line)
    if (!cli) return

    const ctx = contexts[index]
    const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, cli.index)
    const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false

    const inlineLiteral = isInlineLiteralPassword(cli.password)
    const targetPath = extractArchiveTargetPath(line)
    const correlated =
      correlationTargetBasename(targetPath).length >= 3 &&
      isCorrelatedWithFetchDestination(targetPath, fetchLines)
    const critical = !inDocContext && inlineLiteral && correlated

    findings.push({
      type: 'archive_evasion',
      severity: inDocContext ? 'low' : critical ? 'critical' : 'medium',
      message: `Password-protected archive CLI usage (${cli.tool}): "${line.trim().slice(0, 100)}"`,
      location: line.trim().slice(0, 100),
      lineNumber,
      category: 'archive_evasion',
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'high',
    })
    emittedLines.add(lineNumber)
  })

  // Sub-signal B: prose co-occurrence — the fuzzy, FP-prone case. NEVER
  // critical (no provenance condition can apply to a bare noun pairing), and
  // capped at 'medium' confidence to reflect the heuristic's own uncertainty.
  for (const lineNumber of findArchivePasswordProseLines(lines)) {
    if (emittedLines.has(lineNumber)) continue // CLI-syntax already emitted for this line
    const ctx = contexts[lineNumber - 1]
    const inDocContext = ctx ? isDocumentationContext(ctx) : false
    findings.push({
      type: 'archive_evasion',
      severity: inDocContext ? 'low' : 'medium',
      message: `Archive and password mentioned in close proximity: "${lines[lineNumber - 1].trim().slice(0, 100)}"`,
      location: lines[lineNumber - 1].trim().slice(0, 100),
      lineNumber,
      category: 'archive_evasion',
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'medium',
    })
  }

  return findings
}
