/**
 * SMI-7168 Wave 0: `tools/list` wire-shape contract for @skillsmith/mcp-server.
 *
 * Every mcp-server tool declares a hand-written JSON `inputSchema` literal, and
 * `src/index.ts` returns it verbatim. Nothing derives wire schemas from zod, so
 * the zod 3 to zod 4 migration must leave this output byte-identical. The file
 * snapshot was captured on zod 3.25.76 BEFORE the migration. A diff after the
 * bump means something started deriving schema from zod, which today nothing
 * does, and that is a wire change to be explained, not a snapshot to update.
 *
 * The snapshot file ends in `.snap`, not `.json`, on purpose: the pre-commit
 * prettier pass rewrites every `*.json` (it collapses short arrays), which would
 * silently change the bytes this test compares.
 *
 * The array below mirrors `toolDefinitions` in `src/index.ts` and the `.map()`
 * in its ListTools handler. `index.ts` cannot be imported (it starts a server
 * at module load), so the list is repeated here; the count assertion keeps the
 * two from drifting silently.
 */
import { describe, it, expect } from 'vitest'

import { searchToolSchema } from '../../src/tools/search.js'
import { getSkillToolSchema } from '../../src/tools/get-skill.js'
import { installTool } from '../../src/tools/install.js'
import { uninstallTool } from '../../src/tools/uninstall.js'
import { recommendToolSchema } from '../../src/tools/recommend.js'
import { validateToolSchema } from '../../src/tools/validate.js'
import { compareToolSchema } from '../../src/tools/compare.js'
import { suggestToolSchema } from '../../src/tools/suggest.js'
import { indexLocalToolSchema } from '../../src/tools/index-local.js'
import { publishToolSchema } from '../../src/tools/publish.js'
import { skillUpdatesToolSchema } from '../../src/tools/skill-updates.js'
import { skillDiffToolSchema } from '../../src/tools/skill-diff.js'
import { skillAuditToolSchema } from '../../src/tools/skill-audit.js'
import { skillPackAuditToolSchema } from '../../src/tools/skill-pack-audit.js'
import { outdatedToolSchema } from '../../src/tools/outdated.js'
import { skillRescanToolSchema } from '../../src/tools/skill-rescan.js'
import {
  auditExportToolSchema,
  auditQueryToolSchema,
  siemExportToolSchema,
} from '../../src/tools/audit-tools.js'
import { teamWorkspaceToolSchema, shareSkillToolSchema } from '../../src/tools/team-workspace.js'
import { publishPrivateToolSchema } from '../../src/tools/publish-private.js'
import {
  teamAnalyticsDashboardToolSchema,
  teamUsageReportToolSchema,
  analyticsDashboardToolSchema,
  usageReportToolSchema,
} from '../../src/tools/analytics.js'
import { configureSsoToolSchema, ssoSettingsToolSchema } from '../../src/tools/sso-tools.js'
import {
  privateRegistryPublishToolSchema,
  privateRegistryManageToolSchema,
} from '../../src/tools/registry-tools.js'
import {
  rbacManageToolSchema,
  rbacAssignRoleToolSchema,
  rbacCreatePolicyToolSchema,
} from '../../src/tools/rbac-tools.js'
import {
  webhookConfigureToolSchema,
  apiKeyManageToolSchema,
} from '../../src/tools/integration-tools.js'
import { complianceReportToolSchema } from '../../src/tools/compliance-tools.js'
import { inventoryPushToolSchema } from '../../src/tools/inventory-push.js'
import { newAuditToolDefinitions } from '../../src/audit-tool-dispatch.js'
import { provenanceToolDefinitions } from '../../src/provenance-tool-dispatch.js'
import { filterToolsForAgentProfile } from '../../src/middleware/toolProfile.js'

type WireMeta = { title?: unknown; annotations?: unknown; outputSchema?: unknown }

const toolDefinitions: Array<{ name: string; description: string; inputSchema: unknown }> = [
  searchToolSchema,
  getSkillToolSchema,
  installTool,
  uninstallTool,
  recommendToolSchema,
  validateToolSchema,
  compareToolSchema,
  suggestToolSchema,
  indexLocalToolSchema,
  publishToolSchema,
  skillUpdatesToolSchema,
  skillDiffToolSchema,
  skillAuditToolSchema,
  skillPackAuditToolSchema,
  outdatedToolSchema,
  skillRescanToolSchema,
  auditExportToolSchema,
  auditQueryToolSchema,
  siemExportToolSchema,
  teamWorkspaceToolSchema,
  shareSkillToolSchema,
  publishPrivateToolSchema,
  teamAnalyticsDashboardToolSchema,
  teamUsageReportToolSchema,
  analyticsDashboardToolSchema,
  usageReportToolSchema,
  configureSsoToolSchema,
  ssoSettingsToolSchema,
  privateRegistryPublishToolSchema,
  privateRegistryManageToolSchema,
  rbacManageToolSchema,
  rbacAssignRoleToolSchema,
  rbacCreatePolicyToolSchema,
  webhookConfigureToolSchema,
  apiKeyManageToolSchema,
  complianceReportToolSchema,
  inventoryPushToolSchema,
  ...newAuditToolDefinitions(),
  ...provenanceToolDefinitions(),
]

/** Same shape `src/index.ts` emits per tool; empty env so no agent-profile filtering. */
function wireTools(): unknown[] {
  return filterToolsForAgentProfile(toolDefinitions, {}).map((tool) => {
    const meta = tool as WireMeta
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.annotations !== undefined ? { annotations: meta.annotations } : {}),
      ...(meta.outputSchema !== undefined ? { outputSchema: meta.outputSchema } : {}),
    }
  })
}

describe('mcp-server tools/list wire contract (zod 3 baseline)', () => {
  it('lists every tool once, with no duplicate names', () => {
    const names = wireTools().map((t) => (t as { name: string }).name)
    expect(new Set(names).size).toBe(names.length)
    // 37 fixed entries + 5 audit-family + 1 provenance (see src/index.ts).
    expect(names).toHaveLength(43)
    expect(names).toEqual(expect.arrayContaining(['search', 'get_skill', 'install_skill']))
  })

  it('is byte-identical to the pre-migration (zod 3) snapshot', async () => {
    await expect(JSON.stringify(wireTools(), null, 2) + '\n').toMatchFileSnapshot(
      './__snapshots__/tools-list.wire.snap'
    )
  })

  it('carries no zod-derived marker in any inputSchema', () => {
    // Nothing in this package derives wire schemas from zod. A zod-emitted
    // schema would carry `$schema` or `~standard`; the hand-written literals
    // do not.
    const serialized = JSON.stringify(wireTools())
    expect(serialized).not.toContain('"$schema"')
    expect(serialized).not.toContain('~standard')
  })
})
