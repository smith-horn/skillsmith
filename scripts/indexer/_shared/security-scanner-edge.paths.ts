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
 * Preserves core's four false-positive gates exactly:
 *   MF-1: a bare `api_key`/`auth_token` keyword mention is suppressed unless
 *     the line ASSIGNS a real (non-placeholder, sufficiently-entropic) value.
 *   MF-2: a lone `.env` mention stays MEDIUM; it only grades HIGH when it
 *     co-occurs with a read/exfil verb or a shell pipe/redirect on the same line.
 *   MF-3 (SMI-5207): the 9 path-form patterns → HIGH only with an action verb
 *     or shell operator within +/-1 line, negation-aware; otherwise MEDIUM —
 *     a bare path mention is the common case, so evidence is required to
 *     escalate. Round 10 added two further disqualifiers (a determiner
 *     forcing the noun reading, and detection-framing + relative-clause
 *     description) — see security-scanner-edge.action-context.ts.
 *   MF-4 (SMI-5207): the 3 keyword-assignment patterns → HIGH BY DEFAULT (a
 *     `keyword: value` credential shape is rare in innocent prose),
 *     downgraded to MEDIUM only on positive prose evidence about the value —
 *     SEGMENTED PER ASSIGNMENT KEY (round 8), not a single whole-line span;
 *     see security-scanner-edge.value-gate.ts.
 *
 * SMI-5207: NEGATION_TOKENS/NOUN_DETERMINERS/DETECTION_FRAMING/
 * RELATIVE_MARKERS/PROSE_STOPWORDS live in the security-scanner-edge.prose-
 * lexicon.ts sibling twin; MF-3's action-context gate lives in security-
 * scanner-edge.action-context.ts; MF-4's value classification lives in
 * security-scanner-edge.value-gate.ts (all three 500-line pre-commit gate
 * splits; mirrors core's identical SecurityScanner.prose-lexicon.ts /
 * SecurityScanner.action-context.ts / SecurityScanner.value-gate.ts split).
 */

import type {
  SecurityFinding,
  FindingConfidence,
  LineContext,
} from './security-scanner-edge.context.ts'
import { isDocumentationContext, isWithinInlineCode } from './security-scanner-edge.context.ts'
// SMI-5207: MF-3's action-context gate, split out for the 500-line
// pre-commit gate. Mirrors core's identical SecurityScanner.action-context.ts
// split (which itself mirrors THIS twin's own earlier lexicon split).
import { hasPathActionContext } from './security-scanner-edge.action-context.ts'
// SMI-5207 (round 8): MF-4's per-assignment-segmented value gate, split out
// for the 500-line pre-commit gate. Mirrors core's identical
// SecurityScanner.value-gate.ts split.
import { assignmentHasRealValue } from './security-scanner-edge.value-gate.ts'

// ReDoS protection: maximum line length for regex matching (mirrors scanner).
const MAX_LINE_LENGTH = 10000

function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}

// ============================================================================
// Patterns (ported from packages/core/src/security/scanner/patterns.sensitive-path.ts)
// ============================================================================

// MF-2: `.env` as a real env-file reference. Excludes `.envrc` (direnv config) and the
// committed placeholder family (.env.example/.sample/.template/.schema/.dist). The
// `(?![A-Za-z])` guard also drops the `.environment`/`.envision` English-word FP while
// still matching real variants like `.env`, `.env.local`, `.env.production`.
export const ENV_PATH_PATTERN = /\.env(?![A-Za-z])(?!\.(?:example|sample|template|schema|dist))/i

// MF-1: bare credential keywords — value-gated below, never standalone HIGH.
const API_KEY_KEYWORD = /api[_-]?key/i
const AUTH_TOKEN_KEYWORD = /auth[_-]?token/i

// SMI-5207: the 12 non-`.env` entries are hoisted to named consts so
// scanSensitivePaths can classify each by severity gate BY REFERENCE — same
// convention as core's patterns.sensitive-path.ts.
const CREDENTIALS_FILE_PATTERN = /credentials\.(?:json|ya?ml|env|toml|txt)/i
const CREDENTIALS_ASSIGN_PATTERN = /credentials\s*[:=]/i
const SECRETS_ASSIGN_PATTERN = /\bsecrets?\s*[:=]/i
const SECRETS_PATH_PATTERN = /\bsecrets?\/[a-z0-9_.-]+/i
const PEM_PATTERN = /\.pem$/i
const KEY_FILE_PATTERN = /\.key$/i
const CRT_PATTERN = /\.crt$/i
const PASSWORD_ASSIGN_PATTERN = /password\s*[:=]/i
const SSH_DIR_PATTERN = /~\/\.ssh/i
const AWS_DIR_PATTERN = /~\/\.aws/i
const CONFIG_DIR_PATTERN = /~\/\.config/i
const ETC_SYSTEM_FILE_PATTERN = /\/etc\/(?:passwd|shadow|sudoers|hosts)\b/i

export const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  ENV_PATH_PATTERN,
  CREDENTIALS_FILE_PATTERN,
  CREDENTIALS_ASSIGN_PATTERN,
  SECRETS_ASSIGN_PATTERN,
  SECRETS_PATH_PATTERN,
  PEM_PATTERN,
  KEY_FILE_PATTERN,
  CRT_PATTERN,
  PASSWORD_ASSIGN_PATTERN,
  API_KEY_KEYWORD,
  AUTH_TOKEN_KEYWORD,
  SSH_DIR_PATTERN,
  AWS_DIR_PATTERN,
  CONFIG_DIR_PATTERN,
  ETC_SYSTEM_FILE_PATTERN,
]

// MF-1: the two bare-keyword patterns above emit HIGH only when accompanied by a real
// assigned secret value; scanSensitivePaths suppresses an otherwise-bare match.
export const VALUE_GATED_KEYWORD_PATTERNS: ReadonlySet<RegExp> = new Set([
  API_KEY_KEYWORD,
  AUTH_TOKEN_KEYWORD,
])

/**
 * SMI-5207 (MF-3): the 9 path/filename-form entries. HIGH only when an action
 * verb or shell operator appears within +/-1 line of the match; otherwise
 * MEDIUM — a bare path mention is the common case, so evidence is required to
 * escalate. See hasPathActionContext() below.
 */
export const PATH_FORM_PATTERNS: ReadonlySet<RegExp> = new Set([
  CREDENTIALS_FILE_PATTERN,
  SECRETS_PATH_PATTERN,
  PEM_PATTERN,
  KEY_FILE_PATTERN,
  CRT_PATTERN,
  SSH_DIR_PATTERN,
  AWS_DIR_PATTERN,
  CONFIG_DIR_PATTERN,
  ETC_SYSTEM_FILE_PATTERN,
])

/**
 * SMI-5207 (MF-4): the 3 keyword-assignment entries. HIGH BY DEFAULT —
 * `keyword: value` is a syntactic credential-assignment shape, rare in
 * innocent prose — downgraded to MEDIUM only on positive prose evidence about
 * the assigned value. See assignmentHasRealValue() below.
 *
 * Partition check: 1 (ENV) + 9 (PATH_FORM) + 3 (ASSIGNMENT) + 2
 * (VALUE_GATED_KEYWORD) = 15, total and disjoint. An unclassified future
 * pattern falls through to scanSensitivePaths' fail-CLOSED `else` branch and
 * stays HIGH.
 */
export const VALUE_GATED_ASSIGNMENT_PATTERNS: ReadonlySet<RegExp> = new Set([
  CREDENTIALS_ASSIGN_PATTERN,
  SECRETS_ASSIGN_PATTERN,
  PASSWORD_ASSIGN_PATTERN,
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
 *
 * SMI-5207: exported (additively) so security-scanner-edge.value-gate.ts's
 * MF-4 isProseValue() can share the same placeholder vocabulary — mirrors
 * core's PLACEHOLDER_SECRET_RE export from SecurityScanner.pii.ts.
 */
export const PLACEHOLDER_SECRET_RE =
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
// MF-3 / MF-4 action-context + value gates (SMI-5207)
// ============================================================================

// MF-3 (SMI-5207, round 10): the path-form action-context gate — ACTION_VERBS,
// SHELL_OPERATOR, the negation lookaround, the round-10 determiner and
// detection-framing+relative-clause disqualifiers, and hasPathActionContext()
// (imported above) all live in security-scanner-edge.action-context.ts, split
// out purely for the 500-line pre-commit gate. Mirrors core's identical
// SecurityScanner.action-context.ts split.

// MF-4 (SMI-5207, round 8): the assignment-form value gate — TEMPLATE_REFERENCE,
// MAX_LABEL_TOKENS, isProseValue(), and assignmentHasRealValue() (now SEGMENTED
// PER ASSIGNMENT KEY rather than a single whole-line span — round 8 found the
// single-span shape leaks a DIFFERENT assignment's prose into a real
// credential's classification in three directions on a line carrying two
// gated keys) all live in security-scanner-edge.value-gate.ts (imported
// above), split out purely for the 500-line pre-commit gate. Mirrors core's
// identical SecurityScanner.value-gate.ts split.

// ============================================================================
// Detector
// ============================================================================

/**
 * sensitive_path: reference to a credential file/path/env-var. MF-1
 * value-gates the bare api_key/auth_token keywords; MF-2 grades a lone
 * `.env` mention MEDIUM and only HIGH when co-located with a read/exfil verb
 * or shell pipe/redirect. MF-3 (SMI-5207) grades the 9 path-form patterns
 * HIGH only with an action verb or shell operator within +/-1 line; MF-4
 * grades the 3 assignment-form patterns HIGH by default, downgraded only on
 * positive prose evidence about the assigned value.
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
      // MF-3 (SMI-5207): a path-form match → HIGH only with an action verb or shell
      // operator within +/-1 line; a bare path MENTION is the common case, so evidence
      // is required to escalate.
      // MF-4 (SMI-5207): an assignment-form match → HIGH by DEFAULT (a `keyword: value`
      // credential shape is rare in innocent prose), downgraded only on positive prose
      // evidence about the assigned value.
      // Doc-context keeps the existing MEDIUM downgrade for every pattern.
      let severity: SecurityFinding['severity']
      if (inDocContext) {
        severity = 'medium'
      } else if (pattern === ENV_PATH_PATTERN) {
        severity = safeRegexTest(ENV_EXFIL_CONTEXT, line) !== null ? 'high' : 'medium'
      } else if (PATH_FORM_PATTERNS.has(pattern)) {
        severity = hasPathActionContext(lines, index) ? 'high' : 'medium'
      } else if (VALUE_GATED_ASSIGNMENT_PATTERNS.has(pattern)) {
        severity = assignmentHasRealValue(lines, index) ? 'high' : 'medium'
      } else {
        severity = 'high' // MF-1 survivors and any future unclassified pattern — fail CLOSED
      }
      const confidence: FindingConfidence = inDocContext
        ? 'low'
        : severity === 'high'
          ? 'high'
          : 'medium'

      findings.push({
        type: 'sensitive_path',
        severity,
        // SMI-5207: the matched TEXT is prepended additively — `pattern.source` is
        // deliberately retained, not swapped out.
        message: `Reference to potentially sensitive path: "${match[0].slice(0, 60)}" (${pattern.source})`,
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
