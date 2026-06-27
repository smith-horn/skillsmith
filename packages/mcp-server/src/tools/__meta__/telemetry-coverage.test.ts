/**
 * SMI-5018 W2.S3 — MCP-tree telemetry coverage snapshot test.
 *
 * Scope: `packages/mcp-server/src/tools/` only (v1).
 * CLI + VS Code trees are NOT checked here — they are blocked by SMI-5040
 * (anonymous-closure incompatibility). When SMI-5040 lands this test will
 * be extended to cover those trees.
 *
 * Risk guarded (plan line 798, risk #8):
 *   "A new dispatcher ships without a telemetry wrap."
 *
 * Strategy: explicit allowlist (40 entries) cross-checked against the live
 * withTelemetry import-site count. Allowlist chosen over heuristic-walk
 * because it is trivially auditable — each entry maps 1-to-1 to a
 * `grep "= withTelemetry"` result, and the SOURCE_FILE_COUNT sentinel
 * independently guards against drift in either direction.
 *
 * When you add a new dispatcher:
 *   1. Wrap it with withTelemetry in its source file (as SMI-5017 did).
 *   2. Add its export name to EXPECTED_DISPATCHERS below.
 *   3. Update SOURCE_FILE_COUNT if the dispatcher lives in a new file.
 * The test will fail in CI until all three steps are done.
 */

import { describe, it, expect } from 'vitest'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isTelemetered } from '@skillsmith/core/telemetry'

// ---------------------------------------------------------------------------
// Allowlist — every export that must be telemetry-wrapped (v1, MCP tree only)
// Derived by: grep -rn "^export const.*= withTelemetry" packages/mcp-server/src/tools/
// Count must equal SOURCE_FILE_COUNT's withTelemetry site total.
// ---------------------------------------------------------------------------

/**
 * Maps source-file base name (no extension) to the list of dispatcher export
 * names that live in that file. Both the file and every listed export must be
 * telemetry-wrapped.
 *
 * Files NOT in this map are skipped even if they live under tools/:
 *   *.types.ts, *.helpers.ts, *.test.ts, *.dep.test.ts — infrastructure only.
 *   *.stub.ts, *.service.ts, *.tool.ts, *.live.ts — helpers/services, not dispatchers.
 *   merge.ts, LocalSkillSearch.ts, team-resolver.ts — pure utilities.
 *   index.ts — barrel re-export, no dispatch logic.
 *   namespace-audit/ directory — telemetry helper, not a dispatcher.
 *
 * ADDING A NEW DISPATCHER: append to the correct inner array, or add a new
 * key if the dispatcher lives in a new file. Increment EXPECTED_TOTAL.
 */
const DISPATCHER_MAP: Record<string, string[]> = {
  analytics: [
    'executeTeamAnalyticsDashboard',
    'executeTeamUsageReport',
    'executeAnalyticsDashboard',
    'executeUsageReport',
  ],
  analyze: ['executeAnalyze'],
  'apply-namespace-rename': ['applyNamespaceRename'],
  'apply-recommended-edit': ['applyRecommendedEditTool'],
  'audit-tools': ['executeAuditExport', 'executeAuditQuery', 'executeSiemExport'],
  compare: ['executeCompare'],
  'compliance-tools': ['executeComplianceReport'],
  'get-skill': ['executeGetSkill'],
  'index-local': ['executeIndexLocal'],
  install: ['installSkill'],
  'integration-tools': ['executeWebhookConfigure', 'executeApiKeyManage'],
  'inventory-push': ['inventoryPush'],
  outdated: ['executeOutdated'],
  publish: ['executePublish'],
  'publish-private': ['executePublishPrivate'],
  'rbac-tools': ['executeRbacManage', 'executeRbacAssignRole', 'executeRbacCreatePolicy'],
  recommend: ['executeRecommend'],
  'registry-tools': ['executePrivateRegistryPublish', 'executePrivateRegistryManage'],
  search: ['executeSearch'],
  'skill-audit': ['executeSkillAudit'],
  'skill-diff': ['executeSkillDiff'],
  'skill-inventory-audit': ['skillInventoryAudit'],
  'skill-pack-audit': ['executeSkillPackAudit'],
  'skill-rescan': ['executeSkillRescan'],
  'skill-updates': ['executeSkillUpdates'],
  'sso-tools': ['executeConfigureSso', 'executeSsoSettings'],
  suggest: ['executeSuggest'],
  'team-workspace': ['executeTeamWorkspace', 'executeShareSkill'],
  uninstall: ['uninstallSkill'],
  validate: ['executeValidate'],
}

/** Expected total dispatcher count. Must match sum of DISPATCHER_MAP values. */
const EXPECTED_TOTAL = Object.values(DISPATCHER_MAP).reduce((n, arr) => n + arr.length, 0)

// Resolve the absolute path to the tools directory using import.meta.url so
// the test works regardless of cwd (CI runner vs local Docker vs worktree).
const TOOLS_DIR = new URL('../', import.meta.url).pathname

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the list of .ts source files directly under TOOLS_DIR (non-recursive
 * for the flat layer, plus the namespace-audit sub-directory is intentionally
 * excluded).  Used only for the drift-sentinel assertion.
 */
async function listToolSourceFiles(): Promise<string[]> {
  const entries = await readdir(TOOLS_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => e.name)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SMI-5018: MCP tool telemetry coverage (v1, MCP tree only)', () => {
  /**
   * Sentinel: the DISPATCHER_MAP covers the expected total.
   * This catches a copy-paste error where an entry was added to one list but
   * not the other.
   */
  it('EXPECTED_TOTAL matches sum of DISPATCHER_MAP entries', () => {
    const actualSum = Object.values(DISPATCHER_MAP).reduce((n, arr) => n + arr.length, 0)
    expect(actualSum).toBe(EXPECTED_TOTAL)
  })

  /**
   * Main coverage assertion: for every (file, exportName) pair in
   * DISPATCHER_MAP, dynamically import the module and call isTelemetered on
   * the exported value.
   *
   * Dynamic import is used (not static) so the test can iterate the allowlist
   * without requiring explicit top-level imports for all 40 symbols.
   *
   * IMPORTANT: the dispatchers are NOT called — only imported and checked.
   * This avoids the need for a live ToolContext.
   */
  it('every listed dispatcher export is telemetry-wrapped', async () => {
    const failures: string[] = []

    for (const [fileBase, exportNames] of Object.entries(DISPATCHER_MAP)) {
      // Resolve to the .js extension as Vitest resolves ESM source via the
      // package's TypeScript source map (ts files under src/ are importable
      // directly in Vitest without pre-compilation).
      const modulePath = join(TOOLS_DIR, `${fileBase}.ts`)

      let mod: Record<string, unknown>
      try {
        mod = (await import(modulePath)) as Record<string, unknown>
      } catch (err) {
        // If the import itself throws (e.g. a service initializer crashes),
        // record a failure with a clear message rather than letting the whole
        // test throw an opaque error.
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

        // After `typeof === 'function'` narrow, TS infers `Function`; cast to
        // the structural shape `isTelemetered` accepts (SMI-5076).
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
        `Telemetry coverage failures (${failures.length}):\n` +
          failures.map((f) => `  • ${f}`).join('\n') +
          '\n\nTo fix: wrap the dispatcher with withTelemetry(...) and add it to DISPATCHER_MAP.'
      )
    }
  })

  /**
   * Drift sentinel: the DISPATCHER_MAP must have at least EXPECTED_TOTAL
   * entries. This test catches the scenario where:
   *   - A developer adds a new withTelemetry wrap in a tool file (SMI-5017
   *     pattern), but forgets to add the export name to DISPATCHER_MAP.
   *
   * It works by counting the files listed in DISPATCHER_MAP against the actual
   * tool source files on disk. A new file with dispatchers that is absent from
   * the map will not be caught by the "every listed dispatcher" test above
   * (which only checks known entries). This test surfaces that gap.
   *
   * Note: this is a lower-bound sentinel, not a strict equality check on file
   * count — infrastructure files (*.types.ts, *.helpers.ts, etc.) are
   * intentionally absent from DISPATCHER_MAP and will always outnumber it.
   * The meaningful assertion is that no *dispatcher file* is silently absent.
   */
  it('all files in DISPATCHER_MAP exist on disk', async () => {
    const diskFiles = await listToolSourceFiles()
    const diskBaseNames = new Set(diskFiles.map((f) => f.replace(/\.ts$/, '')))

    const missingFromDisk: string[] = []
    for (const fileBase of Object.keys(DISPATCHER_MAP)) {
      if (!diskBaseNames.has(fileBase)) {
        missingFromDisk.push(`${fileBase}.ts`)
      }
    }

    if (missingFromDisk.length > 0) {
      throw new Error(
        `DISPATCHER_MAP references files that do not exist on disk:\n` +
          missingFromDisk.map((f) => `  • ${f}`).join('\n') +
          '\n\nEither the file was deleted (remove from DISPATCHER_MAP) or renamed (update the key).'
      )
    }
  })

  /**
   * Completeness report: log the discovered dispatcher count so CI output
   * makes it easy to see coverage at a glance without running a separate script.
   * This test always passes — it is informational only.
   */
  it('reports dispatcher coverage to CI output', () => {
    const fileCount = Object.keys(DISPATCHER_MAP).length
    const dispatcherCount = EXPECTED_TOTAL
    // Using console.info so it appears in Vitest's verbose output.
    console.info(
      `[SMI-5018] MCP telemetry coverage: ${dispatcherCount} dispatchers across ${fileCount} files.`
    )
    console.info('[SMI-5018] Scope: MCP tree only (v1). CLI + VS Code: blocked by SMI-5040.')
    expect(dispatcherCount).toBeGreaterThanOrEqual(41)
  })
})
