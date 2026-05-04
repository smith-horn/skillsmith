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
import { applyNamespaceRename } from '../../src/tools/apply-namespace-rename.js'
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
    })
    expect(response.success).toBe(true)
    expect(response.result).toBeDefined()
    expect(response.result?.success).toBe(true)
    // Source path no longer exists; target does.
    expect(fs.existsSync(cmdPath)).toBe(false)
    expect(fs.existsSync(response.result!.toPath)).toBe(true)
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
})

describe('apply_namespace_rename — idempotent re-apply', () => {
  it('returns fromPath === toPath on second call (Wave 2 ledger no-op)', async () => {
    const audit = await seedAuditWithCollision()
    const suggestion = audit.renameSuggestions[0]!

    const first = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
    })
    expect(first.success).toBe(true)
    expect(first.result?.success).toBe(true)

    const second = await applyNamespaceRename({
      auditId: audit.auditId,
      collisionId: suggestion.collisionId,
      action: 'apply',
    })
    expect(second.success).toBe(true)
    expect(second.result?.success).toBe(true)
    expect(second.result?.fromPath).toBe(second.result?.toPath)
    expect(second.result?.backupPath).toBe('')
  })
})
