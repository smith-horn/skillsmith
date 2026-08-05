/**
 * Security Scanner Helper Functions
 * @module @skillsmith/core/security/scanner/SecurityScanner.helpers
 */

import type {
  SecurityFinding,
  SecurityFindingType,
  RiskScoreBreakdown,
  FindingConfidence,
  EvidenceType,
} from './types.js'
import { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from './weights.js'
import { safeRegexTest } from './regex-utils.js'
import {
  EVIDENCE_RANK,
  MAX_EVIDENCE_RANK,
  resolveEvidenceSeverity,
} from './SecurityScanner.evidence.js'
import { resolvePatternScope } from './patterns.scope.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Context information for each line in markdown content
 */
export interface LineContext {
  lineNumber: number
  inCodeBlock: boolean
  inTable: boolean
  isIndentedCode: boolean
  isInlineCode: boolean
  /**
   * SMI-4396 Wave 2: line falls within a YAML frontmatter block
   * (between opening `---` at file start and the next `---`). SKILL.md
   * authors legitimately include domain keywords (`password`, `secrets`,
   * `privilege escalation`) in `description:` fields — findings in
   * this context are documentation, not code.
   */
  inFrontmatter: boolean
}

// ============================================================================
// Markdown Context Analysis
// ============================================================================

/**
 * Analyze markdown content and return context for each line
 * Used to reduce false positives in documentation/examples
 *
 * SMI-4396 Wave 2: tracks YAML frontmatter context (the `---`-fenced block
 * at the top of a SKILL.md). Opening `---` must be at line 0 (ignoring
 * leading blank lines); closing `---` ends the block. Lines within are
 * marked inFrontmatter=true so their keyword matches downgrade to
 * documentation severity.
 */
export function analyzeMarkdownContext(content: string): LineContext[] {
  const lines = content.split('\n')
  const contexts: LineContext[] = []
  let inFencedCodeBlock = false
  // SMI-4396 Wave 2: frontmatter state machine
  // frontmatterState: 'pending' (before any non-blank line), 'open' (inside), 'closed' (after second fence).
  let frontmatterState: 'pending' | 'open' | 'closed' = 'pending'
  let frontmatterOpenedAtLine = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedLine = line.trim()

    // SMI-4396 Wave 2: detect opening/closing frontmatter fence.
    // Opening must be at file start (only blank lines precede); closing is
    // the next `---` on its own line after the opening.
    let lineInFrontmatter = false
    if (trimmedLine === '---') {
      if (frontmatterState === 'pending') {
        // Opening fence: only valid if no content lines have preceded.
        frontmatterState = 'open'
        frontmatterOpenedAtLine = i
        lineInFrontmatter = true // the fence itself is part of frontmatter
      } else if (frontmatterState === 'open') {
        frontmatterState = 'closed'
        lineInFrontmatter = true // the closing fence too
      }
    } else if (frontmatterState === 'pending' && trimmedLine.length > 0) {
      // First non-blank non-fence line: frontmatter never opened. Abort the pending state.
      frontmatterState = 'closed'
    } else if (frontmatterState === 'open') {
      lineInFrontmatter = true
    }

    // Check for fenced code block boundaries (``` or ~~~). Frontmatter lines
    // never participate — YAML is not markdown code fences.
    if (!lineInFrontmatter && /^(`{3,}|~{3,})/.test(trimmedLine)) {
      inFencedCodeBlock = !inFencedCodeBlock
    }

    // Check for table row (starts with |)
    const inTable = !lineInFrontmatter && trimmedLine.startsWith('|')

    // Check for indented code block (4+ spaces or tab at start, not in list)
    const isIndentedCode =
      !lineInFrontmatter &&
      /^( {4,}|\t)/.test(line) &&
      !inFencedCodeBlock &&
      !trimmedLine.startsWith('-') &&
      !trimmedLine.startsWith('*')

    // Check for inline code (content between backticks on same line)
    const isInlineCode = !lineInFrontmatter && /`[^`]+`/.test(line) && !inFencedCodeBlock

    contexts.push({
      lineNumber: i + 1,
      inCodeBlock: inFencedCodeBlock,
      inTable,
      isIndentedCode,
      isInlineCode,
      inFrontmatter: lineInFrontmatter,
    })
  }

  // If we opened frontmatter but never closed it, unwind — do NOT mark the
  // whole file as frontmatter. This is defensive against malformed files
  // where a bare `---` sneaks in without a close.
  if (frontmatterState === 'open' && frontmatterOpenedAtLine >= 0) {
    for (let i = frontmatterOpenedAtLine; i < contexts.length; i++) {
      contexts[i].inFrontmatter = false
    }
  }

  return contexts
}

/**
 * Check if a line is in a documentation context (code block, table, example).
 * Note: isInlineCode is intentionally excluded — it marks the entire line,
 * but only specific match positions within backtick spans should reduce severity.
 * Use isWithinInlineCode() for per-span granularity (SMI-3521).
 *
 * SMI-4396 Wave 2: inFrontmatter also counts as documentation context.
 * SKILL.md authors legitimately include domain keywords in description:
 * fields (1Password integrations, security-research skills, etc.).
 */
export function isDocumentationContext(ctx: LineContext): boolean {
  return ctx.inCodeBlock || ctx.inTable || ctx.isIndentedCode || ctx.inFrontmatter
}

/**
 * SMI-3521: Check if a match position falls within an inline code span (backtick-delimited).
 * Unlike the line-level isInlineCode flag, this provides per-span granularity:
 * only content actually between backticks is considered inline code.
 */
export function isWithinInlineCode(line: string, matchIndex: number): boolean {
  const backtickRegex = /`([^`]+)`/g
  let match
  while ((match = backtickRegex.exec(line)) !== null) {
    const spanStart = match.index
    const spanEnd = match.index + match[0].length
    if (matchIndex >= spanStart && matchIndex < spanEnd) {
      return true
    }
  }
  return false
}

// ============================================================================
// Shared Pattern Scanning
// ============================================================================

interface MultilineScanConfig {
  type: SecurityFindingType
  messagePrefix: string
  patterns: RegExp[]
  /**
   * SMI-5876: replaces the flat `[docContext, normal]` severity pair — returns
   * the evidence tier for a given pattern (by object identity) so
   * severity/confidence can be resolved per-line via `resolveEvidenceSeverity`
   * once the strongest tier for that line is known.
   */
  classify: (pattern: RegExp) => EvidenceType
}

/** Best evidence found so far for a given line, across both scan passes. */
interface EvidenceCandidate {
  tier: EvidenceType
  matchText: string
  location: string
  inDocContext: boolean
}

/**
 * Scan content for patterns that may span multiple lines.
 * Multi-line patterns are tested against full content; single-line patterns per-line.
 *
 * SMI-5876: patterns within a single category (jailbreak / ai_defence) can now
 * carry DIFFERENT evidence tiers (a bare "jailbreak" mention vs. an explicit
 * "ignore all previous instructions" override), so array-declaration order is
 * no longer sufficient to decide which match wins on a line where multiple
 * patterns fire — the STRONGEST evidence tier per line wins, computed via a
 * merge across both passes (`bestByLine`), not "first match, in array order."
 *
 * Two hazards this closes (see the SMI-5876 design doc §5 for the full
 * argument):
 *   Hazard A — pass 2 used to `break` on the FIRST matching pattern
 *     regardless of tier, so a weaker mention declared earlier in the array
 *     could shadow a stronger directive declared later on the same line.
 *   Hazard B — a multiline pattern match used to suppress ALL single-line
 *     patterns on that line (`flaggedLines`), so a mention-tier multiline
 *     match could hide a directive-tier single-line match on the same line.
 *     `bestByLine` SEEDS pass 2 with pass 1's result instead of skipping the
 *     line outright, so pass 2 can still find something stronger.
 */
export function scanPatternsWithMultilineSupport(
  content: string,
  config: MultilineScanConfig,
  lineContexts?: LineContext[],
  /**
   * SMI-5881: explicit cap (UTF-16 code units) for the pass-1 full-content
   * regex scan — `Math.min(MAX_CONTENT_LENGTH_FOR_REGEX, maxContentLength)`,
   * computed once by SecurityScanner.scan() and threaded through so the
   * truncation finding it emits matches what actually gets scanned. Omitted
   * (undefined) falls back to safeRegexTest's own default.
   */
  maxLength?: number
): SecurityFinding[] {
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  const bestByLine = new Map<number, EvidenceCandidate>()

  const rank = (t: EvidenceType): number => EVIDENCE_RANK[t]

  // First pass: 'content' | 'both'-scope patterns against full content. No
  // break — every such pattern is independently tested (same cost as before:
  // at most one full-content scan per pattern), and the strongest tier per
  // line wins.
  for (const pattern of config.patterns) {
    if (resolvePatternScope(pattern) === 'line') continue
    const match = safeRegexTest(pattern, content, maxLength)
    if (!match) continue

    // SMI-5876: use the match's own reported index rather than a fresh
    // content.indexOf(match[0]) — the latter misreports the line whenever the
    // matched text ALSO occurs earlier in the content (a real hazard fixed in
    // the same pass as the evidence-tier merge).
    const matchIndex = match.index ?? content.indexOf(match[0])
    const lineNumber = content.slice(0, matchIndex).split('\n').length
    const ctx = contexts[lineNumber - 1]
    const matchLine = lines[lineNumber - 1] ?? ''
    const lineOffset = content.lastIndexOf('\n', matchIndex - 1) + 1
    const matchCol = matchIndex - lineOffset
    const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(matchLine, matchCol)
    const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
    const tier = config.classify(pattern)

    const incumbent = bestByLine.get(lineNumber)
    if (!incumbent || rank(tier) > rank(incumbent.tier)) {
      bestByLine.set(lineNumber, {
        tier,
        matchText: match[0],
        location: match[0].trim().slice(0, 100),
        inDocContext,
      })
    }
  }

  // Second pass: 'line' | 'both'-scope patterns, per-line. Seeds `best` from
  // pass 1 (does NOT skip a line pass 1 already flagged) so a line-local
  // directive can still beat a weaker multiline mention on the same line
  // (Hazard B).
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const ctx = contexts[index]
    let best = bestByLine.get(lineNumber) ?? null

    for (const pattern of config.patterns) {
      if (resolvePatternScope(pattern) === 'content') continue
      const match = safeRegexTest(pattern, line)
      if (!match) continue

      const tier = config.classify(pattern)
      if (!best || rank(tier) > rank(best.tier)) {
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
        best = {
          tier,
          matchText: match[0],
          location: line.trim().slice(0, 100),
          inDocContext,
        }
      }
      // Cannot be beaten — stop scanning this line's remaining patterns.
      if (rank(tier) === MAX_EVIDENCE_RANK) break
    }

    if (best) bestByLine.set(lineNumber, best)
  })

  // Emit one finding per flagged line, in ascending line-number order
  // (matches the line-by-line order callers/tests expect from a per-line
  // scan; emission cardinality only ever tightens — one finding per line per
  // category, same as before the merge).
  const findings: SecurityFinding[] = []
  const orderedLines = Array.from(bestByLine.keys()).sort((a, b) => a - b)
  for (const lineNumber of orderedLines) {
    const candidate = bestByLine.get(lineNumber)
    if (!candidate) continue
    const { severity, confidence } = resolveEvidenceSeverity(candidate.tier, candidate.inDocContext)
    const truncated = candidate.matchText.slice(0, 50)

    findings.push({
      type: config.type,
      severity,
      message: `${config.messagePrefix}: "${truncated}${candidate.matchText.length > 50 ? '...' : ''}"`,
      location: candidate.location,
      lineNumber,
      category: config.type,
      inDocumentationContext: candidate.inDocContext,
      confidence,
      evidenceType: candidate.tier,
    })
  }

  return findings
}

// ============================================================================
// Risk Score Calculation
// ============================================================================

/**
 * SMI-685: Calculate risk score from findings
 * SMI-1513: Accounts for confidence levels (low confidence = reduced weight)
 * Aggregates multiple findings into a risk score from 0-100
 */
export function calculateRiskScore(findings: SecurityFinding[]): {
  total: number
  breakdown: RiskScoreBreakdown
} {
  const breakdown: RiskScoreBreakdown = {
    jailbreak: 0,
    socialEngineering: 0,
    promptLeaking: 0,
    dataExfiltration: 0,
    privilegeEscalation: 0,
    suspiciousCode: 0,
    sensitivePaths: 0,
    externalUrls: 0,
    aiDefence: 0,
    ssrf: 0,
    pii: 0,
    codeExecution: 0,
    obfuscatedDirective: 0,
    typosquat: 0,
  }

  const confidenceWeights: Record<FindingConfidence, number> = {
    high: 1.0,
    medium: 0.7,
    low: 0.3,
  }

  for (const finding of findings) {
    const severityWeight = SEVERITY_WEIGHTS[finding.severity]
    const categoryWeight = CATEGORY_WEIGHTS[finding.type] ?? 1.0
    const confidenceWeight = confidenceWeights[finding.confidence ?? 'high']
    const score = severityWeight * categoryWeight * confidenceWeight

    switch (finding.type) {
      case 'jailbreak':
        breakdown.jailbreak += score
        break
      case 'social_engineering':
        breakdown.socialEngineering += score
        break
      case 'prompt_leaking':
        breakdown.promptLeaking += score
        break
      case 'data_exfiltration':
        breakdown.dataExfiltration += score
        break
      case 'privilege_escalation':
        breakdown.privilegeEscalation += score
        break
      case 'suspicious_pattern':
        breakdown.suspiciousCode += score
        break
      case 'sensitive_path':
        breakdown.sensitivePaths += score
        break
      case 'url':
        breakdown.externalUrls += score
        break
      case 'ai_defence':
        breakdown.aiDefence += score
        break
      case 'ssrf':
        breakdown.ssrf += score
        break
      case 'pii':
        breakdown.pii += score
        break
      case 'code_execution':
        breakdown.codeExecution += score
        break
      case 'obfuscated_directive':
        breakdown.obfuscatedDirective += score
        break
      case 'typosquat':
        // SMI-595: this switch has NO default case — a missing arm here would
        // silently drop every typosquat finding from the breakdown with zero
        // compile-time or runtime error. See the switch-case coverage test in
        // SecurityScanner.scoring.test.ts, added specifically to guard this.
        breakdown.typosquat += score
        break
    }
  }

  // Cap each category at 100
  breakdown.jailbreak = Math.min(100, breakdown.jailbreak)
  breakdown.socialEngineering = Math.min(100, breakdown.socialEngineering)
  breakdown.promptLeaking = Math.min(100, breakdown.promptLeaking)
  breakdown.dataExfiltration = Math.min(100, breakdown.dataExfiltration)
  breakdown.privilegeEscalation = Math.min(100, breakdown.privilegeEscalation)
  breakdown.suspiciousCode = Math.min(100, breakdown.suspiciousCode)
  breakdown.sensitivePaths = Math.min(100, breakdown.sensitivePaths)
  breakdown.externalUrls = Math.min(100, breakdown.externalUrls)
  breakdown.aiDefence = Math.min(100, breakdown.aiDefence)
  breakdown.ssrf = Math.min(100, breakdown.ssrf)
  breakdown.pii = Math.min(100, breakdown.pii)
  breakdown.codeExecution = Math.min(100, breakdown.codeExecution)
  breakdown.obfuscatedDirective = Math.min(100, breakdown.obfuscatedDirective)
  breakdown.typosquat = Math.min(100, breakdown.typosquat)

  // SMI-5359 Wave 4.2: the two new categories use a 0.40 coefficient and are ADDITIVE
  // (the original eleven coefficients sum to 1.0; these add on top). No code assumes the
  // coefficients sum to 1.0, and the final Math.min(100, ...) cap is preserved — so a skill
  // that triggers neither new category scores exactly as before (both breakdown entries 0).
  // SMI-595: typosquat is likewise ADDITIVE, at the 0.04 coefficient already used for
  // sensitivePaths/externalUrls/ssrf (the "advisory tier" of this second-stage formula) —
  // NOT folded into the eleven-category budget that sums to 1.0. See weights.ts's
  // CATEGORY_WEIGHTS.typosquat comment for the worked calculation this pairs with.
  const total = Math.min(
    100,
    Math.round(
      breakdown.jailbreak * 0.2 +
        breakdown.socialEngineering * 0.11 +
        breakdown.promptLeaking * 0.11 +
        breakdown.dataExfiltration * 0.08 +
        breakdown.privilegeEscalation * 0.11 +
        breakdown.suspiciousCode * 0.07 +
        breakdown.sensitivePaths * 0.04 +
        breakdown.externalUrls * 0.04 +
        breakdown.aiDefence * 0.12 +
        breakdown.ssrf * 0.04 +
        breakdown.pii * 0.08 +
        breakdown.codeExecution * 0.4 +
        breakdown.obfuscatedDirective * 0.4 +
        breakdown.typosquat * 0.04
    )
  )

  return { total, breakdown }
}
