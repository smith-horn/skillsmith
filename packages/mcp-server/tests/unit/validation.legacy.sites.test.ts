/**
 * SMI-7168: every place that turns a zod failure into text for a client or log
 * must keep zod 3's wording. The shared envelope (`safeParseOrError`) is pinned
 * in input-schema-parity.test.ts; this file pins the other call sites that read
 * `issue.message` themselves, each through its real exported tool function.
 * All of them reject before touching the filesystem or the network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { legacyParse, legacySafeParse } from '../../src/validation.legacy.js'
import { installSkill } from '../../src/tools/install.js'
import { undoApply } from '../../src/tools/undo-apply.js'
import { applyManifestReconcile } from '../../src/tools/apply-manifest-reconcile.js'
import { applyNamespaceRename } from '../../src/tools/apply-namespace-rename.js'
import { applyRecommendedEditTool as applyRecommendedEdit } from '../../src/tools/apply-recommended-edit.js'
import { skillInventoryAudit } from '../../src/tools/skill-inventory-audit.js'
import { executeSkillRecoverSource } from '../../src/tools/skill-recover-source.js'
import { analyzeInputSchema, executeAnalyze } from '../../src/tools/analyze.js'
import { executeCompare } from '../../src/tools/compare.js'
import { executePublish } from '../../src/tools/publish.js'
import { executeRecommend } from '../../src/tools/recommend.js'
import { executeValidate } from '../../src/tools/validate.js'
import { executeSuggest } from '../../src/tools/suggest.js'
import { executeSkillDiff } from '../../src/tools/skill-diff.js'

const text = (value: unknown): string => JSON.stringify(value)

// SMI-6343 / Check 65: these cases feed invalid input, so no tool reaches a
// manifest write, but HOME points at a throwaway directory in case one ever does.
const sandboxHome = mkdtempSync(join(tmpdir(), 'smi-7168-home-'))
const realHome = process.env.HOME
beforeAll(() => {
  process.env.HOME = sandboxHome
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(sandboxHome, { recursive: true, force: true })
})

describe('issue.message call sites keep zod 3 wording', () => {
  it('install_skill: a missing required field', async () => {
    expect(text(await installSkill({}))).toContain('skillId: Required')
  })

  it('undo_apply: a wrong-typed field', async () => {
    const result = await undoApply({ count: 'x' })
    expect(result.error).toBe('Invalid undo_apply input: count: Expected number, received string')
  })

  it('apply_namespace_rename: an unknown enum value', async () => {
    const result = await applyNamespaceRename({ auditId: 'a', collisionId: 'c', action: 'bogus' })
    expect(result.error).toBe(
      "Invalid apply_namespace_rename input: action: Invalid enum value. Expected 'apply' | 'custom' | 'skip' | 'revert', received 'bogus'"
    )
  })

  it('apply_recommended_edit: two missing fields joined in order', async () => {
    const result = await applyRecommendedEdit({})
    expect(result.error).toBe(
      'Invalid apply_recommended_edit input: auditId: Required; collisionId: Required'
    )
  })

  it('apply_manifest_reconcile: an unknown enum value', async () => {
    const result = await applyManifestReconcile({ action: 'bogus' })
    expect(result.error).toContain(
      "action: Invalid enum value. Expected 'mark_local' | 'relink' | 'drop_entry' | 'verify' | 'revert', received 'bogus'"
    )
  })

  it('skill_inventory_audit: a wrong-typed field', async () => {
    expect(text(await skillInventoryAudit({ deep: 'x' }))).toContain(
      'deep: Expected boolean, received string'
    )
  })

  it('skill_recover_source: throws with zod 3 wording', async () => {
    await expect(executeSkillRecoverSource({ only: 'x' }, {} as never)).rejects.toThrow(
      'Invalid skill_recover_source input: only: Expected array, received string'
    )
  })
})

describe('direct .parse call sites, each through its real exported tool', () => {
  // These tools validate with `legacyParse` before doing anything else, and throw the ZodError.
  // zod 3 worded a wrong-typed value `Expected <type>, received <type>`; zod 4 says
  // `Invalid input: expected ...`. A site reverted to a bare `.parse(` would show the latter.
  const ctx = {} as never
  const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
    [
      'skill_analyze',
      () => executeAnalyze({ max_files: 'x' } as never),
      /Expected number, received string/,
    ],
    [
      'skill_compare',
      () => executeCompare({ skill_a: 1, skill_b: 'b' } as never, ctx),
      /Expected string, received number/,
    ],
    [
      'skill_publish',
      () => executePublish({ skill_path: 1 } as never),
      /Expected string, received number/,
    ],
    [
      'skill_recommend',
      () => executeRecommend({ limit: 'x' } as never, ctx),
      /Expected number, received string/,
    ],
    [
      'skill_validate',
      () => executeValidate({ skill_path: 1 } as never),
      /Expected string, received number/,
    ],
    [
      'skill_suggest',
      () => executeSuggest({ project_path: 1 } as never, ctx),
      /Expected string, received number/,
    ],
    [
      'skill_diff',
      () => executeSkillDiff({ skillId: 1, oldContent: 'o', newContent: 'n' } as never, ctx),
      /Expected string, received number/,
    ],
  ]

  it.each(cases)('%s throws with zod 3 wording', async (_name, call, wording) => {
    let thrown: unknown
    try {
      await call()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(z.ZodError)
    const message = (thrown as Error).message
    expect(message).toMatch(wording)
    expect(message).not.toMatch(/Invalid input: expected/)
  })
})

describe('legacyParse (the direct .parse call sites)', () => {
  it('throws a ZodError whose message carries zod 3 codes and wording', () => {
    let thrown: unknown
    try {
      legacyParse(analyzeInputSchema, { max_files: 0 })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(z.ZodError)
    const issues = (thrown as z.ZodError).issues
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('too_small')
    expect(issues[0].message).toBe('Number must be greater than or equal to 1')
  })

  it('returns parsed data (defaults applied) on success', () => {
    expect(legacyParse(analyzeInputSchema, {})).toEqual({
      path: '.',
      max_files: 1000,
      include_dev_deps: true,
    })
  })
})

describe('legacySafeParse leaves schema-written messages alone', () => {
  it('a message declared on the schema wins over the contextual error map', () => {
    const schema = z.object({ name: z.string().min(1, 'name is required') })
    const result = legacySafeParse(schema, { name: '' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toBe('name is required')
  })
})
