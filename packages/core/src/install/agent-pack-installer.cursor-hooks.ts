/**
 * Cursor-specific hook install + wiring step, split out of
 * `agent-pack-installer.harness.ts` (SMI-5893 Wave 8a — 500-line file gate).
 *
 * @module @skillsmith/core/install/agent-pack-installer.cursor-hooks
 */

import { join } from 'node:path'
import type { AgentPackArtifact } from '../services/agent-pack/index.js'
import { AGENT_HOOK_TARGETS } from './agent-harness-targets.js'
import { mergeJsonArrayEntry } from './agent-config-merge.json-array.js'
import { relocateUnderHome } from './agent-home-relocate.js'
import { writeOwnedArtifactFile } from './agent-pack-installer.fs-helpers.js'
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
  if (mergeSucceeded(startWire.status) || mergeSucceeded(endWire.status)) {
    ctx.entries.push({
      path: configPath,
      kind: 'hook-config',
      harness: 'cursor',
      backupPath: startWire.backupPath ?? endWire.backupPath,
      executable: false,
    })
  }
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
