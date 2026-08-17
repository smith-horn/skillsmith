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
  | 'code_execution'
  | 'obfuscated_directive'
  // SMI-6033 Wave 1: ported core's sensitive-path detector to edge (previously
  // no type/detector/weight/coefficient existed for this category at all).
  | 'sensitive_path'
  // SMI-6033 Wave 1: type-system registration only — core already has this
  // finding type (typosquat.ts); the detector call site is wired separately.
  | 'typosquat'
  // SMI-6033 Wave 2 (Gap 5): xattr strips the macOS Gatekeeper quarantine attribute.
  | 'gatekeeper_bypass'
  // SMI-6033 Wave 2 (Gap 3): password-protected archive used to evade content scanning.
  | 'archive_evasion'
  // SMI-6033 Wave 2 (Gap 4): anonymous paste/snippet-host URL is the target of a fetch command.
  | 'paste_host_fetch'
  // SMI-6033 Wave 2 (Gap 2): base64-encoded blob decoded and recursively rescanned.
  | 'encoded_payload'
  // SMI-6033 Wave 4 (Gap 6): fetch target's domain doesn't match a brand/authority claim made nearby in the skill's own prose.
  | 'decoy_misdirection'

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
  /** SMI-5436: Path of the skill bundle file that triggered this finding, relative to the skill root. Absent for SKILL.md-only findings. */
  filePath?: string
  /**
   * SMI-6033 Wave 2 (Gap 2): the OUTER document line number of the base64
   * blob whose decoded content produced this finding — set ONLY on findings
   * folded in by `scanEncodedPayload`'s recursive rescan. Absent otherwise.
   */
  decodedFrom?: number
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
  // SMI-5359 Wave 4.2c: mirror of core's two new top-tier categories.
  code_execution: 2.0,
  obfuscated_directive: 2.0,
  // SMI-6033 Wave 1: byte-identical to core weights.ts CATEGORY_WEIGHTS.
  sensitive_path: 1.2,
  typosquat: 1.2,
  // SMI-6033 Wave 2: top-tier weight matching code_execution/obfuscated_directive
  // — byte-identical to core weights.ts CATEGORY_WEIGHTS.gatekeeper_bypass /
  // .archive_evasion. The SAME weight is used for both the critical
  // (standalone-quarantining) and medium (advisory) forms of each type;
  // severity alone (SEVERITY_WEIGHTS 50 vs 15) does the two-tier split.
  gatekeeper_bypass: 2.0,
  archive_evasion: 2.0,
  // SMI-6033 Wave 2 (Gap 4): byte-identical to core weights.ts
  // CATEGORY_WEIGHTS.paste_host_fetch — same top-tier weight as
  // gatekeeper_bypass/archive_evasion, for the same reason.
  paste_host_fetch: 2.0,
  // SMI-6033 Wave 2 (Gap 2): byte-identical to core weights.ts
  // CATEGORY_WEIGHTS.encoded_payload — the sensitive_path/typosquat tier
  // (1.2), NOT the 2.0 tier every other Wave 2 category above uses. This
  // wrapper finding is deliberately advisory-only; the escalation comes free
  // from the decoded content's OWN findings (e.g. a decoded `curl|bash`
  // natively trips code_execution at ITS OWN top-tier weight).
  encoded_payload: 1.2,
  // SMI-6033 Wave 4 (Gap 6): byte-identical to core weights.ts
  // CATEGORY_WEIGHTS.decoy_misdirection — same advisory tier as
  // sensitive_path/typosquat/encoded_payload (1.2), NOT the 2.0 tier every
  // other Wave 2/3 category above uses, since this finding type must never
  // be standalone-critical.
  decoy_misdirection: 1.2,
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
  // SMI-5359 Wave 4.2c: additive 0.40 each (mirror of core). One CRITICAL reaches
  // exactly the 40 quarantine threshold: 50 * 2.0 * 1.0 = 100 -> cap 100 -> * 0.40 = 40.
  code_execution: 0.4,
  obfuscated_directive: 0.4,
  // SMI-6033 Wave 1: byte-identical to core SecurityScanner.helpers.ts
  // calculateRiskScore's per-category coefficients — core's "advisory tier"
  // (the same 0.04 core uses for sensitivePaths/externalUrls/ssrf/typosquat).
  sensitive_path: 0.04,
  typosquat: 0.04,
  // SMI-6033 Wave 2: additive 0.40 each (mirror of core), matching
  // code_execution/obfuscated_directive's top tier. A single CRITICAL
  // gatekeeper_bypass/archive_evasion finding reaches exactly the 40
  // quarantine threshold on its own (50 * 2.0 * 1.0 = 100 -> cap 100 -> * 0.40
  // = 40); a single MEDIUM finding contributes 12 — well under threshold alone.
  gatekeeper_bypass: 0.4,
  archive_evasion: 0.4,
  // SMI-6033 Wave 2 (Gap 4): additive 0.40, matching gatekeeper_bypass/
  // archive_evasion — byte-identical to core weights.ts's paired coefficient.
  paste_host_fetch: 0.4,
  // SMI-6033 Wave 2 (Gap 2): additive 0.04 — the sensitive_path/typosquat
  // advisory-tier coefficient, byte-identical to core
  // SecurityScanner.helpers.ts's paired coefficient for encoded_payload.
  encoded_payload: 0.04,
  // SMI-6033 Wave 4 (Gap 6): additive 0.04 — the sensitive_path/typosquat/
  // encoded_payload advisory-tier coefficient, byte-identical to core
  // SecurityScanner.helpers.ts's paired coefficient for decoy_misdirection.
  decoy_misdirection: 0.04,
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
 *
 * SMI-6033 Wave 2 (Gap 8) fix (2026-08-17): `isMarkdown` defaults `true`,
 * preserving byte-identical behavior for every existing caller (SKILL.md,
 * the original 7 `BUNDLED_SCAN_FILES`). Pass `false` when scanning content
 * that is NOT markdown — the new Gap 8 extended siblings (`.py .sh .js .ts
 * .rb .php .ps1 .pl` under `scripts/`/`src/`/`bin/`). The indented-code-block
 * heuristic below (4+ spaces / tab = "documentation example", a real
 * markdown convention) otherwise silently misclassifies essentially ALL
 * indented Python/Ruby/etc. control-flow bodies as documentation, dropping
 * `sensitive_path` from `high`->`medium` and blocking `escalateCodeExecution`
 * path (a) (which requires a non-doc co-signal at `high`+) — verified via a
 * direct repro: a real multi-signal backdoor (`~/.ssh` read next to a
 * `curl|bash`) failed to escalate to `critical` purely because the whole
 * function body was 4-space indented. Fenced-code-block/table/frontmatter
 * detection is left unconditional — those markdown-specific token sequences
 * essentially never occur in real, non-markdown source files, so leaving
 * them active is a negligible residual risk, not worth the extra surface
 * this fix would otherwise touch.
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
    code_execution: 0,
    obfuscated_directive: 0,
    sensitive_path: 0,
    typosquat: 0,
    gatekeeper_bypass: 0,
    archive_evasion: 0,
    paste_host_fetch: 0,
    encoded_payload: 0,
    decoy_misdirection: 0,
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
