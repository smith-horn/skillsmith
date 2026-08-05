/**
 * Security Scanner Helper Functions
 * @module @skillsmith/core/security/scanner/SecurityScanner.helpers
 */

import type { SecurityFinding, SecurityFindingType, EvidenceType } from './types.js'
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

/**
 * SMI-5879 (design §3.3.4): correctness ceiling on distinct lines recorded per
 * pattern in the pass-1 full-content scan — score-neutral by proof (Lemma
 * 3.3-B): once one pattern alone has pushed its category's raw subtotal past
 * the per-category `Math.min(100, …)` cap, no further line from that SAME
 * pattern can change the post-cap value. Derived floor:
 * `ceil(100 / min_raw_per_finding)` where `min_raw_per_finding` is the
 * smallest (severity × category-weight × confidence) reachable from the
 * multiline pass — today an `ai_defence` `mention` in either context:
 * `low(5) × 1.9 × low(0.3) = 2.85`, giving `ceil(100/2.85) = 36`. Set to 64
 * (1.78x headroom over the derived floor) so a future weight change that
 * lowers the minimum per-finding contribution doesn't immediately breach it;
 * `scanner-multiline-cap.test.ts` recomputes the floor from the live weight
 * tables and asserts this constant stays `>=` it.
 */
export const MAX_MULTILINE_LINES_PER_PATTERN = 64

/**
 * SMI-5879 (design §3.3.3/3.3.6): wall-clock LIVENESS bound on a single
 * pattern's pass-1 loop — NOT score-neutral (unlike the line cap above). A
 * same-line repetition (e.g. 200 matches on one line) costs one iteration per
 * match even though `seenLines` never grows past 1, so this bounds worst-case
 * iteration count on a pathological same-line-repetition input. Binding marks
 * the scan `multilineTruncated`; a truncated scan may only ever RAISE a
 * verdict, never lower one (design §3.3.6) — enforced by the write path, not
 * here.
 */
export const MAX_MULTILINE_ITERATIONS_PER_PATTERN = 10_000

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
export interface MultilineScanResult {
  findings: SecurityFinding[]
  /**
   * SMI-5879 (design §3.3.6): true when at least one pattern's pass-1 loop
   * hit MAX_MULTILINE_ITERATIONS_PER_PATTERN before exhausting its matches.
   * NOT provably score-neutral (unlike the line cap) — a truncated scan may
   * under-count. The write path must treat a truncated scan as authoritative
   * for RAISING a verdict only, never for lowering one or clearing an
   * existing quarantine.
   */
  truncated: boolean
}

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
): MultilineScanResult {
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  const bestByLine = new Map<number, EvidenceCandidate>()
  let truncated = false

  const rank = (t: EvidenceType): number => EVIDENCE_RANK[t]

  // First pass: 'content' | 'both'-scope patterns against full content.
  //
  // SMI-5879 (design §3.3): each multiline pattern gets its OWN global-flag
  // clone (never mutating the shared pattern object) and its own per-pattern
  // `seenLines` set. A second match on a line already recorded by THIS
  // pattern is a provable no-op (Lemma 3.3-A: same tier, same line, strict
  // `>` merge comparison) and costs nothing once skipped. The effective input
  // is truncated to `maxLength` up front (mirroring safeRegexTest's own
  // truncation) so `lineNumberOf` never reads past what was actually scanned.
  const scannedContent =
    maxLength !== undefined && content.length > maxLength ? content.slice(0, maxLength) : content

  for (const pattern of config.patterns) {
    if (resolvePatternScope(pattern) === 'line') continue

    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
    const g = new RegExp(pattern.source, flags)
    const seenLines = new Set<number>()
    let iterations = 0
    let m: RegExpExecArray | null

    while ((m = g.exec(scannedContent)) !== null) {
      if (m[0].length === 0) g.lastIndex++ // zero-length-match advance

      if (++iterations > MAX_MULTILINE_ITERATIONS_PER_PATTERN) {
        truncated = true
        break
      }

      // SMI-5879: many content-scope patterns lead with a captured `(?:^|\n)`
      // (a line-start anchor), so `m.index` for the 2nd+ occurrence points at
      // the NEWLINE ending the PREVIOUS line, not at the matched line's own
      // content — attributing raw `m.index` directly under-counts the target
      // line by one and (worse) collides with an already-seen earlier line,
      // silently dropping the real match. Skip past any leading `\n`
      // character(s) to the match's actual content start before resolving
      // the line/column.
      const matchIndex = m.index
      let contentIndex = matchIndex
      while (scannedContent[contentIndex] === '\n') contentIndex++

      const lineNumber = scannedContent.slice(0, contentIndex).split('\n').length
      if (seenLines.has(lineNumber)) continue // Lemma 3.3-A: costs nothing

      if (seenLines.size >= MAX_MULTILINE_LINES_PER_PATTERN) break // score-neutral (Lemma 3.3-B)

      seenLines.add(lineNumber)

      const ctx = contexts[lineNumber - 1]
      const matchLine = lines[lineNumber - 1] ?? ''
      const lineOffset = scannedContent.lastIndexOf('\n', contentIndex - 1) + 1
      const matchCol = contentIndex - lineOffset
      const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(matchLine, matchCol)
      const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
      const tier = config.classify(pattern)

      const incumbent = bestByLine.get(lineNumber)
      if (!incumbent || rank(tier) > rank(incumbent.tier)) {
        bestByLine.set(lineNumber, {
          tier,
          matchText: m[0],
          location: m[0].trim().slice(0, 100),
          inDocContext,
        })
      }
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
    const truncatedText = candidate.matchText.slice(0, 50)

    findings.push({
      type: config.type,
      severity,
      message: `${config.messagePrefix}: "${truncatedText}${candidate.matchText.length > 50 ? '...' : ''}"`,
      location: candidate.location,
      lineNumber,
      category: config.type,
      inDocumentationContext: candidate.inDocContext,
      confidence,
      evidenceType: candidate.tier,
    })
  }

  return { findings, truncated }
}

// ============================================================================
// Risk Score Calculation
// ============================================================================
// SMI-5879: moved to SecurityScanner.risk-score.ts (this file was approaching
// the 500-line audit:standards gate again after the RC-1 two-bound multiline
// loop grew it) — re-exported here unchanged for existing consumers.

export { calculateRiskScore } from './SecurityScanner.risk-score.js'
