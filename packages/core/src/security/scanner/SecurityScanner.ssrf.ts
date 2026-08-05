/**
 * SSRF Pattern Scanning - SMI-3509
 *
 * Detects SSRF instructions in skill content.
 * Extracted from SecurityScanner to keep file sizes under 500 lines.
 */

import type { SecurityFinding, FindingConfidence } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
} from './SecurityScanner.helpers.js'
import { SSRF_INSTRUCTION_PATTERNS } from './patterns.js'
import { resolvePatternScope } from './patterns.scope.js'
import { safeRegexTest } from './regex-utils.js'

/**
 * Scan content for SSRF instruction patterns.
 * Uses documentation context to reduce severity for patterns in code blocks/tables.
 * SMI-3522: Supports multi-line patterns via scanPatternsWithMultilineSupport approach.
 *
 * SMI-5881: uses PATTERN_SCOPE (patterns.scope.ts) instead of the old
 * per-source-text multiline-detection heuristic. This function's older
 * skip-based two-pass (flaggedLines) can only correctly service
 * 'line' | 'content' scope, never 'both' — assertScopeCoverage()
 * (patterns.scope.ts) enforces at module-load time that no
 * SSRF_INSTRUCTION_PATTERNS member is ever scoped 'both'.
 */
export function scanSsrfPatterns(
  content: string,
  lineContexts?: LineContext[],
  /** SMI-5881: explicit cap (UTF-16 code units) for the pass-1 full-content
   * regex scan — see scanPatternsWithMultilineSupport's identical parameter. */
  maxLength?: number
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  const flaggedLines = new Set<number>()

  // SMI-3522: First pass — 'content'-scope SSRF patterns against full content
  for (const pattern of SSRF_INSTRUCTION_PATTERNS) {
    if (resolvePatternScope(pattern) === 'line') continue
    const match = safeRegexTest(pattern, content, maxLength)
    if (match) {
      const matchIndex = content.indexOf(match[0])
      const lineNumber = content.slice(0, matchIndex).split('\n').length
      const ctx = contexts[lineNumber - 1]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false
      const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
      const severity = inDocContext ? 'medium' : 'high'
      const truncated = match[0].slice(0, 50)

      findings.push({
        type: 'ssrf',
        severity,
        message: `SSRF instruction pattern detected: "${truncated}${match[0].length > 50 ? '...' : ''}"`,
        location: match[0].trim().slice(0, 100),
        lineNumber,
        category: 'ssrf',
        inDocumentationContext: inDocContext,
        confidence,
      })
      flaggedLines.add(lineNumber)
    }
  }

  // Second pass — 'line'-scope SSRF patterns, per-line
  lines.forEach((line, index) => {
    if (flaggedLines.has(index + 1)) return
    const ctx = contexts[index]

    for (const pattern of SSRF_INSTRUCTION_PATTERNS) {
      if (resolvePatternScope(pattern) === 'content') continue
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
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
