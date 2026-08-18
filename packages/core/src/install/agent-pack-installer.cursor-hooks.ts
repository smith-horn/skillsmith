/**
 * Cursor-specific hook install + wiring step, split out of
 * `agent-pack-installer.harness.ts` (SMI-5893 Wave 8a — 500-line file gate).
 *
 * @module @skillsmith/core/install/agent-pack-installer.cursor-hooks
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentPackArtifact } from '../services/agent-pack/index.js'
import { AGENT_HOOK_TARGETS } from './agent-harness-targets.js'
import { mergeJsonArrayEntry, writeBackup } from './agent-config-merge.json-array.js'
import { shouldBackup, markBackedUp } from './agent-config-merge.types.js'
import { relocateUnderHome } from './agent-home-relocate.js'
import { writeOwnedArtifactFile } from './agent-pack-installer.fs-helpers.js'
import { hookEntryCommand } from './agent-pack-installer.harness.js'
import type { HarnessInstallCtx } from './agent-pack-installer.harness.js'
import type { HarnessInstallReport } from './agent-pack-installer.types.js'
import type { MergeResult } from './agent-config-merge.types.js'

/** Same predicate as `agent-pack-installer.harness.ts`'s private `mergeSucceeded` — duplicated rather than exported to keep that module's helper private. */
function mergeSucceeded(status: MergeResult['status']): boolean {
  return status === 'created' || status === 'updated' || status === 'unchanged'
}

/**
 * Top-level `hooks.json` keys Cursor requires alongside its `"hooks"`
 * object — set once, only when absent, never overwritten. See
 * {@link AGENT_HOOK_TARGETS}.cursor's comment (`agent-harness-targets.ts`)
 * for the full shape rationale (SMI-5893 Wave 8a).
 */
const CURSOR_HOOKS_JSON_DEFAULTS: Readonly<Record<string, unknown>> = { version: 1 }

/**
 * Install + wire SessionStart/SessionEnd hook scripts for Cursor.
 *
 * Deliberately NOT folded into `installJsonHooks` (claude-code): Cursor's
 * `hooks.json` is structurally different from Claude's, not just
 * differently-keyed (SMI-5893 Wave 8a, correcting a false Claude-compatible
 * claim). Confirmed 2026-08 against three independent fetches of
 * cursor.com/docs/hooks — the file is `{ "version": 1, "hooks": {...} }`,
 * with `hooks.sessionStart`/`hooks.sessionEnd` arrays of direct
 * `{ "command": "<path>" }` entries. No `matcher`/`type` wrapper, unlike
 * Claude's `{ matcher: '', hooks: [{ type: 'command', command }] }` — reusing
 * that shape here would emit schema-invalid entries Cursor can't parse.
 * Reuses the same generic array-merge engine (`mergeJsonArrayEntry`) as
 * claude-code, with its own entry-value builder (`cursorHookEntry`) /
 * ownership predicate (`cursorHookEntryCommand`) and the
 * `ensureTopLevelDefaults` option to add the required `"version": 1`
 * sibling.
 */
export function installCursorHooks(
  startArtifact: AgentPackArtifact | undefined,
  endArtifact: AgentPackArtifact | undefined,
  ctx: HarnessInstallCtx,
  report: HarnessInstallReport
): void {
  const target = AGENT_HOOK_TARGETS.cursor
  if (!target || !startArtifact || !endArtifact) return

  const scriptDir = relocateUnderHome(target.scriptDir, ctx.homeDir)
  const startPath = join(scriptDir, 'session-start.sh')
  const endPath = join(scriptDir, 'session-end.sh')
  const startResult = writeOwnedArtifactFile({
    path: startPath,
    content: startArtifact.content,
    executable: true,
    backupDir: ctx.backupDir,
  })
  const endResult = writeOwnedArtifactFile({
    path: endPath,
    content: endArtifact.content,
    executable: true,
    backupDir: ctx.backupDir,
  })
  ctx.entries.push(
    {
      path: startPath,
      kind: 'hook-script',
      harness: 'cursor',
      backupPath: startResult.backupPath,
      executable: true,
    },
    {
      path: endPath,
      kind: 'hook-script',
      harness: 'cursor',
      backupPath: endResult.backupPath,
      executable: true,
    }
  )
  report.hooksInstalled = true

  const configPath = relocateUnderHome(target.configPath, ctx.homeDir)
  const startWire = mergeJsonArrayEntry({
    path: configPath,
    keyPath: target.sessionStartKeyPath,
    entry: cursorHookEntry(startPath),
    isOurEntry: (item) => cursorHookEntryCommand(item) === startPath,
    backupDir: ctx.backupDir,
    alreadyBackedUpPaths: ctx.backedUpPaths,
    ensureTopLevelDefaults: CURSOR_HOOKS_JSON_DEFAULTS,
  })
  const endWire = mergeJsonArrayEntry({
    path: configPath,
    keyPath: target.sessionEndKeyPath,
    entry: cursorHookEntry(endPath),
    isOurEntry: (item) => cursorHookEntryCommand(item) === endPath,
    backupDir: ctx.backupDir,
    alreadyBackedUpPaths: ctx.backedUpPaths,
    ensureTopLevelDefaults: CURSOR_HOOKS_JSON_DEFAULTS,
  })
  report.hookConfig.push(startWire, endWire)

  // SMI-5893 Wave 10 (GH#2368 C-07): a pre-Wave-8a install wrote Claude-shaped
  // entries under the capitalized `hooks.SessionStart`/`hooks.SessionEnd`
  // keys before this file's shape was corrected — those never got removed
  // once the lowercase keys above started being written, so a re-merge left
  // both the correct new keys AND the dead legacy ones in the same file.
  //
  // Code-review finding (data-loss): skip the cleanup entirely when either
  // wire call reported `'conflict'` (an incompatible top-level `version`,
  // via `ensureTopLevelDefaults`) — `mergeJsonArrayEntry` deliberately wrote
  // NOTHING in that case, and running the cleanup regardless would still
  // silently rewrite the file (deleting the user's legacy hooks with
  // nothing installed to replace them) even though the real installer
  // refused to touch it.
  const wireConflict = startWire.status === 'conflict' || endWire.status === 'conflict'
  const legacyCleanup = wireConflict
    ? null
    : stripStaleLegacyHookKeys(configPath, startPath, endPath, ctx)
  if (legacyCleanup) report.hookConfig.push(legacyCleanup)

  if (
    mergeSucceeded(startWire.status) ||
    mergeSucceeded(endWire.status) ||
    (legacyCleanup !== null && mergeSucceeded(legacyCleanup.status))
  ) {
    ctx.entries.push({
      path: configPath,
      kind: 'hook-config',
      harness: 'cursor',
      backupPath: startWire.backupPath ?? endWire.backupPath ?? legacyCleanup?.backupPath ?? null,
      executable: false,
    })
  }
}

/**
 * Remove ONLY Skillsmith-owned legacy Claude-shaped entries
 * (`{ matcher: '', hooks: [{ type: 'command', command: <ourPath> }] }`) from
 * the capitalized `hooks.SessionStart`/`hooks.SessionEnd` keys a pre-Wave-8a
 * install wrote — the legacy key names are derived from
 * `AGENT_HOOK_TARGETS['claude-code']`'s own keyPaths (not hardcoded
 * literals) so a future change to Claude's keyPath shape doesn't silently
 * desync this cleanup from what it's actually meant to match. Scoped
 * narrowly per plan review: any other entry under those same legacy keys —
 * a user's own hook, or another tool's — is left untouched, and the whole
 * legacy key is only deleted once it's empty of everything but our own
 * entries (including a legacy key that was ALREADY an empty array — a dead
 * key from a prior interrupted cleanup, also removed). A malformed
 * (non-array) legacy value is left alone rather than crashing.
 *
 * Caller MUST skip calling this entirely when either sibling
 * `mergeJsonArrayEntry` call reported `'conflict'` — see the code-review
 * finding noted at the call site.
 *
 * @returns a `MergeResult` in this module's existing shape so the caller
 *   can fold it into `report.hookConfig` alongside the two wire results —
 *   `'unchanged'` for a genuine no-op (no file, no `hooks` object, or
 *   nothing of ours to remove), `'error'` if the file exists but couldn't
 *   be read/parsed (surfaced instead of silently looking like a no-op —
 *   code-review finding), `'updated'` when something was actually removed.
 */
function stripStaleLegacyHookKeys(
  configPath: string,
  startPath: string,
  endPath: string,
  ctx: HarnessInstallCtx
): MergeResult {
  const unchanged = (): MergeResult => ({ status: 'unchanged', path: configPath, backupPath: null })

  if (!existsSync(configPath)) return unchanged()

  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'error',
        path: configPath,
        backupPath: null,
        errorMessage: 'not a JSON object',
      }
    }
    doc = parsed as Record<string, unknown>
  } catch (e) {
    return {
      status: 'error',
      path: configPath,
      backupPath: null,
      errorMessage: (e as Error).message,
    }
  }

  const hooks = doc.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return unchanged()
  const hooksObj = hooks as Record<string, unknown>

  const claudeTarget = AGENT_HOOK_TARGETS['claude-code']
  const legacyStartKey = claudeTarget.sessionStartKeyPath.at(-1)
  const legacyEndKey = claudeTarget.sessionEndKeyPath.at(-1)

  let changed = false
  for (const [legacyKey, ownPath] of [
    [legacyStartKey, startPath],
    [legacyEndKey, endPath],
  ] as const) {
    if (legacyKey === undefined) continue
    const legacyValue = hooksObj[legacyKey]
    if (legacyValue === undefined) continue
    // Malformed/hand-edited (not an array) — don't touch it, don't crash.
    if (!Array.isArray(legacyValue)) continue

    const remaining = legacyValue.filter((item) => hookEntryCommand(item) !== ownPath)
    // Clean up if something of ours was actually filtered out, OR the key
    // was already a dead empty array (e.g. a prior interrupted cleanup) —
    // both cases leave nothing worth keeping under this legacy key.
    const needsCleanup = legacyValue.length === 0 || remaining.length !== legacyValue.length
    if (!needsCleanup) continue

    changed = true
    if (remaining.length === 0) {
      delete hooksObj[legacyKey]
    } else {
      hooksObj[legacyKey] = remaining
    }
  }

  if (!changed) return unchanged()

  const backupPath = shouldBackup(configPath, ctx.backedUpPaths)
    ? writeBackup(configPath, ctx.backupDir)
    : null
  markBackedUp(configPath, ctx.backedUpPaths)
  writeFileSync(configPath, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  return { status: 'updated', path: configPath, backupPath }
}

/** Cursor's hook entry is a direct `{ command }` object — no `matcher`/`type` wrapper (unlike Claude's `hookMatcherEntry`). */
function cursorHookEntry(scriptPath: string): Record<string, unknown> {
  return { command: scriptPath }
}

function cursorHookEntryCommand(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined
  const command = (item as Record<string, unknown>).command
  return typeof command === 'string' ? command : undefined
}
