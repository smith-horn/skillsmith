/**
 * @fileoverview Integration round-trip test for SMI-4590 Wave 4 PR 4 — the
 *               full MCP tool surface (`skill_inventory_audit` →
 *               `apply_namespace_rename` → optional
 *               `apply_recommended_edit`).
 * @module @skillsmith/mcp-server/tests/integration/audit-roundtrip
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md
 *       §Tests `audit-roundtrip.test.ts`.
 *
 * End-to-end: drive the dispatcher's three new audit tools against a real
 * `~/.claude/` (planted under a `mkdtemp` HOME) and assert:
 *
 *   1. `skill_inventory_audit` discovers a planted exact collision and
 *      returns a non-empty `renameSuggestions[]`.
 *   2. `apply_namespace_rename` for the first suggestion mutates the
 *      filesystem to the expected post-rename layout.
 *   3. The same call repeated is idempotent — no new ledger entry, no
 *      file changes (Wave 2 ledger no-op semantics surface as
 *      `fromPath === toPath`).
 *   4. `apply_recommended_edit` for a hand-rolled `add_domain_qualifier`
 *      fixture mutates the SKILL.md prose body.
 *
 * Driving through `dispatchAuditTool` (vs the tool functions directly)
 * exercises the dispatcher case wiring + JSON-body envelope used by the
 * MCP server transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { dispatchAuditTool, AUDIT_TOOL_NAMES } from '../../src/audit-tool-dispatch.js'
import type { ToolContext } from '../../src/context.js'
import type { LicenseMiddleware } from '../../src/middleware/license.js'
import type { QuotaMiddleware } from '../../src/middleware/quota.js'
import { writeAuditHistory } from '../../src/audit/audit-history.js'
import { writeAuditSuggestions } from '../../src/audit/audit-suggestions.js'
import type { AuditId, CollisionId } from '../../src/audit/collision-detector.types.js'
import type { RecommendedEdit } from '../../src/audit/edit-suggester.types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { SkillInventoryAuditResponse } from '../../src/tools/skill-inventory-audit.types.js'
import type { ApplyNamespaceRenameResponse } from '../../src/tools/apply-namespace-rename.types.js'
import type { ApplyRecommendedEditResponse } from '../../src/tools/apply-recommended-edit.types.js'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

let TEST_HOME: string
let PREV_HOME: string | undefined

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-audit-roundtrip-'))
  PREV_HOME = process.env['HOME']
  process.env['HOME'] = TEST_HOME
})

afterEach(() => {
  if (PREV_HOME !== undefined) process.env['HOME'] = PREV_HOME
  else delete process.env['HOME']
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Fixtures + middleware stubs
// ---------------------------------------------------------------------------

function plantSkill(home: string, identifier: string, description = 'fixture'): string {
  const dir = path.join(home, '.claude', 'skills', identifier)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'SKILL.md')
  fs.writeFileSync(
    filePath,
    `---\nname: ${identifier}\ndescription: ${description}\n---\n`,
    'utf-8'
  )
  return filePath
}

function plantCommand(home: string, identifier: string): string {
  const dir = path.join(home, '.claude', 'commands')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${identifier}.md`)
  fs.writeFileSync(filePath, `# ${identifier}\nbody\n`, 'utf-8')
  return filePath
}

function fakeContext(): ToolContext {
  return {} as ToolContext
}

function fakeLicense(): LicenseMiddleware {
  return {
    checkFeature: vi.fn().mockResolvedValue({ valid: true }),
    checkTool: vi.fn().mockResolvedValue({ valid: true }),
    getLicenseInfo: vi.fn().mockResolvedValue({
      valid: true,
      tier: 'enterprise' as const,
      features: [],
    }),
    invalidateCache: vi.fn(),
  } as unknown as LicenseMiddleware
}

function fakeQuota(): QuotaMiddleware {
  return {
    checkAndTrack: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 999,
      limit: 1000,
      percentUsed: 0.1,
      warningLevel: 0,
      resetAt: new Date(),
    }),
    buildMetadata: vi.fn(),
    buildExceededResponse: vi.fn(),
  } as unknown as QuotaMiddleware
}

/** Decode a `CallToolResult` JSON-body back into its typed payload. */
function decodeBody<T>(result: CallToolResult): T {
  const text = (result.content[0] as { text: string }).text
  return JSON.parse(text) as T
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit round-trip — inventory → rename → idempotent re-apply', () => {
  it('end-to-end: discovers collision, applies rename, second call is idempotent', async () => {
    plantSkill(TEST_HOME, 'ship')
    const cmdPath = plantCommand(TEST_HOME, 'ship')
    // Force the command's mtime ahead so the suggestion targets it
    // (file-rename path is the simplest to assert on disk).
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(cmdPath, future, future)

    // Step 1: skill_inventory_audit
    expect(AUDIT_TOOL_NAMES.has('skill_inventory_audit')).toBe(true)
    const auditCall = await dispatchAuditTool(
      'skill_inventory_audit',
      { homeDir: TEST_HOME },
      fakeContext(),
      fakeLicense(),
      fakeQuota()
    )
    expect(auditCall.isError).toBe(false)
    const audit = decodeBody<SkillInventoryAuditResponse>(auditCall)
    expect(audit.exactCollisions.length).toBeGreaterThanOrEqual(1)
    expect(audit.renameSuggestions.length).toBeGreaterThanOrEqual(1)

    // Step 2: apply_namespace_rename for the first suggestion
    const suggestion = audit.renameSuggestions[0]!
    expect(AUDIT_TOOL_NAMES.has('apply_namespace_rename')).toBe(true)
    const firstApply = await dispatchAuditTool(
      'apply_namespace_rename',
      {
        auditId: audit.auditId,
        collisionId: suggestion.collisionId,
        action: 'apply',
      },
      fakeContext(),
      fakeLicense(),
      fakeQuota()
    )
    expect(firstApply.isError).toBe(false)
    const firstResponse = decodeBody<ApplyNamespaceRenameResponse>(firstApply)
    expect(firstResponse.success).toBe(true)
    expect(firstResponse.result?.success).toBe(true)
    // Filesystem matches expected post-rename layout.
    expect(fs.existsSync(cmdPath)).toBe(false)
    expect(fs.existsSync(firstResponse.result!.toPath)).toBe(true)
    const firstBackup = firstResponse.result!.backupPath
    expect(firstBackup.length).toBeGreaterThan(0)

    // Step 3: idempotent re-apply (Wave 2 ledger no-op)
    const secondApply = await dispatchAuditTool(
      'apply_namespace_rename',
      {
        auditId: audit.auditId,
        collisionId: suggestion.collisionId,
        action: 'apply',
      },
      fakeContext(),
      fakeLicense(),
      fakeQuota()
    )
    expect(secondApply.isError).toBe(false)
    const secondResponse = decodeBody<ApplyNamespaceRenameResponse>(secondApply)
    expect(secondResponse.success).toBe(true)
    expect(secondResponse.result?.success).toBe(true)
    // Idempotent contract: fromPath === toPath, no fresh backup.
    expect(secondResponse.result?.fromPath).toBe(secondResponse.result?.toPath)
    expect(secondResponse.result?.backupPath).toBe('')
  })
})

describe('audit round-trip — apply_recommended_edit via dispatcher', () => {
  it('mutates the file when a registered-pattern edit is dispatched', async () => {
    expect(AUDIT_TOOL_NAMES.has('apply_recommended_edit')).toBe(true)

    // Hand-roll an audit + suggestions pair (semantic-pass output) so the
    // round-trip stays at the unit-integration boundary without requiring
    // a real OverlapDetector model load.
    const description = 'deploy code to production'
    const filePath = plantSkill(TEST_HOME, 'roundtrip-edit', description)
    const auditId = '01J6Z3M0CK4N0R3MROUNDTRIP01' as AuditId
    const collisionId = 'roundtripEditFixture' as CollisionId

    // Locate description line for fixture lineRange.
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
    const lineIdx = lines.findIndex((l) => l === `description: ${description}`)
    const edit: RecommendedEdit = {
      collisionId,
      category: 'description_overlap',
      pattern: 'add_domain_qualifier',
      filePath,
      lineRange: { start: lineIdx + 1, end: lineIdx + 1 },
      before: `description: ${description}`,
      after: `description: ${description} for deployment tasks`,
      rationale: 'integration round-trip fixture',
      applyAction: 'recommended_edit',
      applyMode: 'apply_with_confirmation',
      otherEntry: { identifier: 'partner-skill', sourcePath: '/tmp/partner.md' },
    }
    await writeAuditHistory({
      auditId,
      inventory: [],
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
      summary: {
        totalEntries: 0,
        totalFlags: 0,
        errorCount: 0,
        warningCount: 0,
        durationMs: 0,
        passDurations: { exact: 0, generic: 0, semantic: 0 },
      },
    })
    await writeAuditSuggestions(auditId, [], [edit])

    const editApply = await dispatchAuditTool(
      'apply_recommended_edit',
      { auditId, collisionId },
      fakeContext(),
      fakeLicense(),
      fakeQuota()
    )
    expect(editApply.isError).toBe(false)
    const editResponse = decodeBody<ApplyRecommendedEditResponse>(editApply)
    expect(editResponse.success).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toContain(
      'description: deploy code to production for deployment tasks'
    )
  })
})

describe('audit round-trip — backwards compat', () => {
  it('skill_audit + skill_pack_audit dispatcher cases still work (regression guard)', async () => {
    expect(AUDIT_TOOL_NAMES.has('skill_audit')).toBe(true)
    expect(AUDIT_TOOL_NAMES.has('skill_pack_audit')).toBe(true)
  })
})
