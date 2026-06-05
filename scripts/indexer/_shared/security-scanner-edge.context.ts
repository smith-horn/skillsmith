/**
 * SMI-4960: Edge security-scanner context + scoring model
 * @module scripts/indexer/_shared/security-scanner-edge.context (Node port)
 *
 * Split out of security-scanner-edge.ts to keep each file under the 500-line
 * limit (SMI-3493). Holds the shared finding types, the per-line markdown
 * context analyzer, and the confidence-weighted risk scorer — all ported from
 * @skillsmith/core (SecurityScanner.helpers.ts / weights.ts) so the Deno edge
 * quarantine gate uses the same context-aware model the core scanner already
 * validated. Pure Deno/Web APIs, no Node deps. Kept byte-identical to its
 * scripts/indexer/_shared twin (parity test enforces).
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Types of security findings
 */
export type SecurityFindingType =
  | 'jailbreak'
  | 'suspicious_pattern'
  | 'data_exfiltration'
  | 'privilege_escalation'
  | 'prompt_injection'

/**
 * Severity levels for findings
 */
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'

/**
 * SMI-4960: Confidence level for a finding (ported from core).
 * - high: Strong indicator of malicious intent (full weight)
 * - medium: Possible issue, context suggests caution (0.7x weight)
 * - low: Likely false positive — e.g. in documentation/examples (0.3x weight)
 */
export type FindingConfidence = 'high' | 'medium' | 'low'

/**
 * Individual security finding
 */
export interface SecurityFinding {
  type: SecurityFindingType
  severity: SecuritySeverity
  message: string
  lineNumber?: number
  location?: string
  /**
   * SMI-4960: Whether the finding sits in a documentation context (fenced/
   * indented code, table row, frontmatter, or an inline-code span). Documentation
   * matches are prose/examples, not live payloads.
   */
  inDocumentationContext?: boolean
  /** SMI-4960: Confidence level — lower for findings in documentation context. */
  confidence?: FindingConfidence
}

/**
 * SMI-4960: Per-line markdown context (ported VERBATIM from core
 * SecurityScanner.helpers.ts LineContext). Used to downgrade documentation
 * matches to low confidence.
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
// Severity + Category + Confidence Weights (SMI-4960: ported from core)
// ============================================================================

/**
 * SMI-4960: severity weights — byte-identical to core weights.ts SEVERITY_WEIGHTS.
 */
export const SEVERITY_WEIGHTS: Record<SecuritySeverity, number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
}

/**
 * SMI-4960: category weights — the four shared categories carry core
 * weights.ts CATEGORY_WEIGHTS values. The edge-only `prompt_injection` type has
 * no core equivalent; it is mapped onto core's `ai_defence` (weight 1.9,
 * coefficient 0.12) since both detect AI-injection attacks.
 */
export const CATEGORY_WEIGHTS: Record<SecurityFindingType, number> = {
  jailbreak: 2.0,
  suspicious_pattern: 1.3,
  data_exfiltration: 1.7,
  privilege_escalation: 1.9,
  prompt_injection: 1.9, // mapped to core ai_defence
}

/**
 * SMI-4960: per-category final coefficients — byte-identical to the multipliers
 * in core SecurityScanner.helpers.ts calculateRiskScore. `prompt_injection`
 * uses core's `ai_defence` coefficient (0.12).
 */
export const CATEGORY_COEFFICIENTS: Record<SecurityFindingType, number> = {
  jailbreak: 0.2,
  suspicious_pattern: 0.07, // core suspiciousCode
  data_exfiltration: 0.08,
  privilege_escalation: 0.11,
  prompt_injection: 0.12, // mapped to core ai_defence
}

/**
 * SMI-4960: confidence weights — byte-identical to core
 * SecurityScanner.helpers.ts calculateRiskScore confidenceWeights.
 */
export const CONFIDENCE_WEIGHTS: Record<FindingConfidence, number> = {
  high: 1.0,
  medium: 0.7,
  low: 0.3,
}

// ============================================================================
// Markdown Context Analysis
// ============================================================================

/**
 * SMI-2385: Check if a given line index is inside a fenced code block.
 *
 * Bioinformatics and other technical SKILL.md files commonly document
 * tool installation with patterns like `curl | bash`, `exec()`, and
 * `subprocess.run` inside markdown code blocks. These are false positives
 * for the security scanner. This helper enables context-aware severity
 * downgrading for patterns found inside code fences.
 *
 * Walks lines 0..lineIndex counting triple-backtick fence toggles.
 * An odd count means we are inside a fenced block.
 *
 * SMI-4960: retained for backward compatibility / `quickSecurityCheck`; the
 * primary scanners now use analyzeMarkdownContext for richer context
 * (frontmatter, tables, indented code, inline code).
 */
export function isInsideCodeBlock(lines: string[], lineIndex: number): boolean {
  let insideCodeBlock = false
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('```')) {
      insideCodeBlock = !insideCodeBlock
    }
  }
  return insideCodeBlock
}

/**
 * SMI-4960: Analyze markdown content and return context for each line.
 * Ported VERBATIM from core SecurityScanner.helpers.ts analyzeMarkdownContext.
 * Used to reduce false positives in documentation/examples.
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
 * SMI-4960: Check if a line is in a documentation context (code block, table,
 * indented example, frontmatter). Ported VERBATIM from core
 * SecurityScanner.helpers.ts isDocumentationContext.
 *
 * Note: isInlineCode is intentionally excluded — it marks the entire line,
 * but only specific match positions within backtick spans should reduce severity.
 * Use isWithinInlineCode() for per-span granularity (SMI-3521).
 */
export function isDocumentationContext(ctx: LineContext): boolean {
  return ctx.inCodeBlock || ctx.inTable || ctx.isIndentedCode || ctx.inFrontmatter
}

/**
 * SMI-3521 / SMI-4960: Check if a match position falls within an inline code
 * span (backtick-delimited). Ported VERBATIM from core
 * SecurityScanner.helpers.ts isWithinInlineCode. Unlike the line-level
 * isInlineCode flag, this provides per-span granularity: only content actually
 * between backticks is considered inline code.
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

/**
 * SMI-4960: Compute confidence + doc-context flag for a single-line match,
 * shared by all five scanners. A match is documentation context when its line
 * is a code block / table / indented code / frontmatter, OR the line is inline
 * code AND the match position falls within a backtick span.
 */
export function classifyMatch(
  ctx: LineContext | undefined,
  line: string,
  matchIndex: number
): { inDocContext: boolean; confidence: FindingConfidence } {
  const inInlineCode = ctx?.isInlineCode ? isWithinInlineCode(line, matchIndex) : false
  const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
  return { inDocContext, confidence: inDocContext ? 'low' : 'high' }
}

// ============================================================================
// Risk Score Calculation
// ============================================================================

/**
 * SMI-4960: Calculate risk score from findings using core's
 * category-coefficient + confidence model (ported from core
 * SecurityScanner.helpers.ts calculateRiskScore).
 *
 * Per finding: score = SEVERITY_WEIGHTS[sev] * CATEGORY_WEIGHTS[type] *
 * CONFIDENCE_WEIGHTS[confidence]. Scores accumulate per category, each category
 * is capped at 100, then the final = round(sum(category * coefficient)) capped
 * at 100.
 *
 * Why this fixes the FP gate: previously a single regex match scored
 * SEVERITY_WEIGHTS[critical] * TYPE_WEIGHTS[jailbreak] = 50 * 2.0 = 100, well
 * over the 40 threshold. Now a lone documentation-context match is low
 * confidence: 50 * 2.0 * 0.3 = 30 raw, * 0.2 coefficient = 6 — far under 40. A
 * lone HIGH-confidence jailbreak (50 * 2.0 * 1.0 = 100, capped, * 0.2 = 20) also
 * stays under 40 on its own. Crossing 40 requires multiple high-confidence
 * findings (saturation) — exactly the malicious shape we want to keep
 * quarantining. (A single isolated low-confidence finding passing is intentional
 * and matches core/team policy.)
 */
export function calculateRiskScore(findings: SecurityFinding[]): number {
  const breakdown: Record<SecurityFindingType, number> = {
    jailbreak: 0,
    suspicious_pattern: 0,
    data_exfiltration: 0,
    privilege_escalation: 0,
    prompt_injection: 0,
  }

  for (const finding of findings) {
    const severityWeight = SEVERITY_WEIGHTS[finding.severity]
    const categoryWeight = CATEGORY_WEIGHTS[finding.type] ?? 1.0
    const confidenceWeight = CONFIDENCE_WEIGHTS[finding.confidence ?? 'high']
    breakdown[finding.type] += severityWeight * categoryWeight * confidenceWeight
  }

  // Cap each category at 100
  for (const type of Object.keys(breakdown) as SecurityFindingType[]) {
    breakdown[type] = Math.min(100, breakdown[type])
  }

  // Final = round(sum(category * coefficient)) capped at 100
  let total = 0
  for (const type of Object.keys(breakdown) as SecurityFindingType[]) {
    total += breakdown[type] * CATEGORY_COEFFICIENTS[type]
  }

  return Math.min(100, Math.round(total))
}
