/**
 * @fileoverview Unit tests for SMI-4589 Wave 3 — edit-applier.
 * @module @skillsmith/mcp-server/tests/unit/edit-applier
 *
 * Covers the registry-rejection regression guard from plan §5 (synthetic
 * edits with `pattern: 'narrow_scope'` / `'reword_trigger_verb'` must be
 * rejected by `applyRecommendedEdit`'s registry guard, with the file
 * byte-for-byte unchanged) plus the apply happy path and stale-before
 * guard.
 *
 * Per-template gate (ratified 2026-05-01): only `add_domain_qualifier`
 * (4.10/5) is in `APPLY_TEMPLATE_REGISTRY`. The regression test guards
 * against future drift if SMI-4593 inadvertently registers a template
 * before passing the gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runEditSuggester } from '../../src/audit/edit-suggester.js'
import { APPLY_TEMPLATE_REGISTRY, applyRecommendedEdit } from '../../src/audit/edit-applier.js'
import type { EditTemplatePattern, RecommendedEdit } from '../../src/audit/edit-suggester.types.js'
import {
  cid,
  makeAuditResult,
  makeEntry,
  makeSemanticFlag,
  writeSkillMd,
} from './edit-suggester.fixtures.js'

let TEST_HOME: string
let ORIGINAL_HOME: string | undefined

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-edit-applier-'))
  ORIGINAL_HOME = process.env['HOME']
  process.env['HOME'] = TEST_HOME
})

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) {
    process.env['HOME'] = ORIGINAL_HOME
  } else {
    delete process.env['HOME']
  }
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
})

describe('APPLY_TEMPLATE_REGISTRY contents', () => {
  it("contains exactly 'add_domain_qualifier' in v1", () => {
    expect(Array.from(APPLY_TEMPLATE_REGISTRY)).toEqual(['add_domain_qualifier'])
  })
})

describe('applyRecommendedEdit — registry-rejection regression guard', () => {
  it.each<EditTemplatePattern>(['narrow_scope', 'reword_trigger_verb'])(
    'rejects synthetic edit with failing-template pattern %s without mutating the file',
    async (pattern) => {
      const filePath = writeSkillMd(TEST_HOME, {
        identifier: 'untouched',
        description: 'Use when running untouched workflows.',
        tag: 'guarded',
      })
      const before = fs.readFileSync(filePath, 'utf-8')

      const synthetic: RecommendedEdit = {
        collisionId: cid('synthetic-coll'),
        category:
          pattern === 'reword_trigger_verb' ? 'claude_md_trigger_overlap' : 'description_overlap',
        pattern,
        filePath,
        lineRange: { start: 1, end: 1 },
        before: '---',
        after: '+++',
        rationale: 'synthetic test edit',
        applyAction: 'recommended_edit',
        applyMode: 'apply_with_confirmation',
        otherEntry: { identifier: 'partner', sourcePath: '/tmp/partner' },
      }

      const result = await applyRecommendedEdit(synthetic, {
        auditId: 'aud-synthetic',
        mode: 'apply_with_confirmation',
      })

      expect(result.success).toBe(false)
      expect(result.error?.kind).toBe('edit.template_not_in_apply_registry')
      expect(result.backupPath).toBe('')
      expect(result.ledgerEntryId).toBe('')

      const after = fs.readFileSync(filePath, 'utf-8')
      expect(after).toBe(before)
    }
  )
})

describe('applyRecommendedEdit — apply happy path', () => {
  it('returns the registered summary on apply_with_confirmation success and creates a backup', async () => {
    const fileA = writeSkillMd(TEST_HOME, {
      identifier: 'release-tools',
      description: 'Use when deploying to production.',
      tag: 'anthropic',
    })
    const fileB = writeSkillMd(TEST_HOME, {
      identifier: 'release-helper',
      description: 'Use when deploying for the release pipeline.',
      tag: 'community',
    })
    const entryA = makeEntry({
      source_path: fileA,
      identifier: 'release-tools',
      description: 'Use when deploying to production.',
      tag: 'anthropic',
    })
    const entryB = makeEntry({
      source_path: fileB,
      identifier: 'release-helper',
      description: 'Use when deploying for the release pipeline.',
      tag: 'community',
    })
    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-apply', entryA, entryB }),
    ])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(1)
    const edit = edits[0]!

    const before = fs.readFileSync(edit.filePath, 'utf-8')
    const applyResult = await applyRecommendedEdit(edit, {
      auditId: 'aud-apply-01',
      mode: 'apply_with_confirmation',
    })

    expect(applyResult.success).toBe(true)
    expect(applyResult.error).toBeUndefined()
    expect(applyResult.summary).toBe(
      `Edited ${edit.filePath} lines ${edit.lineRange.start}-${edit.lineRange.end}. To undo: sklx audit revert aud-apply-01`
    )
    expect(applyResult.backupPath).not.toBe('')

    const after = fs.readFileSync(edit.filePath, 'utf-8')
    expect(after).not.toBe(before)
    expect(after).toContain('for anthropic tasks')

    const backupFiles = fs.readdirSync(applyResult.backupPath)
    expect(backupFiles.length).toBeGreaterThan(0)
    const backupContent = fs.readFileSync(
      path.join(applyResult.backupPath, backupFiles[0]!),
      'utf-8'
    )
    expect(backupContent).toBe(before)
  })

  it('returns edit.stale_before when before snippet has drifted', async () => {
    const fileA = writeSkillMd(TEST_HOME, {
      identifier: 'release-tools',
      description: 'Use when deploying to production.',
      tag: 'anthropic',
    })
    const fileB = writeSkillMd(TEST_HOME, {
      identifier: 'release-helper',
      description: 'Use when deploying releases.',
      tag: 'community',
    })
    const entryA = makeEntry({
      source_path: fileA,
      identifier: 'release-tools',
      description: 'Use when deploying to production.',
      tag: 'anthropic',
    })
    const entryB = makeEntry({
      source_path: fileB,
      identifier: 'release-helper',
      description: 'Use when deploying releases.',
      tag: 'community',
    })
    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-stale', entryA, entryB }),
    ])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(1)
    const edit = edits[0]!

    fs.writeFileSync(edit.filePath, 'completely different content\n', 'utf-8')

    const applyResult = await applyRecommendedEdit(edit, {
      auditId: 'aud-stale-01',
      mode: 'apply_with_confirmation',
    })

    expect(applyResult.success).toBe(false)
    expect(applyResult.error?.kind).toBe('edit.stale_before')
    expect(applyResult.backupPath).toBe('')
  })
})
