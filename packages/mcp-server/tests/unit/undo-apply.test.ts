/**
 * @fileoverview Unit tests for the `undo_apply` MCP tool
 *               (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/mcp-server/tests/unit/undo-apply
 *
 * Covers the remaining P-5 invariant named in
 * docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md's
 * "Shared-State / Coordination Audit" table for `~/.skillsmith/journal`:
 * "Undo tool, ... session-scoped ... every record embeds previous hash".
 * The chain-verification and concurrent-write invariants live in
 * `@skillsmith/core`'s `src/journal/journal.test.ts`.
 *
 * Coverage:
 *   1. Round trip — apply via `apply_recommended_edit`, then `undo_apply`
 *      restores byte-identical content and journals the undo; a second
 *      undo with nothing left refuses cleanly.
 *   2. Refusal — the file was modified after apply (hash mismatch): undo
 *      refuses and leaves the file untouched (never clobbers user edits).
 *   3. Scope fence — a restore target that escapes the confined skill root
 *      via a symlink is refused (reuses the SMI-4287 root-confinement
 *      helper, `resolveSafeRealpath`); and (governance follow-up, SMI-5456)
 *      a bare `os.tmpdir()` target outside both HOME and the explicit
 *      `UNDO_SCOPE_TEST_ROOT_ENV_VAR` seam is refused — proves the fence
 *      has no blanket `os.tmpdir()` carve-out.
 *
 * Pattern for (1)/(2) mirrors `apply-recommended-edit.test.ts`: seed
 * `~/.skillsmith/audits/<auditId>/` directly with a fixture `RecommendedEdit`
 * so the test doesn't depend on the semantic-detection pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  sha256Hex,
  resetJournalSessionIdForTests,
  verifyJournalChain,
} from '@skillsmith/core/journal'

import { applyRecommendedEditTool } from '../../src/tools/apply-recommended-edit.js'
import { undoApply, UNDO_SCOPE_TEST_ROOT_ENV_VAR } from '../../src/tools/undo-apply.js'
import {
  listSessionApplies,
  recordSessionApply,
  resetSessionAppliesForTests,
} from '../../src/tools/apply-session.helpers.js'
import { writeAuditSuggestions } from '../../src/audit/audit-suggestions.js'
import { writeAuditHistory } from '../../src/audit/audit-history.js'
import type { CollisionId, AuditId } from '../../src/audit/collision-detector.types.js'
import type { EditTemplatePattern, RecommendedEdit } from '../../src/audit/edit-suggester.types.js'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

let TEST_HOME: string
let PREV_HOME: string | undefined
let PREV_UNDO_SCOPE_TEST_ROOT: string | undefined

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-undo-apply-'))
  PREV_HOME = process.env['HOME']
  process.env['HOME'] = TEST_HOME
  // Explicit opt-in test seam for `undo-apply.ts`'s scope fence (see
  // `UNDO_SCOPE_TEST_ROOT_ENV_VAR`'s doc comment) — set alongside `HOME`
  // rather than relying solely on `os.homedir()` honoring the `HOME`
  // mutation, which is platform-dependent (true on Docker/Linux, NOT true
  // on macOS — see `getConfigDir()`'s doc comment).
  PREV_UNDO_SCOPE_TEST_ROOT = process.env[UNDO_SCOPE_TEST_ROOT_ENV_VAR]
  process.env[UNDO_SCOPE_TEST_ROOT_ENV_VAR] = TEST_HOME
  resetSessionAppliesForTests()
  resetJournalSessionIdForTests()
})

afterEach(() => {
  if (PREV_HOME !== undefined) process.env['HOME'] = PREV_HOME
  else delete process.env['HOME']
  if (PREV_UNDO_SCOPE_TEST_ROOT !== undefined) {
    process.env[UNDO_SCOPE_TEST_ROOT_ENV_VAR] = PREV_UNDO_SCOPE_TEST_ROOT
  } else {
    delete process.env[UNDO_SCOPE_TEST_ROOT_ENV_VAR]
  }
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
  resetSessionAppliesForTests()
  resetJournalSessionIdForTests()
})

/** Plant a SKILL.md fixture whose description body matches a single-line
 * edit window (mirrors `apply-recommended-edit.test.ts`). */
function plantSkillForEdit(home: string, identifier: string, description: string): string {
  const dir = path.join(home, '.claude', 'skills', identifier)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'SKILL.md')
  const content = `---\nname: ${identifier}\ndescription: ${description}\n---\n\n# ${identifier}\n`
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function findDescriptionLine(filePath: string, description: string): number {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `description: ${description}`) return i + 1
  }
  throw new Error('description line not found')
}

let auditCounter = 0

/** Persist a fixture audit + suggestions pair under HOME's
 * `.skillsmith/audits/<auditId>/`. A fresh auditId per call avoids
 * collisions across tests that share a TEST_HOME within one `it()`. */
async function seedAuditWithEdit(
  filePath: string,
  description: string
): Promise<{ auditId: string; collisionId: CollisionId; edit: RecommendedEdit }> {
  auditCounter += 1
  const auditId = `01J6Z3M0CK4N0R3MCDEFGH${String(auditCounter).padStart(4, '0')}` as AuditId
  const collisionId = `undoFixture${auditCounter}` as CollisionId
  const lineNumber = findDescriptionLine(filePath, description)
  const edit: RecommendedEdit = {
    collisionId,
    category: 'description_overlap',
    pattern: 'add_domain_qualifier' as EditTemplatePattern,
    filePath,
    lineRange: { start: lineNumber, end: lineNumber },
    before: `description: ${description}`,
    after: `description: ${description} (qualified)`,
    rationale: 'undo-apply unit fixture',
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

describe('undo_apply — round trip', () => {
  it('restores byte-identical content, journals the undo, and refuses a second undo with nothing left', async () => {
    const description = 'deploy code to production'
    const filePath = plantSkillForEdit(TEST_HOME, 'undo-fixture', description)
    const originalContent = fs.readFileSync(filePath, 'utf-8')
    const { auditId, collisionId } = await seedAuditWithEdit(filePath, description)

    const applyResponse = await applyRecommendedEditTool({ auditId, collisionId, confirmed: true })
    expect(applyResponse.success).toBe(true)
    const mutatedContent = fs.readFileSync(filePath, 'utf-8')
    expect(mutatedContent).not.toBe(originalContent)
    expect(listSessionApplies()).toHaveLength(1)

    const undoResponse = await undoApply({})
    expect(undoResponse.success).toBe(true)
    expect(undoResponse.undone).toHaveLength(1)
    expect(undoResponse.undone[0]!.suggestionId).toBe(collisionId)
    expect(undoResponse.undone[0]!.targetPath).toBe(filePath)

    const restoredContent = fs.readFileSync(filePath, 'utf-8')
    expect(restoredContent).toBe(originalContent)
    expect(listSessionApplies()).toHaveLength(0)

    // Journal captured both the apply and the undo, hash-chained.
    const chain = await verifyJournalChain()
    expect(chain.valid).toBe(true)
    const actions = chain.records.map((r) => r.action)
    expect(actions).toContain('apply')
    expect(actions).toContain('undo')

    // Second undo — nothing left, refuses cleanly (never throws).
    const secondUndo = await undoApply({})
    expect(secondUndo.success).toBe(false)
    expect(secondUndo.errorCode).toBe('undo.no_session_applies')
    expect(secondUndo.undone).toEqual([])
    // File remains restored — a refusal never mutates.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(originalContent)
  })
})

describe('undo_apply — refusal: content changed since apply', () => {
  it('refuses when the file was modified after apply, and leaves the file untouched', async () => {
    const description = 'deploy code to production'
    const filePath = plantSkillForEdit(TEST_HOME, 'undo-changed', description)
    const { auditId, collisionId } = await seedAuditWithEdit(filePath, description)

    const applyResponse = await applyRecommendedEditTool({ auditId, collisionId, confirmed: true })
    expect(applyResponse.success).toBe(true)

    // Simulate a user edit landing after the apply.
    const userEditedContent = fs.readFileSync(filePath, 'utf-8') + '\nuser added this line\n'
    fs.writeFileSync(filePath, userEditedContent, 'utf-8')

    const undoResponse = await undoApply({})
    expect(undoResponse.success).toBe(false)
    expect(undoResponse.errorCode).toBe('undo.content_changed')
    expect(undoResponse.undone).toEqual([])

    // Refusal never clobbers — the user's edit is still there.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(userEditedContent)
    // The changeset stays on the stack — a later retry (e.g. after the
    // user reverts their own edit) can still undo it.
    expect(listSessionApplies()).toHaveLength(1)
  })
})

describe('undo_apply — scope fence (SMI-4287 reuse)', () => {
  it('refuses to restore a target that escapes the confined skill root via a symlink', async () => {
    const outsideDir = fs.mkdtempSync('/var/skillsmith-undo-escape-')
    try {
      const secretPath = path.join(outsideDir, 'secret.md')
      fs.writeFileSync(secretPath, 'top secret content', 'utf-8')

      const skillsDir = path.join(TEST_HOME, '.claude', 'skills')
      fs.mkdirSync(skillsDir, { recursive: true })
      const symlinkPath = path.join(skillsDir, 'escape-link.md')
      fs.symlinkSync(secretPath, symlinkPath)

      const content = fs.readFileSync(symlinkPath, 'utf-8')
      const hash = sha256Hex(content)

      recordSessionApply({
        tool: 'apply_recommended_edit',
        suggestionId: 'escape-fixture',
        targetPath: symlinkPath,
        beforeHash: hash,
        afterHash: hash,
        backupRef: outsideDir,
        backupFileName: 'secret.md',
        ts: Date.now(),
      })

      const undoResponse = await undoApply({})
      expect(undoResponse.success).toBe(false)
      expect(undoResponse.errorCode).toBe('undo.scope_violation')
      expect(undoResponse.undone).toEqual([])

      // Refused before any write — content untouched, and the entry is
      // still on the session stack (a scope violation doesn't consume it).
      expect(fs.readFileSync(secretPath, 'utf-8')).toBe('top secret content')
      expect(listSessionApplies()).toHaveLength(1)
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('refuses a bare os.tmpdir() target that is outside both HOME and the explicit test-root seam (regression: no blanket tmpdir carve-out)', async () => {
    // Explicitly clear the test-root seam this suite's beforeEach sets, so
    // this case exercises exactly what a real deployment sees: HOME-only
    // confinement, nothing else. Prior to the fix, `checkUndoScopeFence`
    // additionally accepted ANY path under `os.tmpdir()` unconditionally —
    // this proves that carve-out is gone.
    delete process.env[UNDO_SCOPE_TEST_ROOT_ENV_VAR]

    const looseTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-undo-loose-'))
    try {
      const targetPath = path.join(looseTmpDir, 'not-under-home.md')
      fs.writeFileSync(targetPath, 'content after apply', 'utf-8')
      const hash = sha256Hex(fs.readFileSync(targetPath, 'utf-8'))

      recordSessionApply({
        tool: 'apply_recommended_edit',
        suggestionId: 'loose-tmpdir-fixture',
        targetPath,
        beforeHash: hash,
        afterHash: hash,
        backupRef: looseTmpDir,
        backupFileName: 'not-under-home.md',
        ts: Date.now(),
      })

      const undoResponse = await undoApply({})
      expect(undoResponse.success).toBe(false)
      expect(undoResponse.errorCode).toBe('undo.scope_violation')
      expect(undoResponse.undone).toEqual([])
      expect(listSessionApplies()).toHaveLength(1)
    } finally {
      fs.rmSync(looseTmpDir, { recursive: true, force: true })
    }
  })
})
