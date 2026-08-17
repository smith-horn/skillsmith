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
 *
 * SMI-6033 Wave 2 (Gap 8) fix (2026-08-17): `isMarkdown` defaults `true`,
 * preserving byte-identical behavior for every existing caller. Pass `false`
 * when scanning content that is NOT markdown — real source files (the Gap 8
 * extended siblings scanned via `bundled-sibling-scan.ts`'s
 * `collectExecutableCodeFiles`). The indented-code-block heuristic below
 * (4+ spaces / tab = "documentation example", a real markdown convention)
 * otherwise silently misclassifies essentially ALL indented Python/Ruby/etc.
 * control-flow bodies as documentation — verified via the edge-twin repro
 * (scripts/indexer/_shared/security-scanner-edge.context.ts's identical
 * fix): a real multi-signal backdoor failed to escalate to critical purely
 * because the whole function body was 4-space indented.
 */
export function analyzeMarkdownContext(content: string, isMarkdown = true): LineContext[] {
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

    // Check for indented code block (4+ spaces or tab at start, not in list).
    // SMI-6033 Wave 2 (Gap 8) fix: this is a markdown-only convention — see
    // this function's own header for why it must never fire on non-markdown
    // (real source file) content.
    const isIndentedCode =
      isMarkdown &&
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
//
// SMI-6033 Wave 4: `calculateRiskScore` moved to its own sibling file,
// `SecurityScanner.risk-score.ts` — this file had grown to 504/500 lines
// (over the repo's file-length gate) once Wave 4's `decoyMisdirection`
// breakdown wiring landed. Import sites updated to the new path directly
// (matching this codebase's `extractUrls`/`SecurityScanner.urls.ts`
// extraction precedent, not a re-export shim).
