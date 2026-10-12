/**
 * @fileoverview `install_skill`'s structured error-envelope builders.
 * @module @skillsmith/mcp-server/tools/install.errors
 *
 * Every one of these returns an `InstallResult` with `success: false` rather
 * than throwing. That is the whole point of the file: an MCP caller cannot
 * distinguish a protocol-level `isError` from a transport failure, so an
 * application-level failure has to arrive through the result envelope. The
 * convention comes from `team-workspace.ts` and is mirrored by
 * `uninstall.ts`'s own `buildScopeError`.
 *
 * Moved out of `install.ts` by the post-merge retro on cfc96eccd (SMI-6733),
 * which found that file at 499 of its 500-line pre-commit ceiling — one line
 * of headroom, with the gate blocking rather than warning. A pure move: no
 * signature, body or docblock changed, and `install.ts` is the only importer.
 *
 * @see SMI-4288, SMI-4737, ADR-139
 */

import type { InstallResult } from './install.types.js'

/**
 * Build an application-level validation failure result.
 *
 * SMI-4288 / GitHub #599: When an MCP caller passes a malformed argument
 * payload (e.g. `{}`, wrong `skillId` type, invalid `conflictAction` enum),
 * return a structured `InstallResult` with `success: false` rather than
 * throwing. Matches the existing `team-workspace.ts` error-envelope
 * convention (application-level failure, not MCP protocol-level `isError`).
 *
 * @see #599
 */
export function buildValidationError(message: string): InstallResult {
  return {
    success: false,
    skillId: '',
    installPath: '',
    error: `Invalid install input: ${message}`,
  }
}

/**
 * SMI-4737: structured tool-error envelope for `extractSkillName` throws.
 * Adversarial `skillId` values that survive Zod's 512-char boundary but
 * produce an over-cap (>128 char) extracted segment are rejected here so
 * the throw never escapes the MCP handler. Mirrors the `buildValidationError`
 * shape (application-level failure, not MCP protocol-level `isError`).
 */
export function buildInvalidSkillIdError(skillId: string, message: string): InstallResult {
  return {
    success: false,
    skillId,
    installPath: '',
    error: `invalid_skill_id: ${message}`,
  }
}

/**
 * ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: structured tool-error
 * envelope for an unsatisfiable/invalid `scope` request — mirrors
 * {@link buildValidationError}'s precedent (a structured `success: false`
 * result, not an MCP protocol-level throw) so an unsatisfiable
 * `scope: 'workspace'` request still surfaces as the "HARD ERROR naming the
 * reason" ADR-139 point 2 requires, through the SAME structured channel
 * every other pre-flight failure in this tool already uses, rather than an
 * uncaught throw escaping into an MCP protocol-level error the caller can't
 * distinguish from a transport failure.
 */
export function buildScopeError(skillId: string, error: Error): InstallResult {
  return {
    success: false,
    skillId,
    installPath: '',
    error: error.message,
  }
}
