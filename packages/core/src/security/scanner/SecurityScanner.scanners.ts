/**
 * Security Scanner — per-line category scanners
 * @module @skillsmith/core/security/scanner/SecurityScanner.scanners
 *
 * SMI-5359 Wave 4.2: extracted verbatim from SecurityScanner.ts to keep that
 * file under the 500-line CI gate before adding the code_execution and
 * obfuscated_directive detectors. These are pure functions of
 * (content, lineContexts) plus their module-level pattern arrays — they hold
 * no scanner instance state (no allowedDomains / blockedPatterns), so moving
 * them out is behaviour-preserving (guarded by the scoring + regression-guard
 * + ai-defence test suites).
 */

import type { SecurityFinding, FindingConfidence } from './types.js'
import {
  SENSITIVE_PATH_PATTERNS,
  ENV_PATH_PATTERN,
  VALUE_GATED_KEYWORD_PATTERNS,
  SOCIAL_ENGINEERING_PATTERNS,
  PROMPT_LEAKING_PATTERNS,
  DATA_EXFILTRATION_PATTERNS,
  PRIVILEGE_ESCALATION_PATTERNS,
  PII_PATTERNS,
} from './patterns.js'
import { safeRegexTest, safeRegexCheck } from './regex-utils.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
} from './SecurityScanner.helpers.js'

/**
 * SMI-5359 Wave 4 (MF-2): a `.env` reference is an active read/exfiltration only when
 * it co-occurs with a read/copy/transfer verb or a shell pipe/redirect on the same line
 * (`cat .env | curl …`, `cp .env /tmp`, `source .env`). A lone reference
 * (`see the .env file`) stays MEDIUM so it can't single-handedly trip the Gate-A
 * high/critical short-circuit. Bounded alternation + single-char class → ReDoS-safe.
 */
const ENV_EXFIL_CONTEXT =
  /\b(?:cat|cp|mv|scp|rsync|source|curl|wget|fetch|less|more|head|tail|tee|upload|tar|zip|gzip|base64|xxd|dd|nc|netcat)\b|[|>]/i

/**
 * SMI-5359 Wave 4 (MF-1): a bare api_key/auth_token keyword is a credential leak only
 * when the line ASSIGNS a value to it. The full match is handed to
 * looksLikePlaceholderSecret, which strips the `<key>=`/`<key>:` prefix and rejects
 * named placeholders, single-repeated-char, and sub-entropy values — so
 * `export API_KEY=$1`, `apiKey: <YOUR_KEY>`, and `auth_token: YOUR_TOKEN_HERE` are
 * suppressed while a real `apiKey = "sk_live_…"` still scores HIGH. Bounded, single
 * `.+` quantifier → ReDoS-safe.
 */
const CREDENTIAL_ASSIGNMENT = /(?:api[_-]?key|apikey|auth[_-]?token|authtoken)\s*[:=]\s*.+$/i

export function scanSensitivePaths(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  lines.forEach((line, index) => {
    const ctx = contexts[index]

    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      if (!safeRegexCheck(pattern, line)) continue
      const match = safeRegexTest(pattern, line)
      const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match?.index ?? 0)
      const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false

      // MF-1: value-gate the bare credential keywords. A bare/placeholder mention is
      // suppressed — keep scanning later patterns rather than emitting. The real-secret
      // leak still surfaces at PII; the `$VAR`-in-curl exfil at DATA_EXFILTRATION.
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
        severity = safeRegexCheck(ENV_EXFIL_CONTEXT, line) ? 'high' : 'medium'
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
        location: line.trim().slice(0, 100),
        lineNumber: index + 1,
        inDocumentationContext: inDocContext,
        confidence,
      })
      break
    }
  })

  return findings
}

export function scanSocialEngineering(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  lines.forEach((line, index) => {
    const ctx = contexts[index]

    for (const pattern of SOCIAL_ENGINEERING_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
        const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
        const severity = inDocContext ? 'medium' : 'high'

        findings.push({
          type: 'social_engineering',
          severity,
          message: `Social engineering attempt detected: "${match[0]}"`,
          location: line.trim().slice(0, 100),
          lineNumber: index + 1,
          category: 'social_engineering',
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  })

  return findings
}

export function scanPromptLeaking(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  lines.forEach((line, index) => {
    const ctx = contexts[index]

    for (const pattern of PROMPT_LEAKING_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
        const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
        const severity = inDocContext ? 'high' : 'critical'

        findings.push({
          type: 'prompt_leaking',
          severity,
          message: `Prompt leaking attempt detected: "${match[0]}"`,
          location: line.trim().slice(0, 100),
          lineNumber: index + 1,
          category: 'prompt_leaking',
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  })

  return findings
}

export function scanDataExfiltration(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  lines.forEach((line, index) => {
    const ctx = contexts[index]

    for (const pattern of DATA_EXFILTRATION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
        const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
        const severity = inDocContext ? 'medium' : 'high'

        findings.push({
          type: 'data_exfiltration',
          severity,
          message: `Potential data exfiltration pattern: "${match[0]}"`,
          location: line.trim().slice(0, 100),
          lineNumber: index + 1,
          category: 'data_exfiltration',
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  })

  return findings
}

export function scanPrivilegeEscalation(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  lines.forEach((line, index) => {
    const ctx = contexts[index]

    for (const pattern of PRIVILEGE_ESCALATION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
        const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
        const severity = inDocContext ? 'high' : 'critical'

        findings.push({
          type: 'privilege_escalation',
          severity,
          message: `Privilege escalation pattern detected: "${match[0]}"`,
          location: line.trim().slice(0, 100),
          lineNumber: index + 1,
          category: 'privilege_escalation',
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  })

  return findings
}

/**
 * SMI-5424 PR2: owner-permission chmod is a COMPOUND signal, not standalone.
 * `chmod 755 ./bin/cli` / `chmod 600 .env` / `chmod +x build.sh` are benign
 * idioms that previously false-fired privilege_escalation:critical. Owner-perm
 * chmod now emits ONLY when co-located (±1 line) with a fetch/download verb —
 * the "download a payload, chmod it, run it" supply-chain shape — which both
 * kills the standalone FP and PRESERVES the chmod co-signal that
 * escalateCodeExecution requires (it only accepts high/critical non-doc
 * co-signals, so the chmod cannot simply be downgraded). World-writable and
 * setuid/setgid chmod remain standalone-critical in PRIVILEGE_ESCALATION_PATTERNS;
 * `alreadyFlaggedLines` skips those so we never double-emit on one line.
 */
const OWNER_PERM_CHMOD = /\bchmod\s+(?:[0-7]{3,4}|[ugoa]*\+x)\b/i
const CHMOD_FETCH_CONTEXT =
  /\b(?:curl|wget|fetch|downloads?|downloaded|npx)\b|https?:\/\/|\bgit\s+clone\b/i

export function scanChmodFetchCompound(
  content: string,
  alreadyFlaggedLines: ReadonlySet<number>,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    // World-writable / setuid already emitted critical for this line — skip.
    if (alreadyFlaggedLines.has(lineNumber)) return
    const match = safeRegexTest(OWNER_PERM_CHMOD, line)
    if (!match) return
    // Bounded ±1-line window for the download-then-chmod adjacency.
    const window = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join('\n')
    if (!CHMOD_FETCH_CONTEXT.test(window)) return // benign standalone chmod — no finding

    const ctx = contexts[index]
    const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
    const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
    findings.push({
      type: 'privilege_escalation',
      // HIGH (not critical): enough to trip Gate-A AND serve as an
      // escalateCodeExecution co-signal, without re-introducing a critical FP.
      severity: inDocContext ? 'low' : 'high',
      message: `chmod of a fetched/downloaded file (compound with a download verb): "${match[0]}"`,
      location: line.trim().slice(0, 100),
      lineNumber,
      category: 'privilege_escalation',
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'high',
    })
  })

  return findings
}

/**
 * SMI-5420: credential PII pattern indices (api/secret/access key, provider
 * tokens, password) whose matched VALUE can be a documentation placeholder.
 * Excludes email (7), SSN (8), and the private-key marker (9) — those have no
 * placeholder-secret failure mode.
 */
const CREDENTIAL_PII_INDICES = new Set([0, 1, 2, 3, 4, 5, 6, 10])

/**
 * SMI-5420: named-placeholder markers that indicate an example, not a real
 * secret. Intentionally NO `X{4,}` rule — it would test the raw match string and
 * short-circuit before the entropy check, downgrading a REAL high-entropy secret
 * that coincidentally contains `xxxx` (governance FN). An all-repeated-char value
 * (e.g. `xxxx…`) is caught by the `/^(.)\1+$/` check in looksLikePlaceholderSecret
 * instead, and partial-repeat low-variety values by the entropy floor.
 *
 * SMI-5423: the SHORT markers (FAKE/DUMMY/SAMPLE/YOUR, ≤6 chars) are guarded with
 * a negative lookbehind `(?<![A-Za-z0-9])` so they only match as a delimited token
 * (`FAKE_KEY`, `<FAKE>`, value-start) — NOT mid-random-string (`k7FAKE1abc`), which
 * is the same raw-match short-circuit FN class as the removed `X{4,}`. Longer
 * markers (EXAMPLE/PLACEHOLDER/CHANGEME/REDACTED, 7+ chars) stay unbounded: their
 * coincidence probability is negligible AND `AKIA…7EXAMPLE` needs EXAMPLE to match
 * mid-token.
 *
 * Accepted tradeoff (SMI-5423 governance): a digit-immediately-prefixed token like
 * `1FAKE_KEY` fails the lookbehind and scores critical rather than low. This is the
 * FP-SAFE direction (over-flag a rare contrived placeholder) — strictly preferable
 * in a security scanner to the FN it replaces (a real secret downgraded); and a
 * longer such value falls under the entropy floor anyway.
 */
const PLACEHOLDER_SECRET_RE =
  /EXAMPLE|(?<![A-Za-z0-9])YOUR[_-]?|PLACEHOLDER|CHANGE[_-]?ME|(?<![A-Za-z0-9])DUMMY|(?<![A-Za-z0-9])FAKE|(?<![A-Za-z0-9])SAMPLE|REDACTED|INSERT[_-]|\.\.\.|<[^>]+>/i

/** SMI-5420: minimum Shannon entropy (bits/char) for a value to read as a real secret. */
const SECRET_ENTROPY_FLOOR = 3.0

/** SMI-5420: Shannon entropy (bits per character) of a string. */
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

/**
 * SMI-5420: extract the secret token from a credential match by stripping a
 * leading `<key>:`/`<key>=` assignment prefix and surrounding quotes.
 */
function extractSecretValue(match: string): string {
  return match
    .replace(/^[^:=]*[:=]\s*/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim()
}

/**
 * SMI-5420: a credential match is a documentation placeholder (not a real leaked
 * secret) when it carries a named placeholder marker, is a single repeated
 * character, or its value has sub-secret Shannon entropy. Such matches must NOT
 * emit critical/high severity — the batch trust-scorer (trust-scorer.ts) and the
 * install gate quarantine on severity, so an example secret would falsely flag.
 */
export function looksLikePlaceholderSecret(match: string): boolean {
  if (PLACEHOLDER_SECRET_RE.test(match)) return true
  const value = extractSecretValue(match)
  if (value.length === 0) return false
  if (/^(.)\1+$/.test(value)) return true
  return shannonEntropy(value) < SECRET_ENTROPY_FLOOR
}

/** SMI-3864: Detect PII patterns. Email in YAML frontmatter gets low severity. */
export function scanPiiPatterns(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  let frontmatterEnd = -1
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        frontmatterEnd = i
        break
      }
    }
  }
  const emailPatternIndex = 7
  lines.forEach((line, index) => {
    const ctx = contexts[index]
    const inFrontmatter = index > 0 && index < frontmatterEnd
    for (let pi = 0; pi < PII_PATTERNS.length; pi++) {
      const pattern = PII_PATTERNS[pi]
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
        const isEmailPattern = pi === emailPatternIndex
        const isAuthorLine = /^\s*(?:author|contact|support|email)\s*:/i.test(line)
        const inEmailSafeContext = isEmailPattern && (inFrontmatter || isAuthorLine)
        let severity: 'low' | 'medium' | 'high' | 'critical'
        if (inEmailSafeContext) severity = 'low'
        else if (inDocContext) severity = 'medium'
        else if (pi <= 2 || pi === 9) severity = 'critical'
        else severity = 'high'
        let confidence: FindingConfidence = inDocContext || inEmailSafeContext ? 'low' : 'high'
        // SMI-5420: a credential match that reads as a documentation placeholder
        // (named placeholder, repeated char, or low entropy) must not emit
        // critical/high — the batch trust-scorer quarantines on severity, so an
        // example secret like `api_key: "YOUR_API_KEY_HERE"` would falsely flag.
        if (CREDENTIAL_PII_INDICES.has(pi) && looksLikePlaceholderSecret(match[0])) {
          severity = 'low'
          confidence = 'low'
        }
        findings.push({
          type: 'pii',
          severity,
          message: `PII detected: ${match[0].slice(0, 40)}${match[0].length > 40 ? '...' : ''}`,
          location: line.trim().slice(0, 100),
          lineNumber: index + 1,
          category: 'pii',
          inDocumentationContext: inDocContext || inEmailSafeContext,
          confidence,
        })
        break
      }
    }
  })
  return findings
}
