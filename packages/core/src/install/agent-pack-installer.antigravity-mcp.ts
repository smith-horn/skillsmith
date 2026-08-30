/**
 * AntiGravity-specific MCP registration step for `sklx agent install`
 * (SMI-6275 Wave 5, closing the last unshipped ask of GH#2166).
 *
 * Split out of `agent-pack-installer.harness.ts`'s generic `installMcpConfig`
 * for a STRUCTURAL reason (not just a per-harness-quirk reason like Cursor's
 * split): every other MCP-capable harness's config path is HOME-anchored
 * (`AGENT_MCP_TARGETS`, `agent-harness-targets.ts`) and resolved via
 * `relocateUnderHome()`. AntiGravity's `.agents/mcp_config.json` is
 * WORKSPACE-anchored — relative to the workspace root Wave 4
 * (`workspace-scope.ts`, ADR-139) resolves — so it cannot live in that
 * HOME-anchored `Record` at all, and never goes through `relocateUnderHome()`.
 * This module owns AntiGravity's path resolution + entry-value shape
 * entirely outside that table, mirroring the Cursor precedent
 * (`agent-pack-installer.cursor-mcp.ts`, SMI-6279 Wave 9) for the "give it
 * its own file" convention while differing in WHY: Cursor's shape/key both
 * diverge from the shared convention; AntiGravity's shape and key both MATCH
 * the shared convention (see {@link ANTIGRAVITY_MCP_ENTRY_KEY} and
 * `buildAntigravityMcpEntryValue()` in `agent-pack-installer.entry.ts}) — only
 * its PATH RESOLUTION diverges structurally.
 *
 * ## Schema verification (SMI-6275 Wave 5 Step 2 point 5)
 *
 * Confidence: **HIGH**. Verified 2026-08-30 via live web search against two
 * canonical Google sources (antigravity.google/docs/ide/mcp/ and
 * antigravity.google/docs/cli/mcp/), corroborated by two independent
 * third-party write-ups (a Google Cloud Community/Medium walkthrough and a
 * Composio how-to guide):
 *   - Path: `.agents/mcp_config.json`, workspace-local, discovered
 *     automatically by "the SDK" (AntiGravity's own phrasing) — sibling to
 *     the GLOBAL `~/.gemini/config/mcp_config.json` (itself a sibling of
 *     `CLIENT_NATIVE_PATHS.antigravity`'s `~/.gemini/config/skills`, `paths.ts`).
 *     Matches `docs/internal/research/smi-5386-opencode-antigravity-skill-dirs.md`'s
 *     already-verified `.agents/skills/` sibling convention for the same
 *     workspace root.
 *   - Schema: a single top-level `mcpServers` object — the SAME
 *     `mcpServers`-keyed convention claude-code/copilot/windsurf/hermes
 *     already use (NOT OpenCode's distinct `local|remote`-typed shape, NOT
 *     Codex's TOML block, NOT Cursor's resolved-binary-path form). Local/
 *     command-based servers are defined with `command` + `args` + optional
 *     `env` — exactly {@link buildAgentMcpEntryValue}'s existing shape, so
 *     `buildAntigravityMcpEntryValue()` composes over it rather than
 *     reinventing it.
 *   - This is reused, not novel: `mergeJsonMcpEntry()` (`agent-config-merge.json.ts`)
 *     already speaks this exact shape for four other harnesses — only the
 *     PATH (workspace-anchored) and the entry KEY (package-scoped, matching
 *     AntiGravity's own docs snippet — see `ANTIGRAVITY_MCP_ENTRY_KEY`) are
 *     new to this wave.
 *
 * @module @skillsmith/core/install/agent-pack-installer.antigravity-mcp
 */

import { join } from 'node:path'

import { mergeJsonMcpEntry } from './agent-config-merge.json.js'
import {
  ANTIGRAVITY_MCP_ENTRY_KEY,
  buildAntigravityMcpEntryValue,
} from './agent-pack-installer.entry.js'
import type { HarnessInstallCtx } from './agent-pack-installer.harness.js'
import type { HarnessInstallReport } from './agent-pack-installer.types.js'
import type { MergeResult } from './agent-config-merge.types.js'

/** Same predicate as `agent-pack-installer.harness.ts`'s private `mergeSucceeded` — duplicated rather than exported to keep that module's helper private. */
function mergeSucceeded(status: MergeResult['status']): boolean {
  return status === 'created' || status === 'updated' || status === 'unchanged'
}

/**
 * Relative path segments (from the resolved workspace root) to AntiGravity's
 * MCP config file. Exported as a fixed constant — not a hand-duplicated
 * string literal — so `agent-manifest-path-guard.ts`'s uninstall-time
 * allowlist check can validate against the EXACT same shape this module
 * writes, rather than an independently-maintained copy that could drift.
 */
export const ANTIGRAVITY_MCP_CONFIG_RELATIVE_SEGMENTS = ['.agents', 'mcp_config.json'] as const

/**
 * Merge AntiGravity's MCP server registration into
 * `<workspaceRoot>/.agents/mcp_config.json` under
 * {@link ANTIGRAVITY_MCP_ENTRY_KEY}.
 *
 * Caller (`agent-pack-installer.ts`) is responsible for having already
 * confirmed `workspaceRoot` is a genuinely resolved AntiGravity workspace
 * scope (via `resolveScopedSkillsDir()`) — this function does no scope
 * resolution or detection of its own, per the "reuse Wave 4's resolver,
 * don't reimplement detection" requirement.
 */
export function installAntigravityMcpConfig(
  workspaceRoot: string,
  ctx: HarnessInstallCtx,
  report: HarnessInstallReport
): void {
  const path = join(workspaceRoot, ...ANTIGRAVITY_MCP_CONFIG_RELATIVE_SEGMENTS)

  const result = mergeJsonMcpEntry({
    path,
    keyPath: ['mcpServers'],
    entryKey: ANTIGRAVITY_MCP_ENTRY_KEY,
    entryValue: buildAntigravityMcpEntryValue(),
    backupDir: ctx.backupDir,
    force: ctx.force,
    alreadyBackedUpPaths: ctx.backedUpPaths,
  })

  report.mcpConfig = result
  if (result.status === 'conflict') {
    report.notes.push(
      `MCP config at ${path} already has a '${ANTIGRAVITY_MCP_ENTRY_KEY}' entry that doesn't look like ours — left untouched. Re-run with --force to overwrite, or edit ${path} manually.`
    )
  }
  if (result.status === 'error') {
    report.notes.push(`MCP config merge failed at ${path}: ${result.errorMessage}`)
  }
  if (mergeSucceeded(result.status)) {
    ctx.entries.push({
      path,
      kind: 'mcp-config',
      harness: 'antigravity',
      backupPath: result.backupPath,
      executable: false,
    })
  }
}
