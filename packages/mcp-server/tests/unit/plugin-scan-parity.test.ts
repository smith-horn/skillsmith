/**
 * SMI-6229 Wave 1 Step 6 — cross-runtime parity test.
 *
 * Guards that the canonical TS resolver
 * (packages/mcp-server/src/utils/local-inventory.helpers.ts's
 * `readEnabledPluginIds`, SMI-6228 Wave 1) and its plain-Node mirror
 * (scripts/lib/mcp-command-guard.plugin-scan.mjs's function of the same
 * name, SMI-6229) agree on which plugin ids are enabled, for every
 * `~/.claude/settings.json` shape in the scenario table below.
 *
 * SECURITY-RELEVANT (ADR-137): this is not a cosmetic parity check. A
 * divergence here would mean `scripts/lib/mcp-command-guard.mjs`'s
 * hosted-scope check scans a different plugin set than
 * `skill_inventory_audit` does — the guard could go blind to a hosted MCP
 * server exposing write-capable database tools (`execute_sql`,
 * `apply_migration`) while the audit tool still sees it, or vice versa.
 * This test is the enforcement mechanism ADR-137 requires for that class of
 * duplication, not an optional nicety.
 *
 * Placement (deliberate, not `scripts/tests/`): `local-inventory.helpers.ts`
 * imports `@skillsmith/core/install`, and `ci.yml`'s `Test (root)` job runs
 * `vitest run scripts/tests supabase/functions` with no build step of its
 * own — a parity test placed there would depend on `@skillsmith/core`'s
 * `dist/` being present in a job that never builds it. Co-located with
 * `local-inventory.test.ts`, this test runs where core is already built.
 *
 * The two signatures differ (`readEnabledPluginIds(settingsPath, warnings)`
 * in TS, `readEnabledPluginIds(settingsPath)` in `.mjs`); this test passes a
 * throwaway `warnings` array to the TS side and compares only the returned
 * id arrays.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { readEnabledPluginIds as readEnabledPluginIdsTs } from '../../src/utils/local-inventory.helpers.js'
import type { ScanWarning } from '../../src/utils/local-inventory.types.js'
// The plain-Node mirror this test enforces parity against — SMI-6229. The
// relative path outside the package boundary is deliberate: this is the
// runtime-mirror-parity precedent ADR-137 formalizes, same shape as
// scripts/tests/project-dir-parity.test.ts's cross-directory import.
import { readEnabledPluginIds as readEnabledPluginIdsMjs } from '../../../../scripts/lib/mcp-command-guard.plugin-scan.mjs'

let TEST_HOME: string

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-scan-parity-'))
})

afterEach(() => {
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
})

function writeSettings(content: string): string {
  const settingsPath = path.join(TEST_HOME, 'settings.json')
  fs.writeFileSync(settingsPath, content)
  return settingsPath
}

/** Run both implementations against the same settings.json path and assert agreement. */
function expectParity(settingsPath: string): void {
  const warnings: ScanWarning[] = []
  const tsResult = readEnabledPluginIdsTs(settingsPath, warnings)
  const mjsResult = readEnabledPluginIdsMjs(settingsPath) as string[]
  expect(mjsResult).toEqual(tsResult)
}

describe('readEnabledPluginIds parity (TS vs .mjs mirror, SMI-6229 / ADR-137)', () => {
  it('all-true enabledPlugins', () => {
    const p = writeSettings(
      JSON.stringify({ enabledPlugins: { 'a@market': true, 'b@market': true } })
    )
    expectParity(p)
  })

  it('mixed true/false enabledPlugins', () => {
    const p = writeSettings(
      JSON.stringify({ enabledPlugins: { 'a@market': true, 'b@market': false } })
    )
    expectParity(p)
  })

  it('non-boolean value in enabledPlugins', () => {
    const p = writeSettings(JSON.stringify({ enabledPlugins: { 'a@market': 'true' } }))
    expectParity(p)
  })

  it('empty enabledPlugins object', () => {
    const p = writeSettings(JSON.stringify({ enabledPlugins: {} }))
    expectParity(p)
  })

  it('missing enabledPlugins key', () => {
    const p = writeSettings(JSON.stringify({ someOtherKey: true }))
    expectParity(p)
  })

  it('enabledPlugins present but not an object', () => {
    const p = writeSettings(JSON.stringify({ enabledPlugins: 'not-an-object' }))
    expectParity(p)
  })

  it('missing settings.json entirely', () => {
    const p = path.join(TEST_HOME, 'does-not-exist.json')
    expectParity(p)
  })

  it('malformed settings.json JSON', () => {
    const p = writeSettings('{not valid json')
    expectParity(p)
  })

  it('cross-provider review finding: array-shaped enabledPlugins returns [] on both sides, not ["0"]', () => {
    // Before the fix: TS's `typeof enabledPlugins !== 'object'` check let an
    // array through (typeof [] === 'object' in JS), so
    // Object.entries([true]) produced ["0"] on the TS side while the .mjs
    // side's isPlainObject correctly excluded arrays and returned []. That
    // divergence is exactly what this parity test exists to catch, and its
    // prior scenario table never exercised an array-shaped enabledPlugins.
    const p = writeSettings(JSON.stringify({ enabledPlugins: [true, true] }))
    expectParity(p)
    const warnings: ScanWarning[] = []
    expect(readEnabledPluginIdsTs(p, warnings)).toEqual([])
  })

  it('array-shaped settings.json (top-level) returns [] on both sides', () => {
    const p = writeSettings(JSON.stringify([{ enabledPlugins: { 'a@market': true } }]))
    expectParity(p)
  })
})
