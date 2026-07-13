/**
 * @fileoverview Unit tests for SMI-4590 Wave 4 PR 4 — `apply_namespace_rename`
 *               MCP tool.
 * @module @skillsmith/mcp-server/tests/unit/apply-namespace-rename
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §2
 *       + §Tests `apply-namespace-rename.test.ts`.
 *
 * Coverage (mirrors the spec checklist):
 *   1. `action: 'apply'` round-trips via the suggested name.
 *   2. `action: 'custom'` uses `customName`.
 *   3. `action: 'custom'` without `customName` → Zod validation error.
 *   4. `action: 'skip'` → no-op success.
 *   5. Missing `auditId` → `namespace.audit.history_not_found`.
 *   6. Missing `collisionId` → `namespace.audit.collision_not_found`.
 *   7. Idempotent re-apply → `fromPath === toPath`.
 *
 * Pattern: drive a real `skill_inventory_audit` first to populate a fresh
 * `~/.skillsmith/audits/<auditId>/` (history + suggestions) under a temp
 * HOME, then exercise the apply tool. Avoids re-deriving the audit-write
 * path under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { skillInventoryAudit } from '../../src/tools/skill-inventory-audit.js'
import {
  applyNamespaceRename,
  applyNamespaceRenameInputSchema,
  applyNamespaceRenameToolSchema,
} from '../../src/tools/apply-namespace-rename.js'
import { readLedger } from '../../src/audit/namespace-overrides.js'
import { readJournalRecords } from '@skillsmith/core/journal'
import type { SkillInventoryAuditResponse } from '../../src/tools/skill-inventory-audit.types.js'

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
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-apply-rename-'))
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

function plantSkill(home: string, identifier: string): string {
  const dir = path.join(home, '.claude', 'skills', identifier)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'SKILL.md')
  fs.writeFileSync(filePath, `---\nname: ${identifier}\ndescription: fixture\n---\n`, 'utf-8')
  return filePath
}

function plantCommand(home: string, identifier: string): string {
  const dir = path.join(home, '.claude', 'commands')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${identifier}.md`)
  fs.writeFileSync(filePath, `# ${identifier}\nbody\n`, 'utf-8')
  return filePath
}

/**
 * Set up an audit with one exact collision (skill `ship` + command `ship`).
 * Returns the audit response — the caller picks `renameSuggestions[0]`
 * for the apply call.
 */
async function seedAuditWithCollision(): Promise<SkillInventoryAuditResponse> {
  plantSkill(TEST_HOME, 'ship')
  const cmdPath = plantCommand(TEST_HOME, 'ship')
  // Command planted second; force its mtime ahead so the suggestion
  // targets the command (file-rename path is simpler to assert).
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(cmdPath, future, future)
  const response = await skillInventoryAudit({ homeDir: TEST_HOME })
  if (!('auditId' in response)) {
    throw new Error(`expected SkillInventoryAuditResponse, got error: ${JSON.stringify(response)}`)
  }
  return response
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('apply_namespace_rename — action: skip', () => {
  it('returns success without mutating disk', async () => {
    const audit = await seedAuditWithCollision()
    const cmdPath = path.join(TEST_HOME, '.claude', 'commands', 'ship.md')
    const before = fs.readFileSync(cmdPath, 'utf-8')

    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: audit.renameSuggestions[0]!.collisionId,
      action: 'skip',
    })
    expect(response.success).toBe(true)
    expect(response.result).toBeUndefined()
    // File untouched.
    expect(fs.readFileSync(cmdPath, 'utf-8')).toBe(before)
  })
})

describe('apply_namespace_rename — action: apply', () => {
  it('renames the file via the suggested name and returns the Wave 2 result', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!
    const cmdPath = path.join(TEST_HOME, '.claude', 'commands', 'ship.md')
    expect(fs.existsSync(cmdPath)).toBe(true)

    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
      confirmed: true,
    })
    expect(response.success).toBe(true)
    expect(response.result).toBeDefined()
    expect(response.result?.success).toBe(true)
    // Source path no longer exists; target does.
    expect(fs.existsSync(cmdPath)).toBe(false)
    expect(fs.existsSync(response.result!.toPath)).toBe(true)
  })
})

describe('apply_namespace_rename — confirmation gate (SMI-5213)', () => {
  it('returns a non-mutating preview when confirmed is omitted', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!
    const cmdPath = path.join(TEST_HOME, '.claude', 'commands', 'ship.md')
    const before = fs.readFileSync(cmdPath, 'utf-8')

    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
    })
    expect(response.success).toBe(true)
    expect(response.preview).toBe(true)
    expect(response.applied).toBe(false)
    expect(response.result).toBeUndefined()
    expect(response.action).toBe(suggestion.applyAction)
    expect(response.before).toBe(suggestion.currentName)
    expect(response.after).toBe(suggestion.suggested)
    expect(response.direction).toBe('apply')
    // File untouched.
    expect(fs.existsSync(cmdPath)).toBe(true)
    expect(fs.readFileSync(cmdPath, 'utf-8')).toBe(before)
  })

  it('returns a non-mutating preview when confirmed is explicitly false', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!
    const cmdPath = path.join(TEST_HOME, '.claude', 'commands', 'ship.md')

    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
      confirmed: false,
    })
    expect(response.success).toBe(true)
    expect(response.preview).toBe(true)
    expect(response.applied).toBe(false)
    expect(fs.existsSync(cmdPath)).toBe(true)
  })

  it('previews the custom name when action is custom and confirmed is omitted', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!

    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'custom',
      customName: 'ship-preview-custom',
    })
    expect(response.success).toBe(true)
    expect(response.preview).toBe(true)
    expect(response.after).toBe('ship-preview-custom')
    expect(response.result).toBeUndefined()
  })
})

describe('apply_namespace_rename — action: custom', () => {
  it('renames the file via the custom name', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!

    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'custom',
      customName: 'ship-custom-explicit',
      confirmed: true,
    })
    expect(response.success).toBe(true)
    expect(response.result?.success).toBe(true)
    expect(response.result?.toPath).toContain('ship-custom-explicit.md')
  })

  it('rejects custom action without customName via Zod refinement', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!

    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'custom',
      // customName intentionally omitted
    })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.invalid_input')
    expect(response.error).toContain('customName is required')
  })

  it('rejects customName when action !== "custom" (clean-surface guard)', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!

    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
      customName: 'should-not-be-here',
    })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.invalid_input')
  })
})

describe('apply_namespace_rename — failure modes', () => {
  it('returns history_not_found for an unknown auditId', async () => {
    const response = await applyNamespaceRename({
      auditId: 'AUDITDOESNTEXIST00000000',
      collisionId: 'whatever',
      action: 'apply',
    })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.history_not_found')
  })

  it('returns collision_not_found when collisionId is unknown in audit', async () => {
    const audit = await seedAuditWithCollision()
    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: 'collisionDoesNotExist',
      action: 'apply',
    })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.collision_not_found')
  })

  it('returns collision_not_found for action: revert same as for apply (SMI-5671)', async () => {
    const audit = await seedAuditWithCollision()
    const response = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: 'collisionDoesNotExist',
      action: 'revert',
      confirmed: true,
    })
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.collision_not_found')
  })
})

describe('apply_namespace_rename — idempotent re-apply', () => {
  it('returns fromPath === toPath on second call (Wave 2 ledger no-op)', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!

    const first = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
      confirmed: true,
    })
    expect(first.success).toBe(true)
    expect(first.result?.success).toBe(true)

    const second = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
      confirmed: true,
    })
    expect(second.success).toBe(true)
    expect(second.result?.success).toBe(true)
    expect(second.result?.fromPath).toBe(second.result?.toPath)
    expect(second.result?.backupPath).toBe('')
  })
})

// ---------------------------------------------------------------------------
// SMI-5671: action: 'revert'
// ---------------------------------------------------------------------------

describe('apply_namespace_rename — action: revert', () => {
  it('reverts a previously applied rename through the tool (apply → revert round-trip)', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!
    const cmdPath = path.join(TEST_HOME, '.claude', 'commands', 'ship.md')

    const applied = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
      confirmed: true,
    })
    expect(applied.success).toBe(true)
    expect(applied.result?.success).toBe(true)
    const renamedPath = applied.result!.toPath
    expect(fs.existsSync(cmdPath)).toBe(false)
    expect(fs.existsSync(renamedPath)).toBe(true)

    const reverted = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'revert',
      confirmed: true,
    })
    expect(reverted.success).toBe(true)
    expect(reverted.result?.success).toBe(true)
    expect(reverted.noOp).toBe(false)
    // Original file restored; renamed file gone — a genuine round-trip,
    // not just a ledger-entry removal.
    expect(fs.existsSync(cmdPath)).toBe(true)
    expect(fs.existsSync(renamedPath)).toBe(false)

    const ledger = await readLedger()
    expect(ledger.overrides).toHaveLength(0)

    // The journal must record this as a genuine 'revert' — NOT mislabeled
    // as 'apply' (the journal helper's action field used to be hardcoded)
    // or as 'idempotent_no_op' (revert has no fresh backupRef by design,
    // which used to be conflated with "nothing changed").
    const records = await readJournalRecords()
    const revertRecord = records.at(-1)
    expect(revertRecord?.action).toBe('revert')
    expect(revertRecord?.detail).not.toBe('idempotent_no_op')
  })

  it('returns a non-mutating preview with swapped before/after and direction: revert', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!

    const applied = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
      confirmed: true,
    })
    expect(applied.success).toBe(true)
    const renamedPath = applied.result!.toPath

    const preview = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'revert',
    })
    expect(preview.success).toBe(true)
    expect(preview.preview).toBe(true)
    expect(preview.applied).toBe(false)
    expect(preview.direction).toBe('revert')
    // Swapped vs. the apply/custom preview: "before" is the currently
    // renamed name, "after" is the original identifier being restored.
    expect(preview.before).toBe(suggestion.suggested)
    expect(preview.after).toBe(suggestion.currentName)
    expect(preview.result).toBeUndefined()

    // Preview must not mutate anything.
    expect(fs.existsSync(renamedPath)).toBe(true)
  })

  it('returns noOp: true when reverting an auditId/collisionId with no matching ledger entry', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!
    const cmdPath = path.join(TEST_HOME, '.claude', 'commands', 'ship.md')

    // No apply call was made — the ledger has no entry for this audit at all.
    const reverted = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'revert',
      confirmed: true,
    })
    expect(reverted.success).toBe(true)
    expect(reverted.noOp).toBe(true)
    expect(reverted.result?.fromPath).toBe(reverted.result?.toPath)
    expect(reverted.result?.backupPath).toBe('')
    // Idempotent no-op — nothing on disk changed.
    expect(fs.existsSync(cmdPath)).toBe(true)

    // A genuine no-op (no matching ledger entry) is still journaled as
    // 'idempotent_no_op' — this is the one case where that detail is
    // actually correct, unlike a real revert.
    const records = await readJournalRecords()
    const revertRecord = records.at(-1)
    expect(revertRecord?.action).toBe('revert')
    expect(revertRecord?.detail).toBe('idempotent_no_op')
  })

  it('returns an explicit error (not a silent no-op) when the renamed path is missing on disk', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!

    const applied = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
      confirmed: true,
    })
    expect(applied.success).toBe(true)
    const renamedPath = applied.result!.toPath

    // Simulate the renamed file having been manually deleted since the
    // apply — the ledger still says it lives at renamedPath.
    fs.rmSync(renamedPath, { force: true })

    const reverted = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'revert',
      confirmed: true,
    })
    expect(reverted.success).toBe(false)
    expect(reverted.errorCode).toBe('namespace.rename.subcall_failed')
    expect(reverted.result?.error?.kind).toBe('namespace.ledger.disk_divergence')
    // Not surfaced as a no-op — `noOp` is only computed on the success path.
    expect(reverted.noOp).toBeUndefined()

    // The ledger entry must NOT be silently removed on a divergence refusal.
    const ledger = await readLedger()
    expect(ledger.overrides).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// SMI-5671: schema-drift guardrail
// ---------------------------------------------------------------------------

describe('apply_namespace_rename — schema drift guardrail', () => {
  it('keeps the hand-written JSON Schema action enum in sync with the Zod schema', () => {
    const zodValues = applyNamespaceRenameInputSchema.innerType().shape.action.options
    const jsonSchemaValues = applyNamespaceRenameToolSchema.inputSchema.properties.action.enum
    expect(new Set(jsonSchemaValues)).toEqual(new Set(zodValues))
    expect(jsonSchemaValues).toHaveLength(zodValues.length)
  })
})
