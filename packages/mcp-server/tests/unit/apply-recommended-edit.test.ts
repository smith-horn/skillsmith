/**
 * @fileoverview Unit tests for SMI-4590 Wave 4 PR 4 — `apply_recommended_edit`
 *               MCP tool + conditional registration in `audit-tool-dispatch`.
 * @module @skillsmith/mcp-server/tests/unit/apply-recommended-edit
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §3
 *       + §Tests `apply-recommended-edit.test.ts`.
 *
 * Coverage:
 *   1. Valid `auditId` + `collisionId` with `pattern: 'add_domain_qualifier'`
 *      → file mutated, response success.
 *   2. `collisionId` not in audit → typed error.
 *   3. Edit with `pattern: 'narrow_scope'` (not in registry) → typed error
 *      `edit.template_not_in_apply_registry`, file unchanged.
 *   4. **Tool registration**: live registry (non-empty) → name IS in
 *      `AUDIT_TOOL_NAMES`.
 *   5. **Tool registration**: empty registry (mocked at module load) → name
 *      NOT in `AUDIT_TOOL_NAMES`.
 *   6. Stale `before` snippet (file changed after audit) → typed error
 *      `edit.subcall_failed` carrying inner `edit.stale_before`.
 *
 * Pattern: write `~/.skillsmith/audits/<auditId>/suggestions.json` directly
 * with a fixture `RecommendedEdit`. Drives the tool against a hand-rolled
 * audit dir without depending on the semantic-pass pipeline (which would
 * require OverlapDetector + EmbeddingService setup at the unit level).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { applyRecommendedEditTool } from '../../src/tools/apply-recommended-edit.js'
import { writeAuditSuggestions } from '../../src/audit/audit-suggestions.js'
import type { CollisionId, AuditId } from '../../src/audit/collision-detector.types.js'
import type { RecommendedEdit, EditTemplatePattern } from '../../src/audit/edit-suggester.types.js'
import { writeAuditHistory } from '../../src/audit/audit-history.js'

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
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-apply-edit-'))
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

/**
 * Plant a SKILL.md fixture at `<home>/.claude/skills/<id>/SKILL.md` whose
 * description body matches a single-line edit window. Returns the file path.
 */
function plantSkillForEdit(home: string, identifier: string, description: string): string {
  const dir = path.join(home, '.claude', 'skills', identifier)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'SKILL.md')
  const content = `---\nname: ${identifier}\ndescription: ${description}\n---\n\n# ${identifier}\n`
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/** Locate the 1-indexed line containing `description: <text>` in the file. */
function findDescriptionLine(filePath: string, description: string): number {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `description: ${description}`) return i + 1
  }
  throw new Error('description line not found')
}

/**
 * Persist a fixture audit + suggestions pair under HOME's
 * `.skillsmith/audits/<auditId>/`. Returns the auditId + collisionId so
 * the tool call can FK against them.
 */
async function seedAuditWithEdit(
  filePath: string,
  description: string,
  pattern: EditTemplatePattern = 'add_domain_qualifier'
): Promise<{ auditId: string; collisionId: CollisionId; edit: RecommendedEdit }> {
  const auditId = '01J6Z3M0CK4N0R3MCDEFGHJK10' as AuditId // ULID-shaped fixture
  const collisionId = 'collisionFixture0' as CollisionId
  // Write a minimal InventoryAuditResult so readAuditHistory + the
  // result.json path are populated. The tool only reads suggestions.json
  // for edit lookup, but the `<auditDir>` exists check is shared.
  const lineNumber = findDescriptionLine(filePath, description)
  const edit: RecommendedEdit = {
    collisionId,
    category: 'description_overlap',
    pattern,
    filePath,
    lineRange: { start: lineNumber, end: lineNumber },
    before: `description: ${description}`,
    after: `description: ${description} (qualified)`,
    rationale: 'unit fixture rationale',
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
  return { auditId, collisionId, edit }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('apply_recommended_edit — happy path', () => {
  it('mutates the file when pattern is in APPLY_TEMPLATE_REGISTRY', async () => {
    const description = 'deploy code to production'
    const filePath = plantSkillForEdit(TEST_HOME, 'fixture', description)
    const { auditId, collisionId } = await seedAuditWithEdit(filePath, description)

    const response = await applyRecommendedEditTool({ auditId, collisionId })
    expect(response.success).toBe(true)
    expect(response.result?.success).toBe(true)
    // File mutated: original line replaced with the templated version.
    const fileBody = fs.readFileSync(filePath, 'utf-8')
    expect(fileBody).toContain('description: deploy code to production (qualified)')
  })
})

describe('apply_recommended_edit — registry guard', () => {
  it('rejects pattern: "narrow_scope" with edit.template_not_in_apply_registry', async () => {
    const description = 'narrow this scope please'
    const filePath = plantSkillForEdit(TEST_HOME, 'fixture-narrow', description)
    const { auditId, collisionId } = await seedAuditWithEdit(filePath, description, 'narrow_scope')
    const before = fs.readFileSync(filePath, 'utf-8')

    const response = await applyRecommendedEditTool({ auditId, collisionId })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('edit.template_not_in_apply_registry')
    // File untouched — registry guard rejects before any mutation.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before)
  })
})

describe('apply_recommended_edit — failure modes', () => {
  it('returns history_not_found for an unknown auditId', async () => {
    const response = await applyRecommendedEditTool({
      auditId: 'AUDITDOESNTEXIST00000000',
      collisionId: 'whatever',
    })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.history_not_found')
  })

  it('returns collision_not_found when collisionId is unknown', async () => {
    const description = 'fixture description'
    const filePath = plantSkillForEdit(TEST_HOME, 'fixture-x', description)
    const { auditId } = await seedAuditWithEdit(filePath, description)
    const response = await applyRecommendedEditTool({
      auditId,
      collisionId: 'unknownCollision000',
    })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.collision_not_found')
  })

  it('returns subcall_failed with inner edit.stale_before when the file was modified after audit', async () => {
    const description = 'file will drift'
    const filePath = plantSkillForEdit(TEST_HOME, 'fixture-stale', description)
    const { auditId, collisionId } = await seedAuditWithEdit(filePath, description)

    // Mutate the file out from under the recorded `before`.
    fs.writeFileSync(
      filePath,
      `---\nname: fixture-stale\ndescription: completely different now\n---\n`,
      'utf-8'
    )

    const response = await applyRecommendedEditTool({ auditId, collisionId })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('edit.subcall_failed')
    expect(response.error).toContain('edit.stale_before')
  })
})

describe('apply_recommended_edit — Zod validation', () => {
  it('rejects unknown top-level fields', async () => {
    const response = await applyRecommendedEditTool({
      auditId: 'A',
      collisionId: 'B',
      bogus: true,
    } as unknown)
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.invalid_input')
  })
})

// ---------------------------------------------------------------------------
// Conditional registration (audit-tool-dispatch.AUDIT_TOOL_NAMES)
// ---------------------------------------------------------------------------

describe('audit-tool-dispatch — apply_recommended_edit conditional registration', () => {
  it('lists apply_recommended_edit when APPLY_TEMPLATE_REGISTRY is non-empty (live state)', async () => {
    // Live state: registry contains 'add_domain_qualifier'.
    const dispatch = await import('../../src/audit-tool-dispatch.js')
    expect(dispatch.AUDIT_TOOL_NAMES.has('apply_recommended_edit')).toBe(true)
    expect(dispatch.isAuditToolName('apply_recommended_edit')).toBe(true)
  })

  it('omits apply_recommended_edit when APPLY_TEMPLATE_REGISTRY is empty', async () => {
    // Defense-in-depth: when the registry is empty (rollback), the
    // dispatcher must hide the tool. Mock the module BEFORE importing the
    // dispatcher fresh to exercise the module-init guard.
    vi.resetModules()
    vi.doMock('../../src/audit/edit-applier.js', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>
      return {
        ...actual,
        APPLY_TEMPLATE_REGISTRY: new Set<EditTemplatePattern>(),
      }
    })
    try {
      const dispatch = await import('../../src/audit-tool-dispatch.js')
      expect(dispatch.AUDIT_TOOL_NAMES.has('apply_recommended_edit')).toBe(false)
      expect(dispatch.isAuditToolName('apply_recommended_edit')).toBe(false)
      // Sibling tools still listed.
      expect(dispatch.AUDIT_TOOL_NAMES.has('skill_inventory_audit')).toBe(true)
      expect(dispatch.AUDIT_TOOL_NAMES.has('apply_namespace_rename')).toBe(true)
    } finally {
      vi.doUnmock('../../src/audit/edit-applier.js')
      vi.resetModules()
    }
  })
})
