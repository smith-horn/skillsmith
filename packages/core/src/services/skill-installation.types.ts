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
import type { ClientId } from '../install/paths.js'

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

/**
 * SMI-5905: a packaged skill's files as a flat { relativePath: fileText } map,
 * e.g. `{ "SKILL.md": "...", "scripts/foo.sh": "..." }`.
 *
 * Deliberately duplicated (not imported) from the mcp-server's own
 * `SkillContent` (zod-inferred in `registry-tools.ts`) — core cannot depend
 * on mcp-server. Keep the shape in sync if it ever changes.
 */
export type SkillContent = Record<string, string>

/**
 * Options for `installFromContent()` — the content-based install path used by
 * private-registry installs (SMI-5905). Distinct from `InstallOptions` (used
 * by the GitHub-fetch `install()` path): the caller has already resolved
 * `skillId`/`version`/`content` (e.g. via a registry `getContent()` call one
 * layer up) rather than supplying a skillId for `install()` to resolve itself.
 */
export interface InstallFromContentOptions {
  /** Registry skill ID (author/name format) this content was published under. */
  skillId: string
  /**
   * Already-resolved semver version string. `installFromContent()` does not
   * choose a version itself — the caller resolves "no version specified"
   * (defaulting to the most-recently-published version) before calling this,
   * mirroring `registry-tools.live.ts`'s `get(teamId, skillId, version)`
   * convention, so `install` and `get` never disagree about what "no
   * version specified" means.
   */
  version: string
  /** Packaged skill files; must include a non-empty `"SKILL.md"` entry. */
  content: SkillContent
  /** Force reinstall if the skill is already installed (mirrors `InstallOptions.force`). */
  force?: boolean
}

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

/**
 * SMI-4795: Coarse error-code taxonomy for failed install events.
 *
 * Each code maps to a specific `success: false` return path inside
 * SkillInstallationService.install(). The taxonomy is intentionally narrow —
 * it should be cardinality-bounded enough for telemetry funnel analysis and
 * stable across releases. Adding a new code requires (a) a real new failure
 * return path and (b) updating downstream funnel queries.
 */
export type InstallErrorCode =
  | 'REGISTRY_LOOKUP_UNAVAILABLE' // Registry ID supplied but no registry-lookup adapter configured
  | 'REGISTRY_SKILL_NOT_FOUND' // Registry lookup returned null (no installable repo_url)
  | 'QUARANTINED' // Skill is quarantined per registry metadata
  | 'ALREADY_INSTALLED' // Skill present in manifest and force=false
  | 'FETCH_FAILED' // SKILL.md fetch from GitHub failed
  | 'VALIDATION_FAILED' // SKILL.md missing required frontmatter / too short
  | 'SKIP_SCAN_FORBIDDEN' // skipScan requested but trust tier disallows it
  | 'SCAN_REJECTED' // Security scan returned non-passing report
  | 'CONFIRMATION_REQUIRED' // Experimental/unknown registry skill needs confirmed=true
  | 'INVALID_CONTENT' // SMI-5905: installFromContent() content shape/path-safety rejected
  | 'UNKNOWN' // Unhandled exception caught by outer try/catch

/** Result of an install operation */
export interface InstallResult {
  success: boolean
  skillId: string
  installPath: string
  securityReport?: ScanReport
  tips?: string[]
  error?: string
  /**
   * SMI-4795: Coarse machine-readable failure code, populated at every
   * `success: false` return path. Always undefined when `success: true`.
   * Used by install-telemetry funnel; see {@link InstallErrorCode}.
   */
  errorCode?: InstallErrorCode
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
  /**
   * SMI-5894 (Wave 1 Step 3): which client this installation targets.
   * Absent on manifest entries written before multi-client re-keying —
   * treat a missing value as the canonical client (`claude-code`), matching
   * `manifestKeyFor()`'s own default.
   */
  client?: ClientId
  /**
   * ADR-145 §1: who asserts this entry's identity, independent of `source`.
   * `'registry'` — Skillsmith itself resolved this identity and performed
   * the install (an install record). `'local'` — the user has positively
   * asserted this skill is their own / not registry-tracked; this is an
   * assertion, not an absence of information. Absent = legacy entry, no
   * assertion was ever recorded — NEVER defaults to `'registry'`. The only
   * writer of `provenance: 'local'` is `apply_manifest_reconcile`'s
   * `mark_local` action, which must clear `source` to `'unknown'` in the
   * SAME locked update (ADR-145 §2 — the two fields are never written
   * independently, since `'local'` + a registry-ref `source` is an illegal
   * combination that fails closed on read).
   */
  provenance?: 'local' | 'registry'
  /**
   * ADR-145 §3 / ADR-144 §6: ISO-8601 UTC timestamp of the last successful
   * re-verification of this entry's on-disk content hash against the
   * registry's content hash for the claimed `id`. Absent = never
   * re-verified. Written only by `apply_manifest_reconcile`'s `verify`
   * action, only on a hash MATCH — a failed verification leaves this field
   * untouched rather than clearing it (a stale verification is not the
   * same claim as "never verified"). Gates exactly one transition: E1
   * eligibility in SMI-6345 Wave 2's identity-evidence gate (the cross-ADR
   * contract ADR-145 §4 documents). Not part of the `provenance`/`source`
   * combination matrix — it is a freshness signal, not a trust axis.
   */
  verifiedAt?: string
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
  /**
   * SMI-6343 Wave 3: the registry's recorded author for this skill id, used
   * by the shared identity-classification module's front-matter-contradiction
   * signal. `null`/absent when the registry has no author on record.
   */
  author?: string | null
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
  // SMI-5205: new public tiers
  official: {
    riskThreshold: 80,
    maxContentLength: 2_000_000,
  },
  unverified: {
    riskThreshold: 20, // Same as unknown — unverified is the public alias for unknown
    maxContentLength: 250_000,
  },
}
