/**
 * SMI-7168: the seven custom formatters that join `parsed.error.issues` must keep EVERY issue, in
 * order, in zod 3 wording. validation.legacy.sites.test.ts uses inputs that yield one issue, so a
 * formatter truncated to the first issue (`.slice(0, 1)`) stayed green. Each input below yields
 * two or three issues, and each expected string was captured from the real tool on zod 3.25.76
 * BEFORE the migration. The shared envelope's multi-issue output is covered by the per-case
 * exact comparison in input-schema-parity.test.ts (for example `share_skill/empty-object`).
 */
import { describe, it, expect } from 'vitest'
import { installSkill } from '../../src/tools/install.js'
import { undoApply } from '../../src/tools/undo-apply.js'
import { applyManifestReconcile } from '../../src/tools/apply-manifest-reconcile.js'
import { applyNamespaceRename } from '../../src/tools/apply-namespace-rename.js'
import { applyRecommendedEditTool } from '../../src/tools/apply-recommended-edit.js'
import { skillInventoryAudit } from '../../src/tools/skill-inventory-audit.js'
import { executeSkillRecoverSource } from '../../src/tools/skill-recover-source.js'

const errorOf = (result: unknown): string => (result as { error: string }).error

describe('multi-issue formatters keep every issue, in order, in zod 3 wording', () => {
  it('install_skill (two issues)', async () => {
    expect(errorOf(await installSkill({ skillId: 1, force: 'x' }))).toBe(
      'Invalid install input: skillId: Expected string, received number; force: Expected boolean, received string'
    )
  })

  it('undo_apply (two issues)', async () => {
    expect(errorOf(await undoApply({ count: 'x', suggestion_id: 1 }))).toBe(
      'Invalid undo_apply input: count: Expected number, received string; suggestion_id: Expected string, received number'
    )
  })

  it('apply_manifest_reconcile (two superRefine issues, the reviewer case)', async () => {
    expect(errorOf(await applyManifestReconcile({ action: 'relink' }))).toBe(
      "Invalid apply_manifest_reconcile input: name: 'name' is required when action === 'relink'; id: relink requires BOTH 'id' and 'source'"
    )
  })

  it('apply_namespace_rename (three issues, one an enum)', async () => {
    expect(errorOf(await applyNamespaceRename({ action: 'bogus' }))).toBe(
      "Invalid apply_namespace_rename input: auditId: Required; collisionId: Required; action: Invalid enum value. Expected 'apply' | 'custom' | 'skip' | 'revert', received 'bogus'"
    )
  })

  it('apply_recommended_edit (two issues)', async () => {
    expect(errorOf(await applyRecommendedEditTool({}))).toBe(
      'Invalid apply_recommended_edit input: auditId: Required; collisionId: Required'
    )
  })

  it('skill_inventory_audit (two issues)', async () => {
    expect(errorOf(await skillInventoryAudit({ deep: 'x', projectDir: 1 }))).toBe(
      'Invalid skill_inventory_audit input: deep: Expected boolean, received string; projectDir: Expected string, received number'
    )
  })

  it('skill_recover_source (two issues, thrown)', async () => {
    await expect(
      executeSkillRecoverSource({ only: 'x', embedding: 'y' }, {} as never)
    ).rejects.toThrow(
      new Error(
        'Invalid skill_recover_source input: only: Expected array, received string; embedding: Expected boolean, received string'
      )
    )
  })
})
