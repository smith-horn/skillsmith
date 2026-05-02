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
import { join } from 'path'
import { SecurityScanner } from '@skillsmith/core'
import { resolveClientPath } from '@skillsmith/core/install'

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
  /** Whether the scan passed (no high/critical findings, risk below threshold) */
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
  }>
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
 * @param input       Validated tool input
 * @param overrideDir Optional skills directory override (for testing)
 * @returns SkillRescanResponse with per-skill scan results
 */
export async function executeSkillRescan(
  input: SkillRescanInput,
  overrideDir?: string
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

    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const finding of report.findings) {
      severityCounts[finding.severity]++
    }

    // Take top findings sorted by severity (critical > high > medium > low)
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
    const sortedFindings = [...report.findings].sort(
      (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
    )

    results.push({
      skill: skill.name,
      passed: report.passed,
      findingCount: report.findings.length,
      riskScore: report.riskScore,
      severityCounts,
      topFindings: sortedFindings.slice(0, MAX_FINDINGS_PER_SKILL).map((f) => ({
        type: f.type,
        severity: f.severity,
        message: f.message,
        lineNumber: f.lineNumber,
      })),
    })
  }

  const failedCount = results.filter((r) => !r.passed).length

  return {
    scannedCount: results.length,
    failedCount,
    results,
  }
}
