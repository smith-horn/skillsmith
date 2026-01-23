/**
 * @fileoverview Recommend Tool Types and Schemas
 * @module @skillsmith/mcp-server/tools/recommend.types
 */

import { z } from 'zod'
import { type MCPTrustTier as TrustTier, type SkillRole, SKILL_ROLES } from '@skillsmith/core'

// ============================================================================
// Input Schema
// ============================================================================

/**
 * SMI-1631: Type-safe Zod schema for skill roles
 */
export const skillRoleSchema = z.enum([
  'code-quality',
  'testing',
  'documentation',
  'workflow',
  'security',
  'development-partner',
] as const)

/**
 * Zod schema for recommend tool input validation
 */
export const recommendInputSchema = z.object({
  /** Currently installed skill IDs */
  installed_skills: z.array(z.string()).min(0).default([]),
  /** Optional project description for context-aware recommendations */
  project_context: z.string().optional(),
  /** Maximum recommendations to return (default 5) */
  limit: z.number().min(1).max(50).default(5),
  /** Enable overlap detection (default true) */
  detect_overlap: z.boolean().default(true),
  /** Minimum similarity threshold (0-1, default 0.3) */
  min_similarity: z.number().min(0).max(1).default(0.3),
  /** SMI-1631: Filter by skill role for targeted recommendations */
  role: skillRoleSchema.optional(),
})

/**
 * Input type (before parsing, allows optional fields)
 */
export type RecommendInput = z.input<typeof recommendInputSchema>

// ============================================================================
// Response Types
// ============================================================================

/**
 * Individual skill recommendation with reasoning
 */
export interface SkillRecommendation {
  /** Skill identifier */
  skill_id: string
  /** Skill name */
  name: string
  /** Why this skill is recommended */
  reason: string
  /** Semantic similarity score (0-1) */
  similarity_score: number
  /** Trust tier for user confidence */
  trust_tier: TrustTier
  /** Overall quality score */
  quality_score: number
  /** SMI-1631: Skill roles for role-based filtering */
  roles?: SkillRole[]
}

/**
 * Recommendation response with timing info
 */
export interface RecommendResponse {
  /** List of recommended skills */
  recommendations: SkillRecommendation[]
  /** Total candidates considered */
  candidates_considered: number
  /** Skills filtered due to overlap */
  overlap_filtered: number
  /** SMI-1631: Skills filtered due to role mismatch */
  role_filtered: number
  /** Query context used for matching */
  context: {
    installed_count: number
    has_project_context: boolean
    using_semantic_matching: boolean
    /** SMI-906: Whether installed skills were auto-detected from ~/.claude/skills/ */
    auto_detected: boolean
    /** SMI-1631: Role filter applied */
    role_filter?: SkillRole
  }
  /** Performance timing */
  timing: {
    totalMs: number
  }
}

// ============================================================================
// Tool Schema
// ============================================================================

/**
 * MCP tool schema definition for skill_recommend
 */
export const recommendToolSchema = {
  name: 'skill_recommend',
  description:
    'Recommend skills based on currently installed skills and optional project context. Uses semantic similarity to find relevant skills. Auto-detects installed skills from ~/.claude/skills/ if not provided. SMI-1631: Supports role-based filtering for targeted recommendations.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      installed_skills: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Currently installed skill IDs (e.g., ["anthropic/commit", "community/jest-helper"]). If empty, auto-detects from ~/.claude/skills/',
      },
      project_context: {
        type: 'string',
        description:
          'Optional project description for context-aware recommendations (e.g., "React frontend with Jest testing")',
      },
      limit: {
        type: 'number',
        description: 'Maximum recommendations to return (default 5, max 50)',
        minimum: 1,
        maximum: 50,
        default: 5,
      },
      detect_overlap: {
        type: 'boolean',
        description: 'Enable overlap detection to filter similar skills (default true)',
        default: true,
      },
      min_similarity: {
        type: 'number',
        description: 'Minimum similarity threshold (0-1, default 0.3)',
        minimum: 0,
        maximum: 1,
        default: 0.3,
      },
      role: {
        type: 'string',
        enum: [...SKILL_ROLES],
        description:
          'SMI-1631: Filter by skill role (code-quality, testing, documentation, workflow, security, development-partner). Skills matching the role get a +30 score boost.',
      },
    },
    required: [],
  },
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Skill data format for matching operations
 * Transformed from database Skill records
 */
export interface SkillData {
  /** Unique skill identifier */
  id: string
  /** Skill display name */
  name: string
  /** Skill description */
  description: string
  /** Trigger phrases for overlap detection (derived from tags) */
  triggerPhrases: string[]
  /** Keywords for matching (from tags) */
  keywords: string[]
  /** Quality score (0-100) */
  qualityScore: number
  /** Trust tier */
  trustTier: TrustTier
  /** SMI-1631: Skill roles for role-based filtering */
  roles: SkillRole[]
  /** SMI-1632: Whether this is an installable skill (vs a collection) */
  installable: boolean
}
