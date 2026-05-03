/**
 * @fileoverview Unit tests for SMI-4589 Wave 3 — edit-suggester core (10 cases).
 * @module @skillsmith/mcp-server/tests/unit/edit-suggester
 *
 * Covers the 10 cases enumerated in
 * `docs/internal/implementation/smi-4589-edit-suggester.md` §Tests.
 * Apply-path tests (registry rejection + apply success/stale-before)
 * live in `edit-applier.test.ts` to keep both files under the 500-LOC
 * pre-commit gate.
 *
 * Per-template gate (ratified 2026-05-01): only `add_domain_qualifier`
 * (4.10/5) ships in v1. Cases 2-3 assert the failing templates produce
 * NO `RecommendedEdit` from `runEditSuggester` — they're absent from
 * Wave 3 output entirely per plan R-4/R-8.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runEditSuggester } from '../../src/audit/edit-suggester.js'
import type { InventoryEntry } from '../../src/utils/local-inventory.types.js'
import {
  makeAuditResult,
  makeEntry,
  makeSemanticFlag,
  writeSkillMd,
} from './edit-suggester.fixtures.js'

let TEST_HOME: string
let ORIGINAL_HOME: string | undefined

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-edit-suggester-'))
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

describe('runEditSuggester — case 1: add_domain_qualifier fires for asymmetric tags', () => {
  it('emits a RecommendedEdit with `for <tag> tasks` injected after the trigger verb', async () => {
    const fileA = writeSkillMd(TEST_HOME, {
      identifier: 'release-tools',
      description: 'Use when deploying to production. Handles release notes.',
      tag: 'anthropic',
    })
    const fileB = writeSkillMd(TEST_HOME, {
      identifier: 'release-helper',
      description: 'Use when deploying for the release pipeline. Handles changelogs.',
      tag: 'community',
    })
    const entryA = makeEntry({
      source_path: fileA,
      identifier: 'release-tools',
      description: 'Use when deploying to production. Handles release notes.',
      tag: 'anthropic',
    })
    const entryB = makeEntry({
      source_path: fileB,
      identifier: 'release-helper',
      description: 'Use when deploying for the release pipeline. Handles changelogs.',
      tag: 'community',
    })

    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-01', entryA, entryB, cosineScore: 0.82 }),
    ])

    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(1)
    const edit = edits[0]!
    expect(edit.pattern).toBe('add_domain_qualifier')
    expect(edit.category).toBe('description_overlap')
    expect(edit.applyMode).toBe('apply_with_confirmation')
    expect(edit.applyAction).toBe('recommended_edit')
    expect(edit.after).toContain('for anthropic tasks')
    expect(edit.before).not.toContain('for anthropic tasks')
    expect(edit.otherEntry.identifier).toBe('release-helper')
    expect(edit.collisionId).toBe('coll-01')
    expect(edit.rationale).toContain('cosine 0.82')
  })
})

describe('runEditSuggester — case 2: narrow_scope-shape collision emits NO edit (template not registered)', () => {
  it('returns empty when no entry has a unique tag', async () => {
    const fileA = writeSkillMd(TEST_HOME, {
      identifier: 'deployer-a',
      description: 'Use when deploying releases.',
      tag: 'shared',
    })
    const fileB = writeSkillMd(TEST_HOME, {
      identifier: 'deployer-b',
      description: 'Use when deploying releases.',
      tag: 'shared',
    })
    const entryA = makeEntry({
      source_path: fileA,
      identifier: 'deployer-a',
      description: 'Use when deploying releases.',
      tag: 'shared',
    })
    const entryB = makeEntry({
      source_path: fileB,
      identifier: 'deployer-b',
      description: 'Use when deploying releases.',
      tag: 'shared',
    })

    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-narrow-shape', entryA, entryB }),
    ])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(0)
  })
})

describe('runEditSuggester — case 3: reword_trigger_verb-shape (CLAUDE.md) emits NO edit', () => {
  it('returns empty for claude_md_rule entries (template not registered in v1)', async () => {
    const claudeMdPath = path.join(TEST_HOME, 'CLAUDE.md')
    fs.writeFileSync(
      claudeMdPath,
      '## Trigger phrases\n- Use when deploying\n- Use when deploying\n',
      'utf-8'
    )
    const entryA: InventoryEntry = {
      kind: 'claude_md_rule',
      source_path: claudeMdPath,
      identifier: 'rule-a',
      triggerSurface: ['Use when deploying'],
      meta: { description: 'Use when deploying' },
    }
    const entryB: InventoryEntry = {
      kind: 'claude_md_rule',
      source_path: claudeMdPath,
      identifier: 'rule-b',
      triggerSurface: ['Use when deploying'],
      meta: { description: 'Use when deploying' },
    }
    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-claude-md', entryA, entryB }),
    ])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(0)
  })
})

describe('runEditSuggester — case 4: flag matching no template skipped, others still produce edits', () => {
  it('isolates per-flag dispatch — non-matching flag does not poison matching flag', async () => {
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
    const entryC = makeEntry({
      source_path: fileA,
      identifier: 'shared-c',
      description: 'Use when deploying releases.',
      tag: 'shared',
    })
    const entryD = makeEntry({
      source_path: fileB,
      identifier: 'shared-d',
      description: 'Use when deploying releases.',
      tag: 'shared',
    })

    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-match', entryA, entryB }),
      makeSemanticFlag({ collisionId: 'coll-skip', entryA: entryC, entryB: entryD }),
    ])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(1)
    expect(edits[0]!.collisionId).toBe('coll-match')
  })
})

describe('runEditSuggester — case 5: line-range extraction matches file content byte-for-byte', () => {
  it("`before` snippet equals fileLines.slice(start-1, end).join('\\n')", async () => {
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
    const result = makeAuditResult([makeSemanticFlag({ collisionId: 'coll-byte', entryA, entryB })])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(1)
    const edit = edits[0]!

    const fileLines = fs.readFileSync(edit.filePath, 'utf-8').split('\n')
    const startIdx = edit.lineRange.start - 1
    const endIdx = edit.lineRange.end - 1
    const reconstructed = fileLines.slice(startIdx, endIdx + 1).join('\n')
    expect(edit.before).toBe(reconstructed)
  })
})

describe('runEditSuggester — case 6: multiple flags on the same file produce independent edits', () => {
  it('emits one RecommendedEdit per matching flag, stable in input order', async () => {
    const fileA = writeSkillMd(TEST_HOME, {
      identifier: 'release-tools',
      description: 'Use when deploying to production.',
      tag: 'anthropic',
    })
    const fileB = writeSkillMd(TEST_HOME, {
      identifier: 'release-helper-1',
      description: 'Use when deploying for stage one.',
      tag: 'community',
    })
    const fileC = writeSkillMd(TEST_HOME, {
      identifier: 'release-helper-2',
      description: 'Use when deploying for stage two.',
      tag: 'enterprise',
    })
    const entryA = makeEntry({
      source_path: fileA,
      identifier: 'release-tools',
      description: 'Use when deploying to production.',
      tag: 'anthropic',
    })
    const entryB = makeEntry({
      source_path: fileB,
      identifier: 'release-helper-1',
      description: 'Use when deploying for stage one.',
      tag: 'community',
    })
    const entryC = makeEntry({
      source_path: fileC,
      identifier: 'release-helper-2',
      description: 'Use when deploying for stage two.',
      tag: 'enterprise',
    })
    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-multi-1', entryA, entryB }),
      makeSemanticFlag({ collisionId: 'coll-multi-2', entryA, entryB: entryC }),
    ])
    const edits = await runEditSuggester(result)
    expect(edits.length).toBeGreaterThanOrEqual(2)
    expect(edits[0]!.collisionId).toBe('coll-multi-1')
    expect(edits[1]!.collisionId).toBe('coll-multi-2')
  })
})

describe('runEditSuggester — case 7: applyMode is apply_with_confirmation for shipped template', () => {
  it("returned edit's applyMode equals 'apply_with_confirmation'", async () => {
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
    const result = makeAuditResult([makeSemanticFlag({ collisionId: 'coll-mode', entryA, entryB })])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(1)
    expect(edits[0]!.applyMode).toBe('apply_with_confirmation')
  })
})

describe('runEditSuggester — case 8: otherEntry cross-references the partner', () => {
  it('otherEntry.identifier matches the partner in the original SemanticCollisionFlag', async () => {
    const fileA = writeSkillMd(TEST_HOME, {
      identifier: 'tool-alpha',
      description: 'Use when running alpha workflows.',
      tag: 'alpha-only',
    })
    const fileB = writeSkillMd(TEST_HOME, {
      identifier: 'tool-beta',
      description: 'Use when running beta workflows.',
      tag: 'beta-only',
    })
    const entryA = makeEntry({
      source_path: fileA,
      identifier: 'tool-alpha',
      description: 'Use when running alpha workflows.',
      tag: 'alpha-only',
    })
    const entryB = makeEntry({
      source_path: fileB,
      identifier: 'tool-beta',
      description: 'Use when running beta workflows.',
      tag: 'beta-only',
    })
    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-other', entryA, entryB }),
    ])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(1)
    const edit = edits[0]!
    expect(edit.otherEntry.identifier).toBe('tool-beta')
    expect(edit.otherEntry.sourcePath).toBe(fileB)
  })
})

describe('runEditSuggester — case 9: missing file produces no exception, no edit', () => {
  it('soft-warns and skips when source_path does not exist', async () => {
    const missingPath = path.join(TEST_HOME, 'does-not-exist', 'SKILL.md')
    const partnerPath = path.join(TEST_HOME, 'also-missing', 'SKILL.md')
    const entryA = makeEntry({
      source_path: missingPath,
      identifier: 'phantom-a',
      description: 'Use when running phantom tasks.',
      tag: 'phantom',
    })
    const entryB = makeEntry({
      source_path: partnerPath,
      identifier: 'phantom-b',
      description: 'Use when running phantom tasks.',
      tag: 'partner',
    })
    const result = makeAuditResult([
      makeSemanticFlag({ collisionId: 'coll-missing', entryA, entryB }),
    ])
    const edits = await runEditSuggester(result)
    expect(edits).toHaveLength(0)
  })
})

describe('runEditSuggester — case 10: empty semanticCollisions short-circuits', () => {
  it('returns empty array with no I/O', async () => {
    const result = makeAuditResult([])
    const edits = await runEditSuggester(result)
    expect(edits).toEqual([])
  })
})
