/**
 * Compare-source session state (SMI-5340).
 *
 * Holds the skill id that was "Selected for Compare" so that a subsequent
 * "Compare with Selected" tree-context invocation can skip the first QuickPick.
 * The state lives only for the lifetime of the VS Code window (module-level
 * variable) and is cleared after a successful comparison or when it becomes
 * stale.
 *
 * `setContext` calls are ONLY made inside the exported functions — never at
 * module scope — so that the telemetry-coverage test (which vi.mocks vscode as
 * `{ commands: {} }`) can safely import this module without hitting a
 * `commands.executeCommand is not a function` error at import time.
 *
 * @module commands/compare-source
 */
import * as vscode from 'vscode'

/** The VS Code context key that controls `compareWithSelected` menu visibility. */
const CONTEXT_KEY = 'skillsmith.compareSourceSet'

let compareSource: string | undefined

/**
 * Returns the currently-selected compare source skill id, or `undefined` if
 * none has been set.
 */
export function getCompareSource(): string | undefined {
  return compareSource
}

/**
 * Records `id` as the compare-source and sets the `skillsmith.compareSourceSet`
 * VS Code context key to `true`, enabling the "Compare with Selected" menu entry.
 */
export function setCompareSource(id: string): void {
  compareSource = id
  void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true)
}

/**
 * Clears the compare-source and sets the `skillsmith.compareSourceSet` VS Code
 * context key to `false`, hiding the "Compare with Selected" menu entry.
 */
export function clearCompareSource(): void {
  compareSource = undefined
  void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false)
}
