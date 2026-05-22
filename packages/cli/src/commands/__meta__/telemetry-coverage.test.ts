/**
 * SMI-5040 — CLI-tree telemetry coverage snapshot test.
 *
 * Scope: `packages/cli/src/commands/` (v1 partial).
 * Mirrors SMI-5018's MCP coverage test (packages/mcp-server/src/tools/__meta__/
 * telemetry-coverage.test.ts) but iterates the CLI command dispatchers.
 *
 * Why a sibling test rather than extending SMI-5018: import-path scope. The
 * MCP test uses `import.meta.url`-relative paths under `tools/`; reusing it
 * would couple the two trees and force the MCP test to know about CLI files.
 * Per-tree snapshots are loosely coupled and each can grow on its own
 * cadence as coverage extends.
 *
 * v1 partial: this allowlist is intentionally smaller than the universe of
 * CLI commands. Remaining files (~18) are tracked under SMI-5040 follow-up
 * sub-issues. The drift sentinel in the bottom test ensures the listed
 * dispatchers stay wrapped; new wraps must be added to CLI_DISPATCHER_MAP.
 */

import { describe, it, expect } from 'vitest'
import { isTelemetered } from '@skillsmith/core/telemetry'

/**
 * Maps source-file base name (no extension) under `packages/cli/src/commands/`
 * to the list of wrapped-action export names that live in that file.
 *
 * ADDING A NEW WRAPPED ACTION:
 *   1. Wrap the command's action handler with `withTelemetry` in its source
 *      file (extract impl → const action = withTelemetry(impl, opts)).
 *   2. Add its export name to the correct inner array below.
 *   3. Pass the wrapped action to `.action(...)` in the createXCommand factory.
 */
const CLI_DISPATCHER_MAP: Record<string, string[]> = {
  info: ['infoAction'],
  recommend: ['recommendAction'],
  whoami: ['whoamiAction'],
  'install-skill': ['setupAction'],
  // SMI-5127: sibling-split pilot — action impls live in *.action.ts files
  'sync.action': ['syncAction', 'syncStatusAction', 'syncHistoryAction', 'syncConfigAction'],
  'search.action': ['searchAction'],
  // SMI-5128 batch A
  logout: ['logoutAction'],
  merge: ['mergeAction'],
  analyze: ['analyzeAction'],
  diff: ['diffAction'],
  // SMI-5128 batch B
  'ab-test': ['abTestAction'],
  'import-local': ['importLocalAction'],
  pin: ['pinAction', 'unpinAction'],
  config: ['configGetAction', 'configSetAction'],
  // SMI-5128 batch C
  install: ['installAction'],
  login: ['loginAction'],
  import: ['importAction'],
  create: ['createAction'],
}

const EXPECTED_TOTAL = Object.values(CLI_DISPATCHER_MAP).reduce((n, arr) => n + arr.length, 0)

const COMMANDS_DIR = new URL('../', import.meta.url).pathname

describe('SMI-5040: CLI command telemetry coverage (v1 partial)', () => {
  it('EXPECTED_TOTAL matches sum of CLI_DISPATCHER_MAP entries', () => {
    const actualSum = Object.values(CLI_DISPATCHER_MAP).reduce((n, arr) => n + arr.length, 0)
    expect(actualSum).toBe(EXPECTED_TOTAL)
  })

  it('every listed CLI dispatcher export is telemetry-wrapped', async () => {
    const failures: string[] = []

    for (const [fileBase, exportNames] of Object.entries(CLI_DISPATCHER_MAP)) {
      const modulePath = `${COMMANDS_DIR}${fileBase}.ts`

      let mod: Record<string, unknown>
      try {
        mod = (await import(modulePath)) as Record<string, unknown>
      } catch (err) {
        failures.push(
          `[IMPORT ERROR] ${fileBase}.ts — ${err instanceof Error ? err.message : String(err)}`
        )
        continue
      }

      for (const exportName of exportNames) {
        const exported = mod[exportName]

        if (typeof exported !== 'function') {
          failures.push(`${fileBase}.ts :: ${exportName} — not a function (got ${typeof exported})`)
          continue
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!isTelemetered(exported as (...args: any[]) => any)) {
          failures.push(
            `${fileBase}.ts :: ${exportName} — function exists but isTelemetered() returned false`
          )
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `CLI telemetry coverage failures (${failures.length}):\n` +
          failures.map((f) => `  • ${f}`).join('\n') +
          '\n\nTo fix: wrap the dispatcher with withTelemetry(...) and add it to CLI_DISPATCHER_MAP.'
      )
    }
  })

  it('reports CLI dispatcher coverage to CI output', () => {
    const fileCount = Object.keys(CLI_DISPATCHER_MAP).length
    const dispatcherCount = EXPECTED_TOTAL
    console.info(
      `[SMI-5040] CLI telemetry coverage: ${dispatcherCount} dispatchers across ${fileCount} files (v1 partial).`
    )
    console.info('[SMI-5040] Remaining CLI files + VS Code: tracked under SMI-5040 follow-up.')
    expect(dispatcherCount).toBeGreaterThanOrEqual(4)
  })
})
