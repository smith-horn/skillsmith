/**
 * SMI-5130 — VS Code panel-action telemetry coverage snapshot test.
 *
 * Mirrors the CLI tree's SMI-5040 coverage test and the MCP tree's SMI-5018
 * test, but for the VS Code extension's command panel actions. Asserts that
 * every registered command's handler is wrapped by the extension-local
 * `withTelemetry` (services/telemetry-wrap.ts) — see that file for why the
 * extension uses a local wrapper rather than `@skillsmith/core/telemetry`.
 *
 * The command modules `import * as vscode from 'vscode'` (extension-host only).
 * None call a vscode API at module load, so a resolvable stub is enough to
 * evaluate the `withTelemetry(...)` exports. `vi.mock` is hoisted above the
 * imports below.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('vscode', () => ({
  window: {},
  commands: {},
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  env: {},
  Uri: { file: (s: string) => s, parse: (s: string) => s },
  ProgressLocation: { Notification: 15 },
}))

import { isTelemetered } from '../../services/telemetry-wrap.js'
import { searchSkillsAction, filterSkillsAction, clearFiltersAction } from '../searchSkills.js'
import { installCommandAction } from '../installCommand.js'
import { uninstallCommandAction } from '../uninstallCommand.js'
import { createSkillAction } from '../createSkillCommand.js'
import type { TelemetryEvent } from '../../services/Telemetry.js'

/** Registered command id → wrapped panel action. */
const VSCODE_DISPATCHER_MAP: Record<string, (...args: never[]) => unknown> = {
  'skillsmith.searchSkills': searchSkillsAction,
  'skillsmith.filterSkills': filterSkillsAction,
  'skillsmith.clearSkillFilters': clearFiltersAction,
  'skillsmith.installSkill': installCommandAction,
  'skillsmith.uninstallSkill': uninstallCommandAction,
  'skillsmith.createSkill': createSkillAction,
}

describe('SMI-5130: VS Code command telemetry coverage', () => {
  it('every panel action export is telemetry-wrapped', () => {
    const failures: string[] = []
    for (const [commandId, fn] of Object.entries(VSCODE_DISPATCHER_MAP)) {
      if (typeof fn !== 'function') {
        failures.push(`${commandId} — not a function (got ${typeof fn})`)
        continue
      }
      if (!isTelemetered(fn)) {
        failures.push(`${commandId} — exported but isTelemetered() returned false`)
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `VS Code telemetry coverage failures (${failures.length}):\n` +
          failures.map((f) => `  • ${f}`).join('\n') +
          '\n\nTo fix: wrap the command handler with withTelemetry(...) (services/telemetry-wrap.ts) ' +
          'and pass the wrapped action to registerCommand.'
      )
    }
  })

  it('reports VS Code dispatcher coverage to CI output', () => {
    const count = Object.keys(VSCODE_DISPATCHER_MAP).length
    console.info(`[SMI-5130] VS Code telemetry coverage: ${count} panel actions wrapped.`)
    expect(count).toBe(6)
  })

  // SMI-5308 (M5): the detail-panel open actions are postMessage handlers, not
  // registered commands, so they don't appear in VSCODE_DISPATCHER_MAP. Assert
  // their distinct, type-safe ids exist in the TelemetryEvent union (a removal
  // or rename breaks compilation here).
  it('declares distinct telemetry ids for the detail-panel open actions', () => {
    const openIds: TelemetryEvent[] = ['vscode_open_skill_file', 'vscode_open_folder']
    expect(openIds).toHaveLength(2)
    expect(new Set(openIds).size).toBe(2)
  })

  // SMI-5312: the post-create checklist action is fired inside a helper, not a
  // registered command, so it isn't in VSCODE_DISPATCHER_MAP. Assert its
  // type-safe id exists in the TelemetryEvent union (rename/removal breaks here).
  it('declares the post-create checklist telemetry id', () => {
    const checklistId: TelemetryEvent = 'vscode_create_checklist_action'
    expect(checklistId).toBe('vscode_create_checklist_action')
  })
})
