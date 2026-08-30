/**
 * Report + options types for `installAgentPack` / `uninstallAgentPack`
 * (SMI-5456 Wave 1 Step 5).
 *
 * @module @skillsmith/core/install/agent-pack-installer.types
 */

import type { MergeResult } from './agent-config-merge.types.js'

/** Support tier from PRD §3.1 / Decision 5. */
export type SupportTier = 1 | 2 | 3

export const HARNESS_SUPPORT_TIER: Readonly<Record<string, SupportTier>> = {
  'claude-code': 1,
  cursor: 1,
  codex: 1,
  copilot: 1,
  opencode: 2,
  hermes: 2,
  windsurf: 3,
}

export interface HarnessInstallReport {
  harness: string
  tier: SupportTier
  detected: boolean
  skillPackWritten: boolean
  shimWritten: boolean
  hooksInstalled: boolean
  mcpConfig: MergeResult | null
  hookConfig: MergeResult[]
  notes: string[]
}

export interface AgentInstallOptions {
  /** Override HOME for tests. Defaults to `os.homedir()`. */
  homeDir?: string
  /** Overwrite a foreign (non-Skillsmith) MCP/hook config entry instead of refusing. Default false. */
  force?: boolean
  /**
   * ADR-139 (SMI-6274 Wave 4, point 5's Wave 5 bootstrap requirement):
   * `'workspace'` bootstraps AntiGravity as a target by resolving (and, if
   * necessary, CREATING) its workspace-scoped `.agents/skills` directory
   * via `resolveScopedSkillsDir()`, then writing the skill pack there —
   * this is the ONLY path that may create `.agents/` (bare `agent install`
   * with no `scope` never touches AntiGravity at all, matching every other
   * harness's detection-only default). Omitted/`'global'` preserves
   * today's exact behavior.
   */
  scope?: 'global' | 'workspace'
  /**
   * Test seam for the workspace-scope resolution above — defaults to
   * `process.cwd()`. Mirrors `homeDir`'s existing test-injection role for
   * the rest of this installer.
   */
  cwd?: string
}

export interface AgentInstallResult {
  installedAt: string
  manifestPath: string
  harnessReports: HarnessInstallReport[]
}

export interface AgentUninstallOptions {
  homeDir?: string
}

export interface AgentUninstallResult {
  /** Paths that were deleted (installer-created files) or restored from backup (installer-modified files). */
  removed: string[]
  restored: string[]
  /** Manifest entries that referenced a path already missing on disk (no-op, not an error). */
  alreadyGone: string[]
  /**
   * Manifest entries whose `path` or `backupPath` did not match a known
   * installer target (see `agent-manifest-path-guard.ts`) — skipped
   * entirely, neither deleted nor restored. Non-empty only for a corrupted
   * or hand-tampered manifest; empty on every normal install/uninstall
   * cycle.
   */
  rejected: string[]
}
