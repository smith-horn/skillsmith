/**
 * @fileoverview Types for SkillInstallationService
 * @module @skillsmith/core/services/skill-installation.types
 * @see SMI-3483: Wave 0 — Extract SkillInstallationService into core
 *
 * Shared types consumed by both mcp-server and CLI for install/uninstall operations.
 */

import type { ScanReport, ScannerOptions } from '../security/index.js'
import type { TrustTier } from '../types/skill.js'
import type { DependencyDeclaration } from '../types/dependencies.js'

// ============================================================================
// Progress Callback
// ============================================================================

/**
 * Callback invoked during install/uninstall to report progress.
 * CLI wires this to an `ora` spinner; mcp-server wires to MCP notifications.
 */
export type ProgressCallback = (stage: string, detail: string) => void

// ============================================================================
// Install Types
// ============================================================================

/** Action to take when a conflict is detected during skill update */
export type ConflictAction = 'overwrite' | 'merge' | 'cancel'

/** Options for the install operation */
export interface InstallOptions {
  /** Force reinstall if the skill already exists */
  force?: boolean
  /** Skip security scan (not recommended) */
  skipScan?: boolean
  /** Skip Skillsmith optimization (decomposition, subagent generation) */
  skipOptimize?: boolean
  /** Action to take when local modifications are detected */
  conflictAction?: ConflictAction
  /** SMI-3863: User has confirmed they want to install despite security warnings */
  confirmed?: boolean
}

/** Dependency intelligence result from an install */
export interface DepIntelResult {
  /** Inferred MCP server names from skill content */
  dep_inferred_servers: string[]
  /** Declared dependency block from frontmatter (if present) */
  dep_declared: DependencyDeclaration | undefined
  /** Warnings about MCP servers referenced but not configured */
  dep_warnings: string[]
}

/** Optimization metadata included in install result */
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

/** Result of an install operation */
export interface InstallResult {
  success: boolean
  skillId: string
  installPath: string
  securityReport?: ScanReport
  tips?: string[]
  error?: string
  /** Trust tier used for security scanning */
  trustTier?: TrustTier
  /** Optimization info (Skillsmith Optimization Layer) */
  optimization?: OptimizationInfo
  /** Path to backup file created during conflict resolution */
  backupPath?: string
  /** Dependency intelligence extracted during install */
  depIntel?: DepIntelResult
  /** Whether fetched content hash differs from indexed content hash */
  contentHashMismatch?: boolean
  /** SMI-3864: Computed quality score (0-1) */
  qualityScore?: number
  /** SMI-3863: True when the skill requires user confirmation before install */
  requiresConfirmation?: boolean
  /** SMI-3863: Human-readable reason why confirmation is needed */
  confirmationReason?: string
  /** SMI-3871: Dependency identifiers that are quarantined */
  quarantinedDeps?: string[]
}

/** SMI-3871: Quarantine status for dependency cross-check. */
export type QuarantineStatus = 'pending' | 'rejected'

export interface AiDefenceFeedback {
  recordFeedback(params: {
    input: string
    wasAccurate: boolean
    verdict: string
    threatType?: string
    mitigation?: 'block' | 'warn' | 'log'
    mitigationSuccess?: boolean
  }): Promise<void>
}

// ============================================================================
// Uninstall Types
// ============================================================================

/** Options for the uninstall operation */
export interface UninstallOptions {
  /** Force removal even if skill has been modified since installation */
  force?: boolean
}

/** Result of an uninstall operation */
export interface UninstallResult {
  success: boolean
  skillName: string
  message: string
  removedPath?: string
  warning?: string
}

// ============================================================================
// Manifest Types (shared)
// ============================================================================

/** Entry for a single installed skill in the manifest */
export interface SkillManifestEntry {
  id: string
  name: string
  version: string
  source: string
  /**
   * Absolute path where the skill is installed.
   * Required by type, but runtime JSON may omit it -- consumers must guard.
   */
  installPath: string
  installedAt: string
  lastUpdated: string
  /** SHA-256 hash of SKILL.md at install time for modification detection */
  originalContentHash?: string
  /** SHA-256 hash of the content at last update */
  contentHash?: string
  /** Pinned semver */
  pinnedVersion?: string
  /** How updates are handled */
  updatePolicy?: 'auto' | 'manual' | 'never'
}

/** Manifest tracking all installed skills */
export interface SkillManifest {
  version: string
  installedSkills: Record<string, SkillManifestEntry>
}

// ============================================================================
// Registry Types
// ============================================================================

/** Result from a registry skill lookup */
export interface RegistrySkillInfo {
  repoUrl: string
  name: string
  trustTier: TrustTier
  /** Whether the skill has been quarantined */
  quarantined?: boolean
  /** SHA-256 hash of SKILL.md at index time for tamper detection */
  contentHash?: string
}

/**
 * Abstraction for looking up skills in the registry.
 * mcp-server provides the API-first implementation; CLI may provide a simpler one.
 */
export interface RegistryLookup {
  /**
   * Look up a skill by its ID (e.g. "author/name" or UUID).
   * Returns null if the skill is not found or has no installation source.
   */
  lookup(skillId: string): Promise<RegistrySkillInfo | null>
}

/**
 * Abstraction for recording co-install sessions.
 * mcp-server provides the real implementation; CLI may skip or stub this.
 */
export interface CoInstallRecorder {
  recordSessionCoInstalls(skillIds: string[]): void
}

// ============================================================================
// Scanner Config
// ============================================================================

/** Security scan configuration per trust tier */
export const TRUST_TIER_SCANNER_OPTIONS: Record<TrustTier, ScannerOptions> = {
  verified: {
    riskThreshold: 70,
    maxContentLength: 2_000_000,
  },
  curated: {
    riskThreshold: 60,
    maxContentLength: 2_000_000,
  },
  community: {
    riskThreshold: 40,
    maxContentLength: 1_000_000,
  },
  local: {
    riskThreshold: 100,
    maxContentLength: 10_000_000,
  },
  experimental: {
    riskThreshold: 25,
    maxContentLength: 500_000,
  },
  unknown: {
    riskThreshold: 20,
    maxContentLength: 250_000,
  },
}
