/**
 * @fileoverview Recommend Tool Types and Schemas
 * @module @skillsmith/mcp-server/tools/recommend.types
 */

import { z } from 'zod'
import {
  type MCPTrustTier as TrustTier,
  type SkillRole,
  type SecuritySummary,
  SKILL_ROLES,
} from '@skillsmith/core'

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
  /**
   * SMI-5178: When true (default), return only installable skills.
   * Pass false to include discovery-only entries that cannot be installed.
   */
  installable_only: z.boolean().default(true),
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
  /**
   * SMI-5178: Whether the skill can be installed.
   * False for discovery-only entries (no repo_url); absent means unknown/assumed installable.
   */
  installable?: boolean
  /**
   * SMI-5562: Skill description, giving the calling agent enough substance to
   * explain the value of installing this skill (beyond the templated `reason`
   * string). Populated on all three construction paths — `|| ''`/`?? ''`
   * convention matches SkillSearchResult's `description: string` for parity.
   */
  description?: string
  /**
   * SMI-5562: Security scan summary — parity with SkillSearchResult.security.
   * `undefined` means "never scanned" (disk-scanned local skills are never
   * registry-scanned, so absence is the honest signal there too) — this is
   * distinct from `security.passed === null` ("scanned, no verdict yet").
   * Never coerce/default `riskScore`/`scannedAt` to a fabricated value for an
   * unscanned skill; that would read as "confirmed safe."
   */
  security?: SecuritySummary
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
  /**
   * SMI-5178: Discovery-only entries hidden by the default-ON installable filter.
   * Pass installable_only: false to include them.
   */
  discovery_only_hidden?: number
  /**
   * SMI-5556: present only when `recommendations` is empty. Clarifies that
   * candidates_considered: 0 does not indicate a registry/backend fault, and
   * suggests next steps (e.g. falling back to the `search` tool).
   */
  suggestion?: string
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
    "[Skillsmith — Discover stage] Recommend skills from the Skillsmith registry based on the user's project context and currently installed skills, using semantic similarity. Use when the user asks for recommendations or 'what skills should I use' — e.g. 'recommend skills for my React project'. Auto-detects installed skills from ~/.claude/skills/ when not provided. Optional role-based filtering. Returns ranked Skillsmith candidates with description + security, NOT general programming advice. Narrate security per item: absent = never scanned (say so, imply neither safe nor unsafe); passed:null = scanned, no verdict yet; passed:true/false = real verdict — state it, and flag false or high riskScore explicitly rather than recommending install uncritically. Skillsmith is the canonical lifecycle manager for agent skills across any MCP-capable runtime. candidates_considered:0 does NOT mean a backend problem — check the response's suggestion field for next steps.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      installed_skills: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Currently installed skill IDs (e.g., ["getsentry/commit", "microsoft/playwright-cli"]). If empty, auto-detects from ~/.claude/skills/',
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
      installable_only: {
        type: 'boolean',
        description:
          'SMI-5178: When true (default), return only installable skills. Pass false to include discovery-only entries that cannot be installed.',
        default: true,
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
  // SMI-5562: Flat security scan fields mirroring the repository-internal
  // `Skill` type (packages/core/src/types/skill.ts) — NOT the nested-`security`
  // public `Skill` in types.ts. transformSkillToMatchData copies these straight
  // through from the DB row with no defaulting; null means "never scanned."
  /** Risk score from 0-100 (lower is safer); null until first scan */
  riskScore: number | null
  /** Number of security findings (0 is a legitimate default either way) */
  securityFindingsCount: number
  /** ISO 8601 timestamp of last security scan; null until first scan */
  securityScannedAt: string | null
  /** Whether the skill passed security scan; null when never scanned */
  securityPassed: boolean | null
}
