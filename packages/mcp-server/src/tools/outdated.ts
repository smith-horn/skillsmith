/**
 * @fileoverview skill_outdated MCP tool — check installed skills for updates and dependency status
 * @module @skillsmith/mcp-server/tools/outdated
 * @see SMI-3138: Wave 5 — Dependency intelligence outdated tool
 *
 * Reads the local manifest (~/.skillsmith/manifest.json), hashes each installed
 * SKILL.md, and compares against the latest content hash in skill_versions.
 * Optionally includes dependency satisfaction status from skill_dependencies.
 *
 * Tier gate: Community (null feature flag — no license required).
 *
 * Hash display: truncated to 8 chars for human readability (full hash stored).
 */

import { z } from 'zod'

// ============================================================================
// Input / Output types
// ============================================================================

/**
 * Input schema for skill_outdated tool
 */
export const outdatedInputSchema = z.object({
  /** Include dependency satisfaction status in results (default: true) */
  include_deps: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include dependency satisfaction status (default: true)'),
})

export type OutdatedInput = z.infer<typeof outdatedInputSchema>

/**
 * Dependency satisfaction details for a single skill
 */
export interface DependencyStatus {
  total: number
  satisfied: string[]
  missing: string[]
}

/**
 * SMI-6343 (Wave 3, H6): structured, machine-readable companion to the
 * free-text `hint`. `skill_outdated` has zero renderers anywhere in this
 * repo (verified — see `outdated.identity.ts`'s doc comment), so this MCP
 * JSON response is the tool's entire v1 user-facing surface; the field
 * names and copy ARE the UX.
 */
export interface OutdatedDiagnosis {
  state: 'current' | 'outdated' | 'local-drift' | 'identity-mismatch' | 'unknown'
  /** Which contradiction signal fired. Null for non-identity-mismatch states. */
  signal: 'owner-mismatch' | 'frontmatter-contradiction' | 'path-unresolved' | null
  /** Why the state could not be determined. Null unless state is 'unknown'. */
  inconclusiveReason:
    | 'offline'
    | 'quota-exhausted'
    | 'network-error'
    | 'no-registry-record'
    | 'no-history'
    | null
  /** One sentence, addressed to the caller. */
  summary: string
  /** The exact next action, naming a real tool call. Null when none is needed. */
  remediation: string | null
  /** Whether a bulk/--all update may include this entry. */
  safeToBulkUpdate: boolean
}

/**
 * Per-skill outdated information returned by the tool
 */
export interface OutdatedSkillInfo {
  /** Registry skill identifier (e.g. "author/skill-name") */
  id: string
  /** 8-char prefix of the locally-installed content hash */
  installed_hash: string
  /** 8-char prefix of the latest registry hash */
  latest_hash: string
  /**
   * SMI-6343 (Wave 3): widened from `current | outdated | unknown` to a
   * five-state classification separating a genuine version bump
   * (`outdated`) from a benign local edit (`local-drift`) and a corrupted
   * recorded identity (`identity-mismatch`) — see `diagnosis` for the
   * structured explanation. SMI-6530 containment: `outdated` is no longer
   * marked safe to bulk-update (see `diagnosis.safeToBulkUpdate`) until the
   * update eligibility gate (SMI-6532) ships.
   */
  status: 'current' | 'outdated' | 'local-drift' | 'identity-mismatch' | 'unknown'
  /** Semver from the latest version record, if available */
  semver: string | null
  /** Dependency satisfaction details (omitted when include_deps is false) */
  dependencies?: DependencyStatus
  /** SMI-6343 (Wave 3): structured classification, additive alongside `hint`. */
  diagnosis: OutdatedDiagnosis
  /**
   * SMI-5407: present when manifest entry lacks a `source` URL. SMI-6343
   * (H1): also present, taking precedence, when `status === 'unknown'`
   * because the live registry check was skipped (offline) or stopped
   * (quota exhausted). `diagnosis` (above) is the spec'd structured carrier
   * of this same information as of Wave 3; `hint` is unchanged, not removed.
   */
  hint?: string
}

/**
 * Summary counts for the outdated check
 */
export interface OutdatedSummary {
  total_installed: number
  outdated: number
  up_to_date: number
  unknown: number
  missing_deps: number
  /** SMI-6343 (Wave 3): entries with a benign local edit, excluded from bulk update. */
  local_drift: number
  /** SMI-6343 (Wave 3): entries whose recorded identity contradicts what's on disk. */
  identity_mismatch: number
}

/**
 * Response from skill_outdated tool
 */
export interface OutdatedResponse {
  skills: OutdatedSkillInfo[]
  summary: OutdatedSummary
}

// ============================================================================
// Tool schema (MCP tool definition)
// ============================================================================

/**
 * MCP tool definition for skill_outdated
 */
export const outdatedToolSchema = {
  name: 'skill_outdated' as const,
  description:
    'Check installed skills for available updates and dependency satisfaction status. ' +
    'Reads the local manifest, hashes each installed SKILL.md, and compares against the ' +
    'latest registry state. Community tier — no license required.',
  title: 'Check Outdated Skills',
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      include_deps: {
        type: 'boolean',
        description: 'Include dependency satisfaction status (default: true)',
      },
    },
    required: [],
  },
}

// SMI-6532: the executeOutdatedImpl implementation and the withTelemetry-wrapped
// executeOutdated export now live in outdated.action.ts — re-exported here
// unchanged, matching the rbac-tools.ts / sso-tools.ts split convention (SMI-5127
// / SMI-6200 Wave 4 Step 0) so every existing caller keeps importing from this
// thin file. See outdated.action.ts's own header for the split rationale.
export { executeOutdated } from './outdated.action.js'
