/**
 * Security Scanner - SMI-587, SMI-685, SMI-882, SMI-1189
 *
 * Security scanning for skill content with advanced pattern detection.
 */

import type { SecurityFinding, ScanReport, ScannerOptions, FindingConfidence } from './types.js'
import {
  DEFAULT_ALLOWED_DOMAINS,
  JAILBREAK_PATTERNS,
  SUSPICIOUS_PATTERNS,
  AI_DEFENCE_PATTERNS,
} from './patterns.js'
import { safeRegexTest, safeRegexCheck, MAX_CONTENT_LENGTH_FOR_REGEX } from './regex-utils.js'

// Import helpers
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
  scanPatternsWithMultilineSupport,
} from './SecurityScanner.helpers.js'
// SMI-6033 Wave 2 (Gap 4): promoted shared URL extraction (see module header).
import { extractUrls } from './SecurityScanner.urls.js'
// SMI-6033 Wave 4: extracted out of SecurityScanner.helpers.ts (500-line gate).
import { calculateRiskScore } from './SecurityScanner.risk-score.js'

// Import SSRF scanner
import { scanSsrfPatterns } from './SecurityScanner.ssrf.js'

// Import per-category scanners (SMI-5359 Wave 4.2: extracted to keep this file
// under the 500-line gate; pure functions of content + lineContexts).
import {
  scanSensitivePaths,
  scanSocialEngineering,
  scanPromptLeaking,
  scanDataExfiltration,
  scanPrivilegeEscalation,
  scanChmodFetchCompound,
  scanPiiPatterns,
} from './SecurityScanner.scanners.js'

// SMI-6033 Wave 2: xattr Gatekeeper-bypass (Gap 5) — lives alongside
// scanChmodFetchCompound in the same compound-signal module.
import { scanGatekeeperBypass } from './SecurityScanner.compound.js'
// SMI-6033 Wave 2: password-protected archive evasion (Gap 3).
import { scanArchiveEvasion } from './SecurityScanner.archive.js'
// SMI-6033 Wave 2: paste/snippet-host reputation + fetch-context escalation (Gap 4).
import { scanPasteHostFetch } from './SecurityScanner.paste-host.js'
// SMI-6033 Wave 2 (Gap 2): encoded (base64) payload detect-decode-recursively-rescan.
import { scanEncodedPayload } from './SecurityScanner.encoding.js'
// SMI-6033 Wave 4 (Gap 6): decoy/misdirection URL-target heuristic.
import { scanDecoyMisdirection } from './SecurityScanner.decoy.js'

// Import code-execution & obfuscated-directive detectors (SMI-5359 Wave 4.2).
import {
  scanCodeExecution,
  scanObfuscatedDirective,
  escalateCodeExecution,
} from './SecurityScanner.exec.js'

// SMI-5876: evidence-tier classification + corroboration escalation for
// jailbreak/ai_defence findings.
import { classifyEvidence, escalateCorroboratedMentions } from './SecurityScanner.evidence.js'

// Import formatters (used for both re-export and static methods)
import {
  toMinimalRefs,
  toSARIF,
  toGitHubAnnotations,
  toSummary,
} from './SecurityScanner.formatters.js'

// Re-export helpers and formatters for public API
export {
  LineContext,
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
  calculateRiskScore,
  extractUrls,
}
export { scanSsrfPatterns }
export { toMinimalRefs, toSARIF, toGitHubAnnotations, toSummary }

export class SecurityScanner {
  private allowedDomains: Set<string>
  private blockedPatterns: RegExp[]
  private maxContentLength: number
  private riskThreshold: number

  constructor(options: ScannerOptions = {}) {
    this.allowedDomains = new Set(options.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS)
    this.blockedPatterns = options.blockedPatterns ?? []
    this.maxContentLength = options.maxContentLength ?? 1_000_000 // 1MB
    this.riskThreshold = options.riskThreshold ?? 40
  }

  private isAllowedDomain(url: string): boolean {
    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname.toLowerCase()
      return Array.from(this.allowedDomains).some(
        (domain) => hostname === domain || hostname.endsWith('.' + domain)
      )
    } catch {
      return false
    }
  }

  private scanUrls(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const urls = extractUrls(content)

    for (const { url, line } of urls) {
      if (!this.isAllowedDomain(url)) {
        findings.push({
          type: 'url',
          severity: 'medium',
          message: `External URL not in allowlist: ${url}`,
          location: url,
          lineNumber: line,
        })
      }
    }

    return findings
  }

  private scanJailbreakPatterns(
    content: string,
    lineContexts: LineContext[] | undefined,
    maxMultilineLength: number
  ): SecurityFinding[] {
    return scanPatternsWithMultilineSupport(
      content,
      {
        type: 'jailbreak',
        messagePrefix: 'Potential jailbreak pattern detected',
        patterns: JAILBREAK_PATTERNS,
        classify: classifyEvidence,
      },
      lineContexts,
      maxMultilineLength
    )
  }

  private scanSuspiciousPatterns(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]

      for (const pattern of SUSPICIOUS_PATTERNS) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
          const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
          // Non-doc keeps the original medium/implicit-high score (confidence
          // defaults to 'high'); doc-context downgrades both so a fenced/quoted
          // example cannot reach the trust-scorer.ts:58 high/critical short-circuit.
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity: SecurityFinding['severity'] = inDocContext ? 'low' : 'medium'

          findings.push({
            type: 'suspicious_pattern',
            severity,
            message: `Suspicious pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'suspicious_pattern',
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }

      for (const pattern of this.blockedPatterns) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
          const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
          // Non-doc keeps the original high score; doc-context drops to medium
          // so a quoted "blocked" example cannot trip trust-scorer.ts:58.
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity: SecurityFinding['severity'] = inDocContext ? 'medium' : 'high'

          findings.push({
            type: 'suspicious_pattern',
            severity,
            message: `Blocked pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'suspicious_pattern',
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }
    })

    return findings
  }

  private scanAIDefenceVulnerabilities(
    content: string,
    lineContexts: LineContext[] | undefined,
    maxMultilineLength: number
  ): SecurityFinding[] {
    return scanPatternsWithMultilineSupport(
      content,
      {
        type: 'ai_defence',
        messagePrefix: 'AI injection pattern detected',
        patterns: AI_DEFENCE_PATTERNS,
        classify: classifyEvidence,
      },
      lineContexts,
      maxMultilineLength
    )
  }

  /** @deprecated Use standalone calculateRiskScore function for new code */
  calculateRiskScore = calculateRiskScore

  /**
   * Run every content-scanning detector against `content` and return the
   * combined findings. Factored out of `scan()` (SMI-6033 Wave 2, Gap 2) so
   * the encoded-payload detector's recursive rescan of DECODED content can
   * reuse the exact same detector suite instead of a parallel, narrower
   * reimplementation.
   *
   * `skipEncodedPayload` is the STRUCTURAL depth-1 recursion guarantee: the
   * recursive callback passed to `scanEncodedPayload` below always calls this
   * method with `skipEncodedPayload: true`, so a base64 blob discovered
   * INSIDE already-decoded content can never itself be decoded — the inner
   * call cannot reach `scanEncodedPayload` again no matter what the decoded
   * text contains. This disables ONLY the encoded-payload detector on the
   * inner call, not the rest of the suite — a decoded `curl|bash` still
   * trips `code_execution`, decoded secrets still trip `sensitive_path`, etc.
   */
  private runDetectors(
    content: string,
    lineContexts: LineContext[],
    skipEncodedPayload: boolean,
    isHighTrustAuthor = false,
    isMarkdown = true
  ): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    // SMI-5881: the multiline (full-content) regex pass has its OWN, much
    // smaller cap than maxContentLength — a ReDoS budget input, not a free
    // parameter (see MAX_CONTENT_LENGTH_FOR_REGEX's own comment for why this
    // isn't simply raised to match maxContentLength). A lower configured
    // maxContentLength tightens this further; it never widens it. Depends
    // only on `this.maxContentLength` (a per-instance constant), so it is
    // safe to recompute per call rather than threading it from `scan()`.
    const effectiveMultilineLimit = Math.min(MAX_CONTENT_LENGTH_FOR_REGEX, this.maxContentLength)

    findings.push(...this.scanUrls(content))
    findings.push(...scanSensitivePaths(content, lineContexts))
    findings.push(...this.scanJailbreakPatterns(content, lineContexts, effectiveMultilineLimit))
    findings.push(...this.scanSuspiciousPatterns(content, lineContexts))
    findings.push(...scanSocialEngineering(content, lineContexts))
    findings.push(...scanPromptLeaking(content, lineContexts))
    findings.push(...scanDataExfiltration(content, lineContexts))
    findings.push(...scanPrivilegeEscalation(content, lineContexts))
    // SMI-5424 PR2: owner-perm chmod is a compound signal — emit only when
    // co-located with a fetch/download verb. Pass the lines already flagged by
    // the standalone (world-writable/setuid) privesc patterns so we never
    // double-emit. Runs before escalateCodeExecution so a compound chmod (HIGH)
    // can serve as the code_execution co-signal.
    const privEscLines = new Set(
      findings
        .filter((f) => f.type === 'privilege_escalation' && f.lineNumber)
        .map((f) => f.lineNumber as number)
    )
    findings.push(...scanChmodFetchCompound(content, privEscLines, lineContexts))
    // SMI-6033 Wave 2/3 (Gap 5): xattr Gatekeeper-bypass — critical only when
    // correlated with a fetch destination AND the author isn't high-trust
    // (indexer path only; skill_validate never passes isHighTrustAuthor, so
    // it defaults closed and correlated xattr stays always-critical there).
    findings.push(...scanGatekeeperBypass(content, lineContexts, isHighTrustAuthor))
    // SMI-6033 Wave 2 (Gap 3): password-protected archive evasion —
    // correlated + inline-literal-password form is standalone-critical;
    // every other shape (uncorrelated CLI usage, prose-only mention) is
    // medium/advisory.
    findings.push(...scanArchiveEvasion(content, lineContexts))
    // SMI-6033 Wave 2 (Gap 4): paste/snippet-host reputation — a paste-host
    // URL that is the target of a fetch command is standalone-critical; a
    // merely-linked paste-host URL keeps only its existing scanUrls()
    // url:medium finding (this detector adds no finding for that case).
    findings.push(...scanPasteHostFetch(content, lineContexts))
    // SMI-6033 Wave 4 (Gap 6): decoy/misdirection — a fetch target whose
    // domain doesn't match a brand/authority claim made nearby in the
    // skill's own prose. Advisory-only (medium, never high/critical); must
    // run before escalateCodeExecution below since a later dispatch wires
    // this finding type into that co-signal mechanism.
    findings.push(...scanDecoyMisdirection(content, lineContexts))
    findings.push(
      ...this.scanAIDefenceVulnerabilities(content, lineContexts, effectiveMultilineLimit)
    )
    findings.push(...scanSsrfPatterns(content, lineContexts, effectiveMultilineLimit))
    findings.push(...scanPiiPatterns(content, lineContexts))
    findings.push(...scanCodeExecution(content, lineContexts))
    findings.push(...scanObfuscatedDirective(content))

    // SMI-5359 Wave 4.2: promote code_execution to critical when it co-occurs with a
    // non-documentation exfiltration / privilege / credential / obfuscation signal.
    // Runs after every detector so all co-signals are present.
    escalateCodeExecution(findings)

    // SMI-5876: lift a bare-vocabulary jailbreak/ai_defence "mention" finding
    // to high/medium when a non-documentation high/critical finding from a
    // DIFFERENT category is also present — e.g. the word "jailbreak" sitting
    // next to a real remote-fetch-to-interpreter is corroborating evidence,
    // not benign prose. MUST run after escalateCodeExecution so a
    // freshly-critical code_execution finding can itself serve as a
    // corroborator (verified: CO_SIGNAL_MIN_SEVERITY — SMI-6033 Wave 4's
    // replacement for CODE_EXECUTION_CO_OCCURRENCE — never contains
    // 'jailbreak'/'ai_defence', so this can't create a feedback loop back
    // into escalateCodeExecution's own decision).
    escalateCorroboratedMentions(findings)

    // SMI-6033 Wave 2 (Gap 2): decode-and-recursively-rescan base64 payloads.
    // Appended AFTER this call's own escalation passes above, and the
    // recursive rescan's OWN findings are already fully escalated by its own
    // (inner) call to this same method — so no finding is ever run through
    // escalateCodeExecution/escalateCorroboratedMentions twice.
    if (!skipEncodedPayload) {
      findings.push(
        ...scanEncodedPayload(content, lineContexts, (decodedContent) =>
          this.runDetectors(
            decodedContent,
            analyzeMarkdownContext(decodedContent, isMarkdown),
            true,
            isHighTrustAuthor,
            isMarkdown
          )
        )
      )
    }

    return findings
  }

  /**
   * SMI-6033 Wave 3 (Gap 5): `isHighTrustAuthor` (default `false`) is the
   * Gatekeeper-bypass trust-tier carve-out — see `scanGatekeeperBypass`'s own
   * header (`SecurityScanner.compound.ts`) for the full policy. No in-repo
   * caller of this method currently has a verified author signal to pass
   * here (the indexer scans via the edge twin, not this core class); the
   * parameter exists so a future verified-author caller can opt in, and so
   * every existing call site (skill_validate, skill_rescan,
   * bundled-sibling-scan, skill-installation.*) defaults closed by
   * construction, not by convention.
   *
   * SMI-6033 Wave 2 (Gap 8) fix (2026-08-17): `isMarkdown` defaults `true`,
   * preserving byte-identical behavior for every existing caller. Pass
   * `false` when `content` is a real source file, not markdown — see
   * `analyzeMarkdownContext`'s own header (SecurityScanner.helpers.ts) for
   * why the markdown-only indented-code-block heuristic must never apply to
   * non-markdown content. `bundled-sibling-scan.ts`'s
   * `collectExecutableCodeFiles` candidates are the first real caller.
   */
  scan(skillId: string, content: string, isHighTrustAuthor = false, isMarkdown = true): ScanReport {
    const startTime = performance.now()
    const findings: SecurityFinding[] = []
    const lineContexts = analyzeMarkdownContext(content, isMarkdown)

    if (content.length > this.maxContentLength) {
      findings.push({
        type: 'suspicious_pattern',
        severity: 'low',
        message: `Content exceeds maximum length (${this.maxContentLength} code units)`,
      })
    }

    // SMI-5881: see runDetectors()'s own comment on effectiveMultilineLimit
    // for why this cap is separate from maxContentLength.
    const effectiveMultilineLimit = Math.min(MAX_CONTENT_LENGTH_FOR_REGEX, this.maxContentLength)
    if (content.length > effectiveMultilineLimit) {
      findings.push({
        type: 'suspicious_pattern',
        severity: 'low',
        message:
          `Multiline regex scan truncated at ${effectiveMultilineLimit} code units ` +
          `(content is ${content.length} code units; configured maxContentLength is ` +
          `${this.maxContentLength} code units)`,
      })
    }

    findings.push(...this.runDetectors(content, lineContexts, false, isHighTrustAuthor, isMarkdown))

    const endTime = performance.now()
    const { total: riskScore, breakdown: riskBreakdown } = calculateRiskScore(findings)

    const hasCritical = findings.some((f) => f.severity === 'critical')
    const hasHigh = findings.some((f) => f.severity === 'high')
    const exceedsThreshold = riskScore >= this.riskThreshold

    return {
      skillId,
      passed: !hasCritical && !hasHigh && !exceedsThreshold,
      findings,
      scannedAt: new Date(),
      scanDurationMs: endTime - startTime,
      riskScore,
      riskBreakdown,
    }
  }

  quickCheck(content: string): boolean {
    for (const pattern of JAILBREAK_PATTERNS) {
      if (safeRegexCheck(pattern, content)) return false
    }
    return true
  }

  addAllowedDomain(domain: string): void {
    this.allowedDomains.add(domain.toLowerCase())
  }

  addBlockedPattern(pattern: RegExp): void {
    this.blockedPatterns.push(pattern)
  }

  // Static methods delegate to formatters for backwards compatibility
  static toMinimalRefs = toMinimalRefs
  static toSARIF = toSARIF
  static toGitHubAnnotations = toGitHubAnnotations
  static toSummary = toSummary
}

export default SecurityScanner
