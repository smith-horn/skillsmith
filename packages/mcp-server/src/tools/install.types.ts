/**
 * @fileoverview Install Tool Types and Constants
 * @module @skillsmith/mcp-server/tools/install.types
 */

import { z } from 'zod'
import type { ScanReport, ScannerOptions } from '@skillsmith/core'
import type { TrustTier } from '@skillsmith/core'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Trust Tier Validation
// ============================================================================

/**
 * SMI-1533: Valid trust tier values
 * SMI-1809: Added 'local' for local skills
 */
export const VALID_TRUST_TIERS: readonly TrustTier[] = [
  'verified',
  'community',
  'local',
  'experimental',
  'unknown',
]

/**
 * SMI-1533: Validate and normalize trust tier value
 * Returns 'unknown' for invalid or missing values to ensure strictest scanning
 *
 * NOTE: 'verified' tier currently relies on registry data without cryptographic
 * verification. Future enhancement: implement signature verification for
 * Anthropic-verified skills using PKI.
 */
export function validateTrustTier(value: string | null | undefined): TrustTier {
  if (!value) return 'unknown'
  const normalized = value.toLowerCase() as TrustTier
  if (!VALID_TRUST_TIERS.includes(normalized)) return 'unknown'

  // SMI-1533: Log warning for 'verified' tier until PKI is implemented
  if (normalized === 'verified') {
    console.debug(
      '[install] Trust tier "verified" accepted from registry. ' +
        'Note: Cryptographic signature verification not yet implemented.'
    )
  }

  return normalized
}

// ============================================================================
// Scanner Configuration
// ============================================================================

/**
 * SMI-1533: Security scan configuration per trust tier
 * SMI-1809: Added 'local' tier for local skills
 *
 * - verified: Minimal scanning (trust Anthropic-verified skills)
 * - community: Standard scanning (balanced security)
 * - experimental: Aggressive scanning (highest scrutiny for new/beta skills)
 * - unknown: Most aggressive scanning
 * - local: No scanning (user's own local skills)
 */
export const TRUST_TIER_SCANNER_OPTIONS: Record<TrustTier, ScannerOptions> = {
  verified: {
    // Anthropic-verified skills get minimal scanning
    riskThreshold: 70, // Higher threshold - more tolerant
    maxContentLength: 2_000_000, // Allow larger skills
  },
  community: {
    // Standard scanning for community-reviewed skills
    riskThreshold: 40, // Default threshold
    maxContentLength: 1_000_000,
  },
  local: {
    // SMI-1809: Local skills are user's own - minimal scanning
    riskThreshold: 100, // No risk threshold for local skills
    maxContentLength: 10_000_000, // No size limit for local skills
  },
  experimental: {
    // Aggressive scanning for new/beta skills
    riskThreshold: 25, // Lower threshold - less tolerant
    maxContentLength: 500_000, // Limit skill size
  },
  unknown: {
    // Most aggressive scanning for unknown origins
    riskThreshold: 20, // Very strict
    maxContentLength: 250_000, // Very limited size
  },
}

// ============================================================================
// Input/Output Schemas
// ============================================================================

/** Input schema for install tool */
export const installInputSchema = z.object({
  skillId: z.string().min(1).describe('Skill ID or GitHub URL'),
  force: z.boolean().default(false).describe('Force reinstall if exists'),
  skipScan: z.boolean().default(false).describe('Skip security scan (not recommended)'),
  /** SMI-1788: Skip optimization transformation */
  skipOptimize: z.boolean().default(false).describe('Skip Skillsmith optimization'),
})

export type InstallInput = z.infer<typeof installInputSchema>

/** Output type for install tool */
export interface InstallResult {
  success: boolean
  skillId: string
  installPath: string
  securityReport?: ScanReport
  tips?: string[]
  error?: string
  /** SMI-1533: Trust tier used for security scanning */
  trustTier?: TrustTier
  /** SMI-1788: Optimization info (Skillsmith Optimization Layer) */
  optimization?: OptimizationInfo
}

/** Optimization info included in install result */
export interface OptimizationInfo {
  /** Whether skill was optimized */
  optimized: boolean
  /** Sub-skills created (filenames) */
  subSkills?: string[]
  /** Whether companion subagent was generated */
  subagentGenerated?: boolean
  /** Path to generated subagent (if any) */
  subagentPath?: string
  /** Estimated token reduction percentage */
  tokenReductionPercent?: number
  /** Original line count */
  originalLines?: number
  /** Optimized line count */
  optimizedLines?: number
}

// ============================================================================
// Paths
// ============================================================================

export const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')
export const SKILLSMITH_DIR = path.join(os.homedir(), '.skillsmith')
export const MANIFEST_PATH = path.join(SKILLSMITH_DIR, 'manifest.json')

// ============================================================================
// Manifest Types
// ============================================================================

export interface SkillManifest {
  version: string
  installedSkills: Record<
    string,
    {
      id: string
      name: string
      version: string
      source: string
      installPath: string
      installedAt: string
      lastUpdated: string
    }
  >
}

/** Parsed skill ID components */
export interface ParsedSkillId {
  owner: string
  repo: string
  path: string
  isRegistryId: boolean
}

/** Parsed repository URL components */
export interface ParsedRepoUrl {
  owner: string
  repo: string
  path: string
  branch: string
}

/** Registry lookup result */
export interface RegistrySkillInfo {
  repoUrl: string
  name: string
  trustTier: TrustTier
}
