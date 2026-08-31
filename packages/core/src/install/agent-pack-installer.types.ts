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
  // SMI-6275 Wave 5: MCP config only (no shim, no hooks) — same reduced
  // profile as windsurf, stated explicitly per the wave's own "support tier"
  // decision requirement (see HOOK_HARNESSES's doc comment,
  // services/agent-pack/types.ts, and AGENT_SHIM_TARGETS.antigravity,
  // agent-harness-targets.ts).
  antigravity: 3,
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
   * necessary, CREATING) its workspace-scoped `.agents/` directory via
   * `resolveScopedSkillsDir()`, then writing the skill pack AND
   * `.agents/mcp_config.json` there (SMI-6275 Wave 5 adds the latter) —
   * this is the ONLY path that may CREATE `.agents/`.
   *
   * Omitted/`'global'` does NOT mean "AntiGravity untouched," despite the
   * name — bare `agent install` still AUTO-DETECTS an already-EXISTING
   * `.agents/` marker at or above `cwd` (ADR-139 point 2 rank 4, a
   * read-only check that never creates anything) and, when found, installs
   * the same skill pack + MCP config there. AntiGravity is only skipped
   * entirely (reported `detected: false`, with a note — never a silent
   * omission) when NO `.agents/` marker exists anywhere in the ancestry AND
   * `scope` wasn't explicitly `'workspace'`. This auto-detect behavior is
   * new in SMI-6275 Wave 5 — Wave 4 gated the skill-pack write on an
   * explicit `'workspace'` value ONLY (see git history if comparing against
   * that wave's own tests).
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
