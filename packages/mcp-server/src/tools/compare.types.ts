/**
 * Compare Tool Types and Schemas
 * @module @skillsmith/mcp-server/tools/compare.types
 */

import { z } from 'zod'
import type { MCPSkill as Skill, MCPTrustTier as TrustTier, ScoreBreakdown } from '@skillsmith/core'

/**
 * Zod schema for compare tool input validation
 */
export const compareInputSchema = z.object({
  /** First skill ID to compare */
  skill_a: z.string().min(1, 'skill_a is required'),
  /** Second skill ID to compare */
  skill_b: z.string().min(1, 'skill_b is required'),
})

/**
 * Input type derived from Zod schema
 */
export type CompareInput = z.infer<typeof compareInputSchema>

/**
 * Summary of a skill for comparison
 */
export interface SkillSummary {
  /** Skill identifier */
  id: string
  /** Skill name */
  name: string
  /** Brief description */
  description: string
  /** Author */
  author: string
  /** Quality score (0-100) */
  quality_score: number
  /** Score breakdown by category */
  score_breakdown: ScoreBreakdown | null
  /** Trust tier */
  trust_tier: TrustTier
  /** Category */
  category: string
  /** Tags */
  tags: string[]
  /** Version if available */
  version: string | null
  /** Dependencies */
  dependencies: string[]
}

/**
 * Difference between skills
 */
export interface SkillDifference {
  /** Field being compared */
  field: string
  /** Value from skill A */
  a_value: unknown
  /** Value from skill B */
  b_value: unknown
  /** Winner if applicable */
  winner?: 'a' | 'b' | 'tie'
}

/**
 * Comparison response
 */
export interface CompareResponse {
  /** Summaries of both skills */
  comparison: {
    a: SkillSummary
    b: SkillSummary
  }
  /** List of differences between skills */
  differences: SkillDifference[]
  /** Recommendation text */
  recommendation: string
  /** Overall winner if determinable */
  winner: 'a' | 'b' | 'tie'
  /** Performance timing */
  timing: {
    totalMs: number
  }
}

/**
 * MCP tool schema definition for skill_compare
 */
export const compareToolSchema = {
  name: 'skill_compare',
  description:
    'Compare two skills side-by-side. Analyzes quality scores, trust tiers, features, and dependencies to provide a recommendation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skill_a: {
        type: 'string',
        description: 'First skill ID to compare (e.g., "community/jest-helper")',
      },
      skill_b: {
        type: 'string',
        description: 'Second skill ID to compare (e.g., "community/vitest-helper")',
      },
    },
    required: ['skill_a', 'skill_b'],
  },
}

/**
 * Extended skill type with comparison metadata
 */
export type ExtendedSkill = Skill & { dependencies: string[]; features: string[] }

/**
 * Trust tier ranking for comparison
 * SMI-1809: Added 'local' tier for local skills
 */
export const TRUST_TIER_RANK: Record<TrustTier, number> = {
  verified: 4,
  community: 3,
  local: 3, // SMI-1809: Local skills rank same as community (user trusts their own skills)
  experimental: 2,
  unknown: 1,
}

/**
 * Database skill record type
 */
export interface DbSkillRecord {
  id: string
  name: string
  description: string | null
  author: string | null
  repoUrl: string | null
  qualityScore: number | null
  trustTier: string
  tags: string[]
  createdAt: string
  updatedAt: string
}
