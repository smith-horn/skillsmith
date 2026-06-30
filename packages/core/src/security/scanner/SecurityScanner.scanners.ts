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
} from './patterns.js'
import { safeRegexTest, safeRegexCheck } from './regex-utils.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
} from './SecurityScanner.helpers.js'
import {
  looksLikePlaceholderSecret,
  shannonEntropy,
  scanPiiPatterns,
} from './SecurityScanner.pii.js'

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

/** Implementation in SecurityScanner.compound.ts (SMI-5434 split). */
export { scanChmodFetchCompound } from './SecurityScanner.compound.js'
/** Implementation in SecurityScanner.pii.ts (SMI-5434 split). */
export { shannonEntropy, looksLikePlaceholderSecret, scanPiiPatterns }
