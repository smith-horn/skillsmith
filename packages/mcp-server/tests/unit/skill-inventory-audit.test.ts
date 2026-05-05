/**
 * @fileoverview Unit tests for SMI-4590 Wave 4 PR 4 — `skill_inventory_audit`
 *               MCP tool.
 * @module @skillsmith/mcp-server/tests/unit/skill-inventory-audit
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §1
 *       + §Tests `skill-inventory-audit.test.ts`.
 *
 * Coverage (mirrors the spec checklist):
 *   1. Empty `~/.claude/` → empty arrays + populated `auditId` + on-disk report.
 *   2. Planted exact collision → `exactCollisions[]` + `renameSuggestions[]`.
 *   3. `deep: false` → `semanticCollisions: []`.
 *   4. Zod rejects unknown fields → typed validation envelope.
 *   5. `homeDir` outside allowed roots → typed `invalid_home_dir`.
 *   6. Audit-history round-trip via `readAuditHistory`.
 *   7. `applyExclusions: true` (default) — matching exclusions filter.
 *   8. `applyExclusions: false` — exclusions ignored.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { skillInventoryAudit } from '../../src/tools/skill-inventory-audit.js'
import { readAuditHistory } from '../../src/audit/audit-history.js'
import type { SkillInventoryAuditResponse } from '../../src/tools/skill-inventory-audit.types.js'
import type { InventoryAuditValidationError } from '../../src/tools/skill-inventory-audit.js'

// Telemetry stub — `detectCollisions` fires aggregate fetch on success;
// stub it to keep the unit suite hermetic.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
})

let TEST_HOME: string

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-inventory-audit-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
})

/**
 * Plant a `~/.claude/skills/<id>/SKILL.md` under the test home. Returns
 * the absolute SKILL.md path.
 */
function plantSkill(testHome: string, identifier: string, description = 'unit-fixture'): string {
  const dir = path.join(testHome, '.claude', 'skills', identifier)
  fs.mkdirSync(dir, { recursive: true })
  const content = `---\nname: ${identifier}\ndescription: ${description}\n---\n\n# ${identifier}\n`
  const filePath = path.join(dir, 'SKILL.md')
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/**
 * Plant a slash-command file at `~/.claude/commands/<id>.md`. Returns the
 * absolute file path. Used by exact-collision fixtures: a command + a
 * skill sharing the same `identifier` collide.
 */
function plantCommand(testHome: string, identifier: string): string {
  const dir = path.join(testHome, '.claude', 'commands')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${identifier}.md`)
  fs.writeFileSync(filePath, `# ${identifier}\n\nDeploy command body.\n`, 'utf-8')
  return filePath
}

function isResponse(
  v: SkillInventoryAuditResponse | InventoryAuditValidationError
): v is SkillInventoryAuditResponse {
  return !('errorCode' in v && 'success' in v && (v as { success: boolean }).success === false)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skill_inventory_audit — empty home', () => {
  it('returns a populated auditId, empty collision arrays, and on-disk report', async () => {
    // Skillsmith dir override (the audit history writer derives its own
    // path from `os.homedir()`). Point HOME at the fixture.
    const previousHome = process.env['HOME']
    process.env['HOME'] = TEST_HOME
    try {
      const response = await skillInventoryAudit({ homeDir: TEST_HOME })
      expect(isResponse(response)).toBe(true)
      if (!isResponse(response)) return
      expect(response.auditId).toMatch(/^[0-9A-Z]{20,30}$/) // ULID shape
      expect(response.exactCollisions).toEqual([])
      expect(response.semanticCollisions).toEqual([])
      expect(response.renameSuggestions).toEqual([])
      expect(fs.existsSync(response.reportPath)).toBe(true)
      expect(response.summary.totalFlags).toBe(0)
    } finally {
      if (previousHome !== undefined) process.env['HOME'] = previousHome
      else delete process.env['HOME']
    }
  })
})

describe('skill_inventory_audit — exact collision', () => {
  it('flags the collision and emits a rename suggestion targeting the most-recent entry', async () => {
    const previousHome = process.env['HOME']
    process.env['HOME'] = TEST_HOME
    try {
      // Planted: skill `ship` AND command `ship` — collide on `ship`.
      const skillPath = plantSkill(TEST_HOME, 'ship')
      const commandPath = plantCommand(TEST_HOME, 'ship')
      // Force the command's mtime ahead of the skill so the
      // most-recent-entry tiebreak picks the command for rename.
      const future = new Date(Date.now() + 60_000)
      fs.utimesSync(commandPath, future, future)
      void skillPath

      const response = await skillInventoryAudit({ homeDir: TEST_HOME })
      expect(isResponse(response)).toBe(true)
      if (!isResponse(response)) return
      expect(response.exactCollisions.length).toBeGreaterThanOrEqual(1)
      expect(response.renameSuggestions.length).toBeGreaterThanOrEqual(1)
      const suggestion = response.renameSuggestions[0]!
      expect(suggestion.currentName).toBe('ship')
      expect(suggestion.suggested.length).toBeGreaterThan(0)
      // mtime tiebreak picked the command file (most recent)
      expect(suggestion.entry.kind).toBe('command')
    } finally {
      if (previousHome !== undefined) process.env['HOME'] = previousHome
      else delete process.env['HOME']
    }
  })
})

describe('skill_inventory_audit — deep flag', () => {
  it('skips the semantic pass when deep is false (default)', async () => {
    const previousHome = process.env['HOME']
    process.env['HOME'] = TEST_HOME
    try {
      plantSkill(TEST_HOME, 'alpha', 'deploy code to production')
      plantSkill(TEST_HOME, 'beta', 'ship code to production')
      const response = await skillInventoryAudit({ homeDir: TEST_HOME })
      expect(isResponse(response)).toBe(true)
      if (!isResponse(response)) return
      expect(response.semanticCollisions).toEqual([])
    } finally {
      if (previousHome !== undefined) process.env['HOME'] = previousHome
      else delete process.env['HOME']
    }
  })
})

describe('skill_inventory_audit — Zod validation', () => {
  it('rejects unknown top-level fields with the validation-error envelope', async () => {
    const response = await skillInventoryAudit({
      homeDir: TEST_HOME,
      bogusField: true,
    } as unknown)
    expect(isResponse(response)).toBe(false)
    if (isResponse(response)) return
    expect(response.success).toBe(false)
    expect(response.errorCode).toBe('namespace.audit.invalid_input')
    expect(response.error).toContain('Invalid skill_inventory_audit input')
  })

  it('rejects homeDir outside os.homedir()/os.tmpdir() with invalid_home_dir', async () => {
    const response = await skillInventoryAudit({ homeDir: '/etc' })
    expect(isResponse(response)).toBe(false)
    if (isResponse(response)) return
    expect(response.errorCode).toBe('namespace.audit.invalid_home_dir')
  })

  it('accepts homeDir under os.tmpdir() (test-fixture path)', async () => {
    const previousHome = process.env['HOME']
    process.env['HOME'] = TEST_HOME
    try {
      const response = await skillInventoryAudit({ homeDir: TEST_HOME })
      expect(isResponse(response)).toBe(true)
    } finally {
      if (previousHome !== undefined) process.env['HOME'] = previousHome
      else delete process.env['HOME']
    }
  })
})

describe('skill_inventory_audit — audit-history round-trip', () => {
  it('persists result.json such that readAuditHistory recovers the auditId', async () => {
    const previousHome = process.env['HOME']
    process.env['HOME'] = TEST_HOME
    try {
      const response = await skillInventoryAudit({ homeDir: TEST_HOME })
      expect(isResponse(response)).toBe(true)
      if (!isResponse(response)) return
      const recovered = await readAuditHistory(response.auditId)
      expect(recovered).not.toBeNull()
      expect(recovered?.auditId).toBe(response.auditId)
    } finally {
      if (previousHome !== undefined) process.env['HOME'] = previousHome
      else delete process.env['HOME']
    }
  })
})

describe('skill_inventory_audit — exclusions filter', () => {
  it('filters matching collisions by default (applyExclusions defaults to true)', async () => {
    const previousHome = process.env['HOME']
    process.env['HOME'] = TEST_HOME
    try {
      plantSkill(TEST_HOME, 'ship')
      plantCommand(TEST_HOME, 'ship')
      // Author an exclusions file that whitelists /ship at the same
      // ~/.skillsmith dir the loader reads (HOME is already TEST_HOME).
      const skillsmithDir = path.join(TEST_HOME, '.skillsmith')
      fs.mkdirSync(skillsmithDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillsmithDir, 'audit-exclusions.json'),
        JSON.stringify({
          version: 1,
          exclusions: [{ kind: 'command', identifier: '/ship', reason: 'unit fixture' }],
        }),
        'utf-8'
      )

      const response = await skillInventoryAudit({ homeDir: TEST_HOME })
      expect(isResponse(response)).toBe(true)
      if (!isResponse(response)) return
      // The exact collision involving the excluded command is filtered.
      expect(response.exactCollisions.length).toBe(0)
      expect(response.renameSuggestions.length).toBe(0)
    } finally {
      if (previousHome !== undefined) process.env['HOME'] = previousHome
      else delete process.env['HOME']
    }
  })

  it('does NOT filter when applyExclusions: false (Enterprise scheduled-scan path)', async () => {
    const previousHome = process.env['HOME']
    process.env['HOME'] = TEST_HOME
    try {
      plantSkill(TEST_HOME, 'ship')
      plantCommand(TEST_HOME, 'ship')
      const skillsmithDir = path.join(TEST_HOME, '.skillsmith')
      fs.mkdirSync(skillsmithDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillsmithDir, 'audit-exclusions.json'),
        JSON.stringify({
          version: 1,
          exclusions: [{ kind: 'command', identifier: '/ship', reason: 'unit fixture' }],
        }),
        'utf-8'
      )

      const response = await skillInventoryAudit({
        homeDir: TEST_HOME,
        applyExclusions: false,
      })
      expect(isResponse(response)).toBe(true)
      if (!isResponse(response)) return
      // The collision is still reported because the exclusions file is
      // bypassed in governance / Enterprise scheduled-scan mode.
      expect(response.exactCollisions.length).toBeGreaterThan(0)
    } finally {
      if (previousHome !== undefined) process.env['HOME'] = previousHome
      else delete process.env['HOME']
    }
  })
})
