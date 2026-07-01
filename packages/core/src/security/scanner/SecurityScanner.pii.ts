/**
 * Security Scanner — PII pattern scanning + entropy / placeholder filtering
 * @module @skillsmith/core/security/scanner/SecurityScanner.pii
 *
 * SMI-5434: Section 3 of SecurityScanner.scanners.ts extracted to keep the
 * parent file under the 500-line audit:standards gate. Pure functions of
 * (content, lineContexts) — no scanner instance state.
 */

import type { SecurityFinding, FindingConfidence } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
} from './SecurityScanner.helpers.js'
import { safeRegexTest } from './regex-utils.js'
import { PII_PATTERNS } from './patterns.js'

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

/**
 * SMI-5420: minimum Shannon entropy (bits/char) for a value to read as a real secret.
 * SMI-5424 PR2 (accepted tradeoff): a hardcoded credential value shorter than ~8 chars
 * cannot reach 3.0 bits/char (its max entropy is log2(len) < 3.0), so it falls below
 * this floor and is treated as a placeholder by design — a sub-8-char literal is not a
 * credible credential, and the 20+char PII_PATTERNS rule is the real-credential detector.
 */
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
