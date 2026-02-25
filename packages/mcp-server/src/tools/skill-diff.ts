/**
 * @fileoverview skill_diff MCP tool — section-level diff between skill versions
 * @module @skillsmith/mcp-server/tools/skill-diff
 * @see SMI-skill-version-tracking Wave 2
 *
 * Returns a structured JSON diff of heading-level (H2/H3) sections between
 * the locally-installed SKILL.md and the latest version recorded in the
 * skill_versions table. Avoids raw unified diffs — human language is used
 * for section names instead.
 *
 * Tier gate: Individual (version_tracking feature flag).
 */

import { z } from 'zod'
import { classifyChange, computeUpdateRisk } from '@skillsmith/core'
import type { ToolContext } from '../context.js'

// ============================================================================
// Input / Output types
// ============================================================================

/** Input schema for skill_diff tool */
export const skillDiffInputSchema = z.object({
  skillId: z.string().min(1).describe('Registry skill identifier (e.g. "author/skill-name")'),
  oldContent: z.string().min(1).describe('Previous SKILL.md content'),
  newContent: z.string().min(1).describe('Updated SKILL.md content'),
  oldRiskScore: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Risk score of the old version (0–100)'),
  newRiskScore: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Risk score of the new version (0–100)'),
  hasLocalModifications: z
    .boolean()
    .default(false)
    .describe('Whether the installed skill has local edits'),
  trustTier: z
    .enum(['verified', 'community', 'experimental'])
    .default('community')
    .describe('Registry trust tier'),
})

export type SkillDiffInput = z.infer<typeof skillDiffInputSchema>

/** Structured section-level diff response */
export interface SkillDiffResponse {
  skill: string
  changeType: 'major' | 'minor' | 'patch' | 'unknown'
  sectionsAdded: string[]
  sectionsRemoved: string[]
  sectionsModified: string[]
  riskScoreDelta: number | null
  changelog: string | null
  recommendation: 'auto-update' | 'review-then-update' | 'manual-review-required'
}

// ============================================================================
// Tool schema (MCP tool definition)
// ============================================================================

export const skillDiffToolSchema = {
  name: 'skill_diff' as const,
  description:
    'Show a section-level diff between two versions of an installed skill. ' +
    'Returns added, removed, and modified headings along with a change type ' +
    '(major/minor/patch) and update recommendation. ' +
    'Requires Individual tier or higher (version_tracking feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillId: {
        type: 'string',
        description: 'Registry skill identifier (e.g. "author/skill-name")',
      },
      oldContent: {
        type: 'string',
        description: 'Previous SKILL.md content',
      },
      newContent: {
        type: 'string',
        description: 'Updated SKILL.md content',
      },
      oldRiskScore: {
        type: 'number',
        description: 'Risk score of the old version (0–100)',
      },
      newRiskScore: {
        type: 'number',
        description: 'Risk score of the new version (0–100)',
      },
      hasLocalModifications: {
        type: 'boolean',
        description: 'Whether the installed skill has local edits',
      },
      trustTier: {
        type: 'string',
        enum: ['verified', 'community', 'experimental'],
        description: 'Registry trust tier',
      },
    },
    required: ['skillId', 'oldContent', 'newContent'],
  },
}

// ============================================================================
// Heading extraction (local — same algorithm as change-classifier)
// ============================================================================

function extractHeadings(content: string): Map<string, string> {
  const headings = new Map<string, string>()
  for (const line of content.split('\n')) {
    const m = /^#{2,3}\s+(.+)/.exec(line)
    if (m) {
      const title = m[1].trim()
      headings.set(title.toLowerCase(), title)
    }
  }
  return headings
}

// ============================================================================
// Changelog extraction
// ============================================================================

/**
 * Extract changelog text from frontmatter or from a ## Changelog section.
 * Returns null if none found.
 */
function extractChangelog(content: string): string | null {
  // Frontmatter: changelog: "some text"
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx !== -1) {
        const key = line.slice(0, colonIdx).trim().toLowerCase()
        const value = line.slice(colonIdx + 1).trim()
        if (key === 'changelog' && value) return value.replace(/^["']|["']$/g, '')
      }
    }
  }

  // Body: lines under ## Changelog / ## Change Log
  const lines = content.split('\n')
  let inSection = false
  const sectionLines: string[] = []

  for (const line of lines) {
    if (/^#{1,3}\s+change[\s-]?log/i.test(line)) {
      inSection = true
      continue
    }
    if (inSection && /^#{1,3}\s+/.test(line)) break
    if (inSection && line.trim()) sectionLines.push(line.trim())
  }

  return sectionLines.length > 0 ? sectionLines.slice(0, 5).join(' ') : null
}

// ============================================================================
// Section-body comparison
// ============================================================================

/**
 * Determine which sections (present in both old and new) have changed body
 * content. Returns section titles (canonical form) that were modified.
 */
function detectModifiedSections(oldContent: string, newContent: string): string[] {
  const oldSectionBodies = extractSectionBodies(oldContent)
  const newSectionBodies = extractSectionBodies(newContent)
  const modified: string[] = []

  for (const [key, oldBody] of oldSectionBodies) {
    const newBody = newSectionBodies.get(key)
    if (newBody !== undefined && newBody !== oldBody) {
      modified.push(key)
    }
  }
  return modified
}

/** Build a map of heading (lowercase) → body text */
function extractSectionBodies(content: string): Map<string, string> {
  const result = new Map<string, string>()
  const lines = content.split('\n')
  let currentHeading: string | null = null
  const bodyLines: string[] = []

  const flush = () => {
    if (currentHeading !== null) {
      result.set(currentHeading, bodyLines.join('\n').trim())
      bodyLines.length = 0
    }
  }

  for (const line of lines) {
    const m = /^#{2,3}\s+(.+)/.exec(line)
    if (m) {
      flush()
      currentHeading = m[1].trim().toLowerCase()
    } else if (currentHeading !== null) {
      bodyLines.push(line)
    }
  }
  flush()
  return result
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute the skill_diff tool.
 *
 * Computes a section-level diff using heading analysis and delegates change
 * classification and risk scoring to core utilities.
 *
 * @param input   Validated tool input
 * @param _context Tool context (unused — diff is purely content-based)
 * @returns SkillDiffResponse with section diff and risk recommendation
 */
export async function executeSkillDiff(
  input: SkillDiffInput,
  _context: ToolContext
): Promise<SkillDiffResponse> {
  const validated = skillDiffInputSchema.parse(input)
  const {
    skillId,
    oldContent,
    newContent,
    oldRiskScore,
    newRiskScore,
    hasLocalModifications,
    trustTier,
  } = validated

  // Heading analysis
  const oldHeadings = extractHeadings(oldContent)
  const newHeadings = extractHeadings(newContent)

  const sectionsRemoved = [...oldHeadings.values()].filter((t) => !newHeadings.has(t.toLowerCase()))
  const sectionsAdded = [...newHeadings.values()].filter((t) => !oldHeadings.has(t.toLowerCase()))
  const sectionsModified = detectModifiedSections(oldContent, newContent)

  // Change classification
  const changeType = classifyChange(oldContent, newContent, oldRiskScore, newRiskScore)

  // Risk scoring
  const riskScoreDelta =
    typeof oldRiskScore === 'number' && typeof newRiskScore === 'number'
      ? newRiskScore - oldRiskScore
      : null

  const { recommendation } = computeUpdateRisk({
    changeType,
    riskScoreDelta: riskScoreDelta ?? undefined,
    hasLocalModifications,
    trustTier,
    hasChangelog: extractChangelog(newContent) !== null,
  })

  const changelog = extractChangelog(newContent)

  return {
    skill: skillId,
    changeType,
    sectionsAdded,
    sectionsRemoved,
    sectionsModified,
    riskScoreDelta,
    changelog,
    recommendation,
  }
}

// ============================================================================
// Format (for CLI / text output)
// ============================================================================

/**
 * Format a SkillDiffResponse as human-readable text
 */
export function formatSkillDiffResults(response: SkillDiffResponse): string {
  const lines: string[] = []

  lines.push(`\n=== Skill Diff: ${response.skill} ===\n`)
  lines.push(`Change type: ${response.changeType.toUpperCase()}`)
  lines.push(`Recommendation: ${response.recommendation}`)

  if (response.riskScoreDelta !== null) {
    const prefix = response.riskScoreDelta > 0 ? '+' : ''
    lines.push(`Risk score delta: ${prefix}${response.riskScoreDelta}`)
  }

  if (response.sectionsAdded.length > 0) {
    lines.push('\nSections added:')
    for (const s of response.sectionsAdded) lines.push(`  + ${s}`)
  }

  if (response.sectionsRemoved.length > 0) {
    lines.push('\nSections removed:')
    for (const s of response.sectionsRemoved) lines.push(`  - ${s}`)
  }

  if (response.sectionsModified.length > 0) {
    lines.push('\nSections modified:')
    for (const s of response.sectionsModified) lines.push(`  ~ ${s}`)
  }

  if (response.changelog) {
    lines.push(`\nChangelog: ${response.changelog}`)
  }

  return lines.join('\n')
}
