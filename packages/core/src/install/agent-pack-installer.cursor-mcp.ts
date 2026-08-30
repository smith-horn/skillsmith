/**
 * Cursor-specific MCP registration step for `sklx agent install`
 * (SMI-6279 Wave 9).
 *
 * Split out of `agent-pack-installer.harness.ts`'s generic `installMcpConfig`
 * — mirrors the existing `agent-pack-installer.cursor-hooks.ts` split
 * (SMI-5893 Wave 8a) for the same reason: Cursor's on-disk shape/resolution
 * needs diverge structurally from the other 6 MCP-capable harnesses, so
 * folding cursor-only logic into the shared function would either bloat it
 * past the 500-line gate or force every other harness through cursor-only
 * branches it doesn't need.
 *
 * Two independent, confirmed-broken things this fixes (GH#2368 V3 repro —
 * see the SMI-6266 Wave 9 plan doc):
 *   1. `buildAgentMcpEntryValue()` wrote the `npx`/`args` form into Cursor's
 *      `mcp.json` — the exact shape two live UAT passes proved ENOENTs
 *      inside Cursor's bundled Node (GH#2368 C-01) — and never set
 *      `SKILLSMITH_CLIENT`, so re-running `agent install` (the very
 *      remediation `formatUpdateNotification()` tells a user to run)
 *      silently rewrote the SAME broken entry, even after the website docs
 *      snippet was corrected (SMI-5893 Wave 11). {@link installCursorMcpConfig}
 *      now writes `buildCursorMcpEntryValue()` instead — resolved binary
 *      path (or the documented paste-here placeholder) plus
 *      `SKILLSMITH_CLIENT=cursor`.
 *   2. The installer wrote its entry under the JSON key `skillsmith`, while
 *      the website/CLI-template docs snippet (which users are told to
 *      hand-paste) uses the package-scoped key `@skillsmith/mcp-server` — a
 *      user who did both ended up with TWO different server entries
 *      coexisting in the same file, neither ever recognized as "the
 *      other's" by the installer's own conflict-detection (which matches
 *      purely on key). {@link installCursorMcpConfig} now writes under
 *      `CURSOR_MCP_ENTRY_KEY` (`'@skillsmith/mcp-server'`) so a docs-paste
 *      and an `agent install` reconcile as ONE entry, and
 *      {@link stripStaleLegacyMcpKey} removes a pre-fix install's stale
 *      `'skillsmith'`-keyed entry (mirroring the cursor-hooks legacy-key
 *      cleanup precedent) so a re-install doesn't leave both keys present.
 *
 * Scoped to Cursor ONLY — `mergeJsonMcpEntry`'s default `entryKey`
 * (`'skillsmith'`) and `buildAgentMcpEntryValue()`'s `npx` form are
 * UNCHANGED for claude-code/copilot/windsurf/opencode/codex/hermes; nothing
 * in this module is reachable from any other harness's install path.
 *
 * @module @skillsmith/core/install/agent-pack-installer.cursor-mcp
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { AGENT_MCP_TARGETS } from './agent-harness-targets.js'
import { mergeJsonMcpEntry } from './agent-config-merge.json.js'
import { writeBackup } from './agent-config-merge.json-array.js'
import { deepEqualJson, markBackedUp, shouldBackup } from './agent-config-merge.types.js'
import {
  CURSOR_MCP_ENTRY_KEY,
  LEGACY_MCP_ENTRY_KEY,
  buildAgentMcpEntryValue,
  buildCursorMcpEntryValue,
} from './agent-pack-installer.entry.js'
import { relocateUnderHome } from './agent-home-relocate.js'
import type { HarnessInstallCtx } from './agent-pack-installer.harness.js'
import type { HarnessInstallReport } from './agent-pack-installer.types.js'
import type { MergeResult } from './agent-config-merge.types.js'

/** Same predicate as `agent-pack-installer.harness.ts`'s private `mergeSucceeded` — duplicated rather than exported to keep that module's helper private. */
function mergeSucceeded(status: MergeResult['status']): boolean {
  return status === 'created' || status === 'updated' || status === 'unchanged'
}

/**
 * Merge Cursor's `skillsmith` MCP server registration into `~/.cursor/mcp.json`
 * under {@link CURSOR_MCP_ENTRY_KEY}, then clean up a stale legacy-keyed
 * entry from a pre-SMI-6279 install (see module header).
 */
export function installCursorMcpConfig(ctx: HarnessInstallCtx, report: HarnessInstallReport): void {
  const target = AGENT_MCP_TARGETS.cursor
  const path = relocateUnderHome(target.path, ctx.homeDir)
  const entryValue = buildCursorMcpEntryValue()

  const result = mergeJsonMcpEntry({
    path,
    keyPath: target.keyPath,
    entryKey: CURSOR_MCP_ENTRY_KEY,
    entryValue,
    backupDir: ctx.backupDir,
    force: ctx.force,
    alreadyBackedUpPaths: ctx.backedUpPaths,
  })

  report.mcpConfig = result
  if (result.status === 'conflict') {
    report.notes.push(
      `MCP config at ${path} already has a '${CURSOR_MCP_ENTRY_KEY}' entry that doesn't look like ours — left untouched. Re-run with --force to overwrite, or edit ${path} manually.`
    )
  }
  if (result.status === 'error') {
    report.notes.push(`MCP config merge failed at ${path}: ${result.errorMessage}`)
  }

  // Only attempt the legacy-key cleanup once our own write succeeded (or was
  // already correct) — same data-loss guard as the cursor-hooks precedent:
  // a 'conflict'/'error' write means we deliberately left the file alone (or
  // couldn't touch it), so removing the legacy key too would still mutate a
  // file the real merge just refused to touch.
  const cleanup = mergeSucceeded(result.status)
    ? stripStaleLegacyMcpKey(path, target.keyPath, ctx)
    : null
  if (cleanup?.status === 'updated') {
    report.notes.push(
      `Removed stale legacy '${LEGACY_MCP_ENTRY_KEY}' MCP entry at ${path} — superseded by '${CURSOR_MCP_ENTRY_KEY}' (aligns with the website/CLI docs snippet key, SMI-6279 Wave 9).`
    )
  }

  if (mergeSucceeded(result.status) || cleanup?.status === 'updated') {
    ctx.entries.push({
      path,
      kind: 'mcp-config',
      harness: 'cursor',
      backupPath: result.backupPath ?? cleanup?.backupPath ?? null,
      executable: false,
    })
  }
}

/**
 * Strict, purpose-built ownership fingerprint for the destructive delete in
 * {@link stripStaleLegacyMcpKey} — deliberately NOT the shared
 * `looksLikeOurMcpEntry` heuristic (`agent-config-merge.types.ts`).
 *
 * `looksLikeOurMcpEntry` is intentionally loose (substring-matches an
 * `args` element, or merely checks a `SKILLSMITH_TOOL_PROFILE` key is
 * PRESENT regardless of its value) because its only job is gating a
 * same-key OVERWRITE — a false positive there is non-destructive, the
 * entry we'd write next replaces whatever was there either way. Deleting a
 * DIFFERENT key entirely (this function) is a strictly higher-risk
 * operation: a false positive here permanently removes a user's config
 * with nothing to replace it — e.g. a custom wrapper script whose `args`
 * happen to reference the package name in one element among several, or a
 * user's own hand-authored `skillsmith`-keyed entry that happens to set a
 * `SKILLSMITH_TOOL_PROFILE` env var with a DIFFERENT value for unrelated
 * reasons (code-review finding, GPT-5.6-Sol / SMI-6279).
 *
 * The bar here is "structurally identical to exactly what
 * `buildAgentMcpEntryValue()` itself would have written" — checked via
 * `deepEqualJson` against that function's actual return value (not a
 * hand-duplicated literal, so this can never drift out of sync with the
 * real shape): exact `command`, exact `args` sequence (not "contains"),
 * exact `env` key SET (not just key presence) and exact value.
 */
function looksLikeExactLegacyNpxEntry(value: unknown): boolean {
  return deepEqualJson(value, buildAgentMcpEntryValue())
}

/**
 * Remove a stale `LEGACY_MCP_ENTRY_KEY` (`'skillsmith'`)-keyed MCP entry
 * left behind by a pre-SMI-6279 `agent install` run, but ONLY when it is
 * structurally IDENTICAL to what that installer itself would have written
 * (`looksLikeExactLegacyNpxEntry` above). A user's own hand-written
 * `skillsmith`-named entry — even one that superficially resembles ours —
 * is left completely untouched — this never silently deletes a foreign or
 * near-miss entry just because it shares the old key name.
 *
 * Read-modify-write is scoped to exactly the `mcpServers.skillsmith` key —
 * every other key in the file (including the entry this function's caller
 * just wrote under `CURSOR_MCP_ENTRY_KEY`) is preserved byte-for-byte.
 *
 * @returns `null` when there's nothing to clean up (file missing/unparsable,
 *   no `mcpServers` object, no legacy key, or the legacy key isn't an EXACT
 *   match for our own legacy shape) — a genuine no-op, not surfaced as a
 *   report entry. A `MergeResult` with `status: 'updated'` when the legacy
 *   key was removed.
 */
function stripStaleLegacyMcpKey(
  path: string,
  keyPath: readonly string[],
  ctx: HarnessInstallCtx
): MergeResult | null {
  if (!existsSync(path)) return null

  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    doc = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const containerKey = keyPath[0]
  if (containerKey === undefined) return null
  const container = doc[containerKey]
  if (!container || typeof container !== 'object' || Array.isArray(container)) return null
  const containerObj = container as Record<string, unknown>

  const legacyEntry = containerObj[LEGACY_MCP_ENTRY_KEY]
  if (legacyEntry === undefined) return null
  // Foreign OR near-miss — never touch, even if named 'skillsmith'.
  if (!looksLikeExactLegacyNpxEntry(legacyEntry)) return null

  delete containerObj[LEGACY_MCP_ENTRY_KEY]
  const backupPath = shouldBackup(path, ctx.backedUpPaths) ? writeBackup(path, ctx.backupDir) : null
  markBackedUp(path, ctx.backedUpPaths)
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  return { status: 'updated', path, backupPath }
}
