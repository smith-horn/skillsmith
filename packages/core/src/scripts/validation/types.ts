/**
 * SMI-863: Type definitions for skill validation
 */

import { z } from 'zod'

// ============================================================================
// Configuration
// ============================================================================

export const CONFIG = {
  /** Default input file path */
  DEFAULT_INPUT: './data/skills.json',
  /** Default output directory */
  DEFAULT_OUTPUT_DIR: './data',
  /** Semantic similarity threshold for duplicate detection */
  SIMILARITY_THRESHOLD: 0.85,
  /** Source priority scores */
  SOURCE_PRIORITY: {
    'anthropic-official': 100,
    github: 80,
    'claude-plugins': 40,
    unknown: 0,
  } as Record<string, number>,
  /** Valid trust tiers */
  VALID_TRUST_TIERS: ['verified', 'community', 'experimental', 'unknown'] as const,
} as const

// ============================================================================
// Type Definitions
// ============================================================================

export type TrustTier = (typeof CONFIG.VALID_TRUST_TIERS)[number]

/** Raw skill input that may have missing or invalid fields */
export interface RawSkillInput {
  id?: string
  name?: string
  description?: string | null
  author?: string | null
  repo_url?: string | null
  repoUrl?: string | null
  quality_score?: number | null
  qualityScore?: number | null
  trust_tier?: string | null
  trustTier?: string | null
  tags?: string[]
  source?: string
  stars?: number
  [key: string]: unknown
}

/** Validated skill with all required fields */
export interface ValidatedSkill {
  id: string
  name: string
  description: string
  author: string
  repo_url: string | null
  quality_score: number
  trust_tier: TrustTier
  tags: string[]
  source: string
}

/** Validation error for a single field */
export interface ValidationFieldError {
  field: string
  message: string
  value?: unknown
}

/** Result of validating a single skill */
export interface SkillValidationResult {
  valid: boolean
  skill: ValidatedSkill | null
  original: RawSkillInput
  errors: ValidationFieldError[]
  warnings: string[]
  fixes: string[]
}

/** Duplicate detection result */
export interface DuplicateEntry {
  kept: ValidatedSkill
  discarded: ValidatedSkill
  reason: 'repo_url' | 'semantic_similarity'
  similarity?: number
}

/** Overall validation report */
export interface ValidationReport {
  timestamp: string
  summary: {
    total_input: number
    valid_skills: number
    invalid_skills: number
    duplicates_removed: number
    auto_fixes_applied: number
    errors_by_field: Record<string, number>
  }
  errors: Array<{
    skill_id: string | undefined
    skill_name: string | undefined
    errors: ValidationFieldError[]
  }>
  warnings: Array<{
    skill_id: string | undefined
    skill_name: string | undefined
    warnings: string[]
  }>
  fixes: Array<{
    skill_id: string | undefined
    skill_name: string | undefined
    fixes: string[]
  }>
}

/** Duplicates report */
export interface DuplicatesReport {
  timestamp: string
  summary: {
    total_duplicates: number
    by_repo_url: number
    by_semantic_similarity: number
  }
  duplicates: DuplicateEntry[]
}

// ============================================================================
// Zod Schema for Validation
// ============================================================================

export const TrustTierSchema = z.enum(CONFIG.VALID_TRUST_TIERS)

export const ValidatedSkillSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[^/]+\/[^/]+$/, 'ID must be in format author/name'),
  name: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1),
  repo_url: z.string().url().nullable(),
  quality_score: z.number().min(0).max(100),
  trust_tier: TrustTierSchema,
  tags: z.array(z.string()),
  source: z.string().min(1),
})
