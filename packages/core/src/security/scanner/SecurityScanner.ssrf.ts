/**
 * SSRF Pattern Scanning - SMI-3509
 *
 * Detects SSRF instructions in skill content.
 * Extracted from SecurityScanner to keep file sizes under 500 lines.
 */

import type { SecurityFinding, FindingConfidence } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import { analyzeMarkdownContext, isDocumentationContext } from './SecurityScanner.helpers.js'
import { SSRF_INSTRUCTION_PATTERNS } from './patterns.js'
import { safeRegexTest } from './regex-utils.js'

/**
 * Scan content for SSRF instruction patterns.
 * Uses documentation context to reduce severity for patterns in code blocks/tables.
 */
export function scanSsrfPatterns(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  lines.forEach((line, index) => {
    const ctx = contexts[index]
    const inDocContext = ctx ? isDocumentationContext(ctx) : false

    for (const pattern of SSRF_INSTRUCTION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
        const severity = inDocContext ? 'medium' : 'high'

        findings.push({
          type: 'ssrf',
          severity,
          message: `SSRF instruction pattern detected: "${match[0]}"`,
          location: line.trim().slice(0, 100),
          lineNumber: index + 1,
          category: 'ssrf',
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  })

  return findings
}
