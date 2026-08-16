/**
 * SMI-6033 Wave 1: Edge sensitive-path detector
 * @module scripts/indexer/_shared/security-scanner-edge.paths (Node port)
 *
 * Port of @skillsmith/core SecurityScanner.scanners.ts's `scanSensitivePaths`
 * (patterns + the looksLikePlaceholderSecret/shannonEntropy helpers, both
 * from SecurityScanner.pii.ts) — previously edge had NO `sensitive_path`
 * type, detector, weight, or coefficient at all, so a `.env`-read or
 * credential-path signal that scores on core never scored on the prod edge
 * quarantine gate. Byte-identical body across both _shared twins (parity
 * test enforces); only the @module header line above differs. Pure Deno/Web
 * APIs, no Node deps.
 *
 * Preserves core's two false-positive gates exactly:
 *   MF-1: a bare `api_key`/`auth_token` keyword mention is suppressed unless
 *     the line ASSIGNS a real (non-placeholder, sufficiently-entropic) value.
 *   MF-2: a lone `.env` mention stays MEDIUM; it only grades HIGH when it
 *     co-occurs with a read/exfil verb or a shell pipe/redirect on the same line.
 */

import type {
  SecurityFinding,
  FindingConfidence,
  LineContext,
} from './security-scanner-edge.context.ts'
import { isDocumentationContext, isWithinInlineCode } from './security-scanner-edge.context.ts'

// ReDoS protection: maximum line length for regex matching (mirrors scanner).
const MAX_LINE_LENGTH = 10000

function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}

// ============================================================================
// Patterns (ported from packages/core/src/security/scanner/patterns.ts)
// ============================================================================

// MF-2: `.env` as a real env-file reference. Excludes `.envrc` (direnv config) and the
// committed placeholder family (.env.example/.sample/.template/.schema/.dist). The
// `(?![A-Za-z])` guard also drops the `.environment`/`.envision` English-word FP while
// still matching real variants like `.env`, `.env.local`, `.env.production`.
export const ENV_PATH_PATTERN = /\.env(?![A-Za-z])(?!\.(?:example|sample|template|schema|dist))/i

// MF-1: bare credential keywords — value-gated below, never standalone HIGH.
const API_KEY_KEYWORD = /api[_-]?key/i
const AUTH_TOKEN_KEYWORD = /auth[_-]?token/i

export const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  ENV_PATH_PATTERN,
  // Contextual credentials: filename or assignment, not bare prose
  /credentials\.(?:json|ya?ml|env|toml|txt)/i,
  /credentials\s*[:=]/i,
  // Contextual secrets: assignment or path, not bare word
  /\bsecrets?\s*[:=]/i,
  /\bsecrets?\/[a-z0-9_.-]+/i,
  /\.pem$/i,
  /\.key$/i,
  /\.crt$/i,
  // Contextual password: assignment or URL (postgres://user:pass@host) only
  /password\s*[:=]/i,
  API_KEY_KEYWORD,
  AUTH_TOKEN_KEYWORD,
  /~\/\.ssh/i,
  /~\/\.aws/i,
  /~\/\.config/i,
  /\/etc\/(?:passwd|shadow|sudoers|hosts)\b/i,
]

// MF-1: the two bare-keyword patterns above emit HIGH only when accompanied by a real
// assigned secret value; scanSensitivePaths suppresses an otherwise-bare match.
export const VALUE_GATED_KEYWORD_PATTERNS: ReadonlySet<RegExp> = new Set([
  API_KEY_KEYWORD,
  AUTH_TOKEN_KEYWORD,
])

// MF-2: a `.env` reference is an active read/exfiltration only when it co-occurs with a
// read/copy/transfer verb or a shell pipe/redirect on the same line (`cat .env | curl …`,
// `cp .env /tmp`, `source .env`). A lone reference (`see the .env file`) stays MEDIUM.
const ENV_EXFIL_CONTEXT =
  /\b(?:cat|cp|mv|scp|rsync|source|curl|wget|fetch|less|more|head|tail|tee|upload|tar|zip|gzip|base64|xxd|dd|nc|netcat)\b|[|>]/i

// MF-1: a bare api_key/auth_token keyword is a credential leak only when the line
// ASSIGNS a value to it. The full match is handed to looksLikePlaceholderSecret.
const CREDENTIAL_ASSIGNMENT = /(?:api[_-]?key|apikey|auth[_-]?token|authtoken)\s*[:=]\s*.+$/i

// ============================================================================
// Helpers (ported from packages/core/src/security/scanner/SecurityScanner.pii.ts)
// ============================================================================

/**
 * Named-placeholder markers that indicate an example, not a real secret. The
 * short markers (FAKE/DUMMY/SAMPLE/YOUR, <=6 chars) are guarded with a
 * negative lookbehind so they only match as a delimited token, not
 * mid-random-string.
 */
const PLACEHOLDER_SECRET_RE =
  /EXAMPLE|(?<![A-Za-z0-9])YOUR[_-]?|PLACEHOLDER|CHANGE[_-]?ME|(?<![A-Za-z0-9])DUMMY|(?<![A-Za-z0-9])FAKE|(?<![A-Za-z0-9])SAMPLE|REDACTED|INSERT[_-]|\.\.\.|<[^>]+>/i

/** Minimum Shannon entropy (bits/char) for a value to read as a real secret. */
const SECRET_ENTROPY_FLOOR = 3.0

/** Shannon entropy (bits per character) of a string. */
export function shannonEntropy(s: string): number {
  if (!s) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of freq.values()) {
    const p = c / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** Extract the secret token from a credential match by stripping a leading `<key>:`/`<key>=` prefix and surrounding quotes. */
function extractSecretValue(match: string): string {
  return match
    .replace(/^[^:=]*[:=]\s*/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim()
}

/**
 * A credential match is a documentation placeholder (not a real leaked
 * secret) when it carries a named placeholder marker, is a single repeated
 * character, or its value has sub-secret Shannon entropy.
 */
export function looksLikePlaceholderSecret(match: string): boolean {
  if (PLACEHOLDER_SECRET_RE.test(match)) return true
  const value = extractSecretValue(match)
  if (value.length === 0) return false
  if (/^(.)\1+$/.test(value)) return true
  return shannonEntropy(value) < SECRET_ENTROPY_FLOOR
}

// ============================================================================
// Detector
// ============================================================================

/**
 * sensitive_path: reference to a credential file/path/env-var. MF-1 value-gates
 * the bare api_key/auth_token keywords; MF-2 grades a lone `.env` mention MEDIUM
 * and only HIGH when co-located with a read/exfil verb or shell pipe/redirect.
 */
export function scanSensitivePaths(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    const ctx = contexts[index]

    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (!match) continue
      const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
      const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false

      // MF-1: value-gate the bare credential keywords. A bare/placeholder mention is
      // suppressed — keep scanning later patterns rather than emitting.
      if (VALUE_GATED_KEYWORD_PATTERNS.has(pattern)) {
        const assign = safeRegexTest(CREDENTIAL_ASSIGNMENT, line)
        if (!assign || looksLikePlaceholderSecret(assign[0])) continue
      }

      // MF-2: lone `.env` → MEDIUM; `.env` + read/exfil verb or pipe/redirect → HIGH.
      // Doc-context keeps the existing MEDIUM downgrade for every pattern.
      let severity: SecurityFinding['severity']
      if (inDocContext) {
        severity = 'medium'
      } else if (pattern === ENV_PATH_PATTERN) {
        severity = safeRegexTest(ENV_EXFIL_CONTEXT, line) !== null ? 'high' : 'medium'
      } else {
        severity = 'high'
      }
      const confidence: FindingConfidence = inDocContext
        ? 'low'
        : severity === 'high'
          ? 'high'
          : 'medium'

      findings.push({
        type: 'sensitive_path',
        severity,
        message: `Reference to potentially sensitive path: ${pattern.source}`,
        lineNumber: index + 1,
        location: line.trim().slice(0, 100),
        inDocumentationContext: inDocContext,
        confidence,
      })
      break
    }
  }

  return findings
}
