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
      if (safeRegexCheck(pattern, line)) {
        const match = safeRegexTest(pattern, line)
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match?.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
        const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
        const severity = inDocContext ? 'medium' : 'high'

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
        const confidence: FindingConfidence = inDocContext || inEmailSafeContext ? 'low' : 'high'
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
