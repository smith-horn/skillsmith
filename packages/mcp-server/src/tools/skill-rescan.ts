/**
 * @fileoverview skill_rescan MCP tool -- re-scan installed skills with current
 * SecurityScanner patterns.
 * @module @skillsmith/mcp-server/tools/skill-rescan
 * @see SMI-3511: GAP-08 No re-scanning of installed skills
 *
 * When new detection patterns are added (SSRF, split-word, homoglyph, etc.),
 * already-installed skills are never re-evaluated. This tool fills that gap
 * by reading installed SKILL.md files and running SecurityScanner against each.
 */

import { z } from 'zod'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { SecurityScanner, QuarantineRepository, type QuarantineSeverity } from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { resolveClientPath } from '@skillsmith/core/install'
import { scanLocalBundleSiblings } from '@skillsmith/core/services/bundled-sibling-scan'
import { parseFrontmatter } from '../indexer/FrontmatterParser.js'

// ============================================================================
// Input / Output types
// ============================================================================

/**
 * Input schema for skill_rescan tool
 */
export const skillRescanInputSchema = z.object({
  /** Optional skill name filter -- rescan only the named skill */
  skillName: z
    .string()
    .min(1)
    .optional()
    .describe('Specific skill directory name to rescan (omit to rescan all installed skills)'),
})

export type SkillRescanInput = z.infer<typeof skillRescanInputSchema>

/**
 * Per-skill rescan result
 */
export interface SkillRescanEntry {
  /** Skill directory name (e.g. "author/skill-name" or "skill-name") */
  skill: string
  /**
   * Whether the scan passed. Reflects the SKILL.md gate (no high/critical
   * findings, risk below threshold) AND the absence of any sibling execution
   * threat (code_execution/obfuscated_directive). Non-execution sibling findings
   * do NOT flip this (SMI-5422 Phase 2 FP-safety).
   */
  passed: boolean
  /** Number of findings */
  findingCount: number
  /** Risk score from 0-100 */
  riskScore: number
  /** Summary of findings by severity */
  severityCounts: {
    critical: number
    high: number
    medium: number
    low: number
  }
  /** Top findings (max 5 per skill to keep output manageable) */
  topFindings: Array<{
    type: string
    severity: string
    message: string
    lineNumber?: number
    /** Relative sibling path when the finding came from a bundled sibling (SMI-5422 Phase 2). */
    location?: string
  }>
  /**
   * SMI-5422 Phase 2: bundled-sibling scan summary. Present only when the skill
   * has scannable siblings or any were dropped/skipped. Surfaces dropped/skipped
   * files so a count/size cap is never a silent omission (CLAUDE.md no-silent-cap).
   */
  bundledSiblings?: {
    scannedFiles: string[]
    rejectableFiles: string[]
    droppedForCount: string[]
    skippedOversize: string[]
    skippedSymlinkEscape: string[]
  }
  /** Error message if skill could not be read */
  error?: string
}

/**
 * Response from skill_rescan tool
 */
export interface SkillRescanResponse {
  /** Number of skills scanned */
  scannedCount: number
  /** Number of skills that failed the scan */
  failedCount: number
  /** Per-skill results */
  results: SkillRescanEntry[]
  /** Error message when a specific skill is not found */
  error?: string
}

// ============================================================================
// Tool schema (MCP tool definition)
// ============================================================================

/**
 * MCP tool definition for skill_rescan
 */
export const skillRescanToolSchema = {
  name: 'skill_rescan' as const,
  description:
    'Re-scan installed skills with the latest security patterns. ' +
    'Detects issues like SSRF instructions, prompt injection, data exfiltration, ' +
    'and other threats that may not have been caught when the skill was originally installed. ' +
    'Run without arguments to scan all installed skills, or specify a skill name to scan one.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillName: {
        type: 'string',
        description:
          'Specific skill directory name to rescan (omit to rescan all installed skills).',
      },
    },
    required: [],
  },
}

// ============================================================================
// Helpers
// ============================================================================

/** Maximum number of top findings to include per skill */
const MAX_FINDINGS_PER_SKILL = 5

/**
 * Map SecurityScanner finding severity counts to a QuarantineSeverity.
 *
 * Critical findings → MALICIOUS (permanent quarantine, confirmed threat)
 * High findings (no critical) → SUSPICIOUS (manual review required)
 * Risk score >= threshold only → RISKY (import with warnings)
 *
 * @see SMI-5358: advisory → quarantine linkage for rescan
 */
export function findingsToQuarantineSeverity(
  hasCritical: boolean,
  hasHigh: boolean
): QuarantineSeverity {
  if (hasCritical) return 'MALICIOUS'
  if (hasHigh) return 'SUSPICIOUS'
  return 'RISKY'
}

/**
 * Discover installed skill directories under ~/.claude/skills/.
 *
 * Skills are installed as either:
 *   - ~/.claude/skills/{skillName}/SKILL.md
 *   - ~/.claude/skills/{author}/{skillName}/SKILL.md
 *
 * Returns an array of { name, skillMdPath } objects.
 */
export async function discoverInstalledSkills(
  skillsDir: string
): Promise<Array<{ name: string; skillMdPath: string }>> {
  const results: Array<{ name: string; skillMdPath: string }> = []

  let entries: string[]
  try {
    entries = await fs.readdir(skillsDir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry)
    const stat = await fs.stat(entryPath).catch(() => null)
    if (!stat?.isDirectory()) continue

    // Check for SKILL.md directly in this directory
    const directSkillMd = join(entryPath, 'SKILL.md')
    const directExists = await fs
      .access(directSkillMd)
      .then(() => true)
      .catch(() => false)

    if (directExists) {
      results.push({ name: entry, skillMdPath: directSkillMd })
      continue
    }

    // Check for author/skill-name subdirectories
    const subEntries = await fs.readdir(entryPath).catch(() => [] as string[])
    for (const subEntry of subEntries) {
      const subPath = join(entryPath, subEntry)
      const subStat = await fs.stat(subPath).catch(() => null)
      if (!subStat?.isDirectory()) continue

      const nestedSkillMd = join(subPath, 'SKILL.md')
      const nestedExists = await fs
        .access(nestedSkillMd)
        .then(() => true)
        .catch(() => false)

      if (nestedExists) {
        results.push({
          name: `${entry}/${subEntry}`,
          skillMdPath: nestedSkillMd,
        })
      }
    }
  }

  return results
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute the skill_rescan tool.
 *
 * Reads installed SKILL.md files from ~/.claude/skills/ and runs
 * SecurityScanner with current patterns against each.
 *
 * When a skill fails the scan (critical/high findings or risk score at or above
 * the quarantine threshold), a QuarantineRepository entry is created using the
 * top findings as the detected patterns and the advisory details as the reason.
 * Severity mapping: critical findings → MALICIOUS, high findings → SUSPICIOUS,
 * risk-score-only failures → RISKY.
 *
 * @see SMI-5358: advisory → quarantine linkage for rescan (gap fix)
 *
 * @param input         Validated tool input
 * @param overrideDir   Optional skills directory override (for testing)
 * @param quarantineRepo Optional QuarantineRepository for persisting quarantine
 *                       entries when findings exceed the threshold (production
 *                       callers pass new QuarantineRepository(toolContext.db))
 * @returns SkillRescanResponse with per-skill scan results
 */
async function executeSkillRescanImpl(
  input: SkillRescanInput,
  overrideDir?: string,
  quarantineRepo?: QuarantineRepository
): Promise<SkillRescanResponse> {
  // SMI-4578: defaults to SKILLSMITH_CLIENT-resolved directory; override
  // wins for ad-hoc rescan of an arbitrary path.
  const skillsDir = overrideDir ?? resolveClientPath()
  const scanner = new SecurityScanner()

  // Discover installed skills
  const installedSkills = await discoverInstalledSkills(skillsDir)

  // Filter to specific skill if requested
  let targetSkills = installedSkills
  if (input.skillName) {
    targetSkills = installedSkills.filter(
      (s) => s.name === input.skillName || s.name.endsWith(`/${input.skillName}`)
    )

    if (targetSkills.length === 0) {
      return {
        scannedCount: 0,
        failedCount: 0,
        results: [],
        error:
          `Skill "${input.skillName}" not found. ` +
          `${installedSkills.length} skill(s) currently installed.`,
      }
    }
  }

  // Scan each skill
  const results: SkillRescanEntry[] = []

  for (const skill of targetSkills) {
    let content: string
    try {
      content = await fs.readFile(skill.skillMdPath, 'utf-8')
    } catch {
      results.push({
        skill: skill.name,
        passed: false,
        findingCount: 0,
        riskScore: 0,
        severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
        topFindings: [],
        error: `Could not read ${skill.skillMdPath}`,
      })
      continue
    }
    const report = scanner.scan(skill.name, content)

    // SMI-5422 Phase 2: also scan sibling bundled files (.mcp.json, settings,
    // package.json lifecycle, config.json, scripts/*.sh). A malicious sibling —
    // not the SKILL.md — quarantines the skill so local search hides it. The
    // sibling rejection is FP-safe: driven only by code_execution/
    // obfuscated_directive (see scanLocalBundleSiblings module header).
    const siblingScan = await scanLocalBundleSiblings(dirname(skill.skillMdPath), scanner)

    const siblingRejected = siblingScan.rejectable

    // Display set = SKILL.md findings + sibling DRIVER findings only. Non-driver
    // sibling findings (e.g. a benign `chmod`/`cp .env` that fires high/critical
    // in a non-markdown file with no doc-context downgrade) are deliberately
    // EXCLUDED so the entry's severityCounts/findingCount/topFindings/riskScore
    // stay consistent with `passed` and never show a contradictory
    // `critical:1, passed:true`. What was scanned/skipped is still surfaced via
    // `bundledSiblings`.
    const displayFindings = [...report.findings, ...siblingScan.rejectableFindings]
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const finding of displayFindings) {
      severityCounts[finding.severity]++
    }

    // Take top findings sorted by severity (critical > high > medium > low)
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
    const sortedFindings = [...displayFindings].sort(
      (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
    )

    const hasSiblingActivity =
      siblingScan.scannedFiles.length > 0 ||
      siblingScan.droppedForCount.length > 0 ||
      siblingScan.skippedOversize.length > 0 ||
      siblingScan.skippedSymlinkEscape.length > 0

    const entry: SkillRescanEntry = {
      skill: skill.name,
      // passed reflects BOTH SKILL.md and sibling execution threats.
      passed: report.passed && !siblingRejected,
      findingCount: displayFindings.length,
      // riskScore is per-source max for display; rejection can be type-driven
      // (a lone code_execution scores < threshold) so consumers MUST NOT gate
      // on riskScore — gate on `passed`. The sibling score is folded in only on
      // rejection so a benign sibling never inflates a passing skill's score.
      riskScore: siblingRejected
        ? Math.max(report.riskScore, siblingScan.maxSiblingRiskScore)
        : report.riskScore,
      severityCounts,
      topFindings: sortedFindings.slice(0, MAX_FINDINGS_PER_SKILL).map((f) => ({
        type: f.type,
        severity: f.severity,
        message: f.message,
        lineNumber: f.lineNumber,
        ...(f.location ? { location: f.location } : {}),
      })),
      ...(hasSiblingActivity
        ? {
            bundledSiblings: {
              scannedFiles: siblingScan.scannedFiles,
              rejectableFiles: siblingScan.rejectableFiles,
              droppedForCount: siblingScan.droppedForCount,
              skippedOversize: siblingScan.skippedOversize,
              skippedSymlinkEscape: siblingScan.skippedSymlinkEscape,
            },
          }
        : {}),
    }
    results.push(entry)

    // SMI-5358: advisory → quarantine linkage.
    // Persist a quarantine entry when the rescan finds over-threshold advisories
    // so that local search (searchLocalSkills) hides the threat and the quarantine
    // dashboard surfaces it.
    //
    // KEY PARITY (SMI-5358 retro): the key MUST equal the LocalIndexer id that
    // searchLocalSkills filters on, which is `local/${frontmatter.name || dirName}`
    // (LocalIndexer is top-level-only; indexLocalSkill derives name the same way).
    // discoverInstalledSkills yields the DIRECTORY name, so a SKILL.md whose
    // `name:` differs from its directory would be quarantined under the wrong key
    // and silently evade the filter. Derive the canonical name from frontmatter
    // first, mirroring LocalIndexer, then fall back to the directory name.
    if ((!report.passed || siblingRejected) && quarantineRepo) {
      const canonicalName = parseFrontmatter(content).name || skill.name
      const skillKey = `local/${canonicalName}`
      // Idempotent: a persistently-failing skill rescanned repeatedly must not
      // accumulate duplicate pending rows (the quarantine table has no
      // UNIQUE(skill_id, source)). Skip if already quarantined; a previously
      // APPROVED entry (isQuarantined === false) still re-quarantines as intended.
      if (!quarantineRepo.isQuarantined(skillKey)) {
        // Quarantine-driving findings: SKILL.md findings only when SKILL.md
        // itself failed, plus the sibling execution-threat drivers. Doc-class
        // siblings are excluded upstream and so can never reach this set (B2).
        const drivingFindings = [
          ...(report.passed ? [] : report.findings),
          ...siblingScan.rejectableFindings,
        ]
        const hasCritical = drivingFindings.some((f) => f.severity === 'critical')
        const hasHigh = drivingFindings.some((f) => f.severity === 'high')
        let quarantineSeverity = findingsToQuarantineSeverity(hasCritical, hasHigh)
        // A lone code_execution finding is only MEDIUM but represents a real
        // remote-fetch-execute threat; floor a sibling-driven quarantine at
        // SUSPICIOUS so it does not land at the mildest dashboard tier.
        if (siblingRejected && quarantineSeverity === 'RISKY') {
          quarantineSeverity = 'SUSPICIOUS'
        }
        // ALL driving types (deduped, not sort/slice-limited) so a lone
        // code_execution cannot be sliced out by higher-severity prose findings.
        const detectedPatterns = [...new Set(drivingFindings.map((f) => f.type))]
        const reasonParts: string[] = []
        if (!report.passed) {
          reasonParts.push(`${report.findings.length} finding(s) in SKILL.md`)
        }
        if (siblingScan.rejectableFiles.length > 0) {
          reasonParts.push(
            `${siblingScan.rejectableFindings.length} finding(s) in ` +
              siblingScan.rejectableFiles.join(', ')
          )
        }
        quarantineRepo.create({
          skillId: skillKey,
          source: 'rescan',
          quarantineReason:
            `Security rescan detected ${reasonParts.join('; ')} ` +
            `(riskScore=${Math.max(report.riskScore, siblingScan.maxSiblingRiskScore)})`,
          severity: quarantineSeverity,
          detectedPatterns,
        })
      }
    }
  }

  const failedCount = results.filter((r) => !r.passed).length

  return {
    scannedCount: results.length,
    failedCount,
    results,
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const executeSkillRescan = withTelemetry(executeSkillRescanImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'skill_rescan',
  extractFramework: () => 'unknown',
})
