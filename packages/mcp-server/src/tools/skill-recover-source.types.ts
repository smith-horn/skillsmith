/**
 * @fileoverview Types for the `skill_recover_source` MCP tool.
 * @module @skillsmith/mcp-server/tools/skill-recover-source.types
 * @see SMI-5407
 */

import type { RecoveryReport } from '@skillsmith/core'

/**
 * Validated input for the `skill_recover_source` MCP tool.
 * Mirrors the Zod schema in skill-recover-source.ts.
 */
export interface SkillRecoverSourceInput {
  /**
   * Override the skill inventory root. Must resolve under os.homedir() or
   * os.tmpdir() (test fixtures only). Arbitrary paths are rejected.
   */
  homeDir?: string
  /** Restrict to these skill directory names. */
  only?: string[]
  /** Enable the embedding tiebreak tier (off by default). */
  embedding?: boolean
  /** Enable the catalog / author hint tier (off by default). */
  catalogHint?: boolean
}

/**
 * Response from the `skill_recover_source` MCP tool.
 * Read-only: never mutates the manifest.
 */
export type SkillRecoverSourceResponse = RecoveryReport
