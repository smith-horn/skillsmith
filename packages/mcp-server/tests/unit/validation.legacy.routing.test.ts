/**
 * SMI-7168: proves each of the 14 tool call sites routes its schema through the legacy helper,
 * independent of which zod major is installed.
 *
 * validation.legacy.sites.test.ts pins the wording a client sees, but on zod 3 a bare `.parse(`
 * produces the same wording, so those tests discriminate only on zod 4. Here the helper module is
 * wrapped in a pass-through spy (vi.mock replaces it for every importer, including the tool
 * modules, so ESM bindings are covered) and each tool must call the helper with ITS schema and the
 * raw input. A site reverted to `schema.parse(input)` never touches the spy and fails on any zod.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/validation.legacy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/validation.legacy.js')>()
  return {
    ...actual,
    legacyParse: vi.fn(actual.legacyParse),
    legacySafeParse: vi.fn(actual.legacySafeParse),
  }
})

import { legacyParse, legacySafeParse } from '../../src/validation.legacy.js'
import { installSkill } from '../../src/tools/install.js'
import { installInputSchema } from '../../src/tools/install.types.js'
import { undoApply, undoApplyInputSchema } from '../../src/tools/undo-apply.js'
import {
  applyManifestReconcile,
  applyManifestReconcileInputSchema,
} from '../../src/tools/apply-manifest-reconcile.js'
import {
  applyNamespaceRename,
  applyNamespaceRenameInputSchema,
} from '../../src/tools/apply-namespace-rename.js'
import {
  applyRecommendedEditTool,
  applyRecommendedEditInputSchema,
} from '../../src/tools/apply-recommended-edit.js'
import {
  skillInventoryAudit,
  skillInventoryAuditInputSchema,
} from '../../src/tools/skill-inventory-audit.js'
import {
  executeSkillRecoverSource,
  skillRecoverSourceInputSchema,
} from '../../src/tools/skill-recover-source.js'
import { analyzeInputSchema, executeAnalyze } from '../../src/tools/analyze.js'
import { executeCompare } from '../../src/tools/compare.js'
import { compareInputSchema } from '../../src/tools/compare.types.js'
import { executePublish } from '../../src/tools/publish.js'
import { publishInputSchema } from '../../src/tools/publish.types.js'
import { executeRecommend } from '../../src/tools/recommend.js'
import { recommendInputSchema } from '../../src/tools/recommend.types.js'
import { executeValidate } from '../../src/tools/validate.js'
import { validateInputSchema } from '../../src/tools/validate.types.js'
import { executeSuggest, suggestInputSchema } from '../../src/tools/suggest.js'
import { executeSkillDiff, skillDiffInputSchema } from '../../src/tools/skill-diff.js'

const ctx = {} as never

beforeEach(() => {
  vi.mocked(legacyParse).mockClear()
  vi.mocked(legacySafeParse).mockClear()
})

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

describe('sites that used schema.parse(input) call legacyParse with their own schema', () => {
  const sites: Array<[string, unknown, unknown, () => Promise<unknown>]> = [
    [
      'skill_analyze',
      analyzeInputSchema,
      { max_files: 'x' },
      () => executeAnalyze({ max_files: 'x' } as never),
    ],
    [
      'skill_compare',
      compareInputSchema,
      { skill_a: 1 },
      () => executeCompare({ skill_a: 1 } as never, ctx),
    ],
    [
      'skill_publish',
      publishInputSchema,
      { skill_path: 1 },
      () => executePublish({ skill_path: 1 } as never),
    ],
    [
      'skill_recommend',
      recommendInputSchema,
      { limit: 'x' },
      () => executeRecommend({ limit: 'x' } as never, ctx),
    ],
    [
      'skill_validate',
      validateInputSchema,
      { skill_path: 1 },
      () => executeValidate({ skill_path: 1 } as never),
    ],
    [
      'skill_suggest',
      suggestInputSchema,
      { project_path: 1 },
      () => executeSuggest({ project_path: 1 } as never, ctx),
    ],
    [
      'skill_diff',
      skillDiffInputSchema,
      { skillId: 1 },
      () => executeSkillDiff({ skillId: 1 } as never, ctx),
    ],
  ]

  it.each(sites)('%s', async (_name, schema, input, call) => {
    await call().catch(() => undefined) // each rejects on the bad input; only the routing matters
    expect(vi.mocked(legacyParse)).toHaveBeenCalledTimes(1)
    const [usedSchema, usedInput] = vi.mocked(legacyParse).mock.calls[0]
    expect(usedSchema).toBe(schema)
    expect(usedInput).toEqual(input)
  })
})

describe('sites that used schema.safeParse(input) call legacySafeParse with their own schema', () => {
  const sites: Array<[string, unknown, unknown, () => Promise<unknown>]> = [
    ['install_skill', installInputSchema, {}, () => installSkill({})],
    ['undo_apply', undoApplyInputSchema, { count: 'x' }, () => undoApply({ count: 'x' })],
    [
      'apply_manifest_reconcile',
      applyManifestReconcileInputSchema,
      { action: 'bogus' },
      () => applyManifestReconcile({ action: 'bogus' }),
    ],
    [
      'apply_namespace_rename',
      applyNamespaceRenameInputSchema,
      { action: 'bogus' },
      () => applyNamespaceRename({ action: 'bogus' }),
    ],
    [
      'apply_recommended_edit',
      applyRecommendedEditInputSchema,
      {},
      () => applyRecommendedEditTool({}),
    ],
    [
      'skill_inventory_audit',
      skillInventoryAuditInputSchema,
      { deep: 'x' },
      () => skillInventoryAudit({ deep: 'x' }),
    ],
    [
      'skill_recover_source',
      skillRecoverSourceInputSchema,
      { only: 'x' },
      () => executeSkillRecoverSource({ only: 'x' }, ctx),
    ],
  ]

  it.each(sites)('%s', async (_name, schema, input, call) => {
    await call().catch(() => undefined)
    expect(vi.mocked(legacySafeParse)).toHaveBeenCalledTimes(1)
    const [usedSchema, usedInput] = vi.mocked(legacySafeParse).mock.calls[0]
    expect(usedSchema).toBe(schema)
    expect(usedInput).toEqual(input)
  })
})
