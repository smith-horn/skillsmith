/**
 * Unit tests for SMI-4587 Wave 1 Step 7/8 — markdown audit-report writer.
 * Covers section ordering, the CLAUDE.md scan caveat (D-ANTI-1), atomic
 * write, and absolute-path rendering for every collision kind.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { renderAuditReport, writeAuditReport } from '../../src/audit/audit-report-writer.js'
import { newAuditId } from '../../src/audit/audit-history.js'
import type {
  CollisionId,
  ExactCollisionFlag,
  GenericTokenFlag,
  InventoryAuditResult,
  SemanticCollisionFlag,
} from '../../src/audit/collision-detector.types.js'
import type { RecommendedEdit } from '../../src/audit/edit-suggester.types.js'
import type { InventoryEntry } from '../../src/utils/local-inventory.types.js'

let TEST_DIR: string

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-report-'))
})

afterEach(() => {
  if (TEST_DIR && fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

function entry(overrides: Partial<InventoryEntry>): InventoryEntry {
  return {
    kind: 'skill',
    source_path: '/tmp/SKILL.md',
    identifier: 'noop',
    triggerSurface: ['noop'],
    ...overrides,
  }
}

function emptyResult(overrides: Partial<InventoryAuditResult> = {}): InventoryAuditResult {
  return {
    auditId: newAuditId(),
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
    ...overrides,
  }
}

describe('renderAuditReport — empty result', () => {
  it('renders only the summary header + recommended-edits placeholder', () => {
    const result = emptyResult()
    const md = renderAuditReport(result)
    expect(md).toContain(`# Skillsmith Namespace Audit — ${result.auditId}`)
    expect(md).toContain('Total entries scanned: 0')
    expect(md).toContain('## Recommended edits')
    expect(md).toContain('_No automated edits suggested in Wave 1._')
    // No collision sections — only summary + recommended-edits.
    expect(md).not.toContain('## Exact collisions')
    expect(md).not.toContain('## Generic-token flags')
    expect(md).not.toContain('## Semantic collisions')
    expect(md).not.toContain('## CLAUDE.md scan caveat')
  })
})

describe('renderAuditReport — CLAUDE.md scan caveat (D-ANTI-1)', () => {
  it('emits the caveat when at least one inventory entry is claude_md_rule', () => {
    const result = emptyResult({
      inventory: [entry({ kind: 'claude_md_rule', source_path: '/etc/CLAUDE.md' })],
    })
    const md = renderAuditReport(result)
    expect(md).toContain('## CLAUDE.md scan caveat')
    expect(md).toMatch(/heuristic/i)
  })

  it('omits the caveat when no claude_md_rule entries are present', () => {
    const result = emptyResult({
      inventory: [entry({ kind: 'skill' }), entry({ kind: 'command' })],
    })
    const md = renderAuditReport(result)
    expect(md).not.toContain('## CLAUDE.md scan caveat')
  })
})

describe('renderAuditReport — full result with all 3 collision kinds', () => {
  function fullResult(): InventoryAuditResult {
    const auditId = newAuditId()
    const exactA = entry({
      kind: 'skill',
      source_path: '/Users/me/.claude/skills/docker/SKILL.md',
      identifier: 'docker',
    })
    const exactB = entry({
      kind: 'command',
      source_path: '/Users/me/.claude/commands/docker.md',
      identifier: 'docker',
    })
    const generic = entry({
      kind: 'skill',
      source_path: '/Users/me/.claude/skills/run/SKILL.md',
      identifier: 'run',
    })
    const semA = entry({
      kind: 'skill',
      source_path: '/Users/me/.claude/skills/release-shipper/SKILL.md',
      identifier: 'release-shipper',
    })
    const semB = entry({
      kind: 'skill',
      source_path: '/Users/me/.claude/skills/deploy-tagger/SKILL.md',
      identifier: 'deploy-tagger',
    })

    const exactFlag: ExactCollisionFlag = {
      kind: 'exact',
      collisionId: 'cafef00d12345678' as ExactCollisionFlag['collisionId'],
      identifier: 'docker',
      entries: [exactA, exactB],
      severity: 'error',
      reason: 'identifier collision (command / skill)',
    }
    const genericFlag: GenericTokenFlag = {
      kind: 'generic',
      collisionId: 'deadbeefdeadbeef' as GenericTokenFlag['collisionId'],
      identifier: 'run',
      entry: generic,
      matchedTokens: ['run', 'execute'],
      severity: 'warning',
      reason: 'matches curated generic-trigger stoplist',
    }
    const semFlag: SemanticCollisionFlag = {
      kind: 'semantic',
      collisionId: '00112233aabbccdd' as SemanticCollisionFlag['collisionId'],
      entryA: semA,
      entryB: semB,
      cosineScore: 0.873,
      overlappingPhrases: [
        { phrase1: 'ship a release', phrase2: 'cut a release', similarity: 0.91 },
      ],
      severity: 'warning',
      reason: 'overlap above semantic threshold',
    }

    return {
      auditId,
      inventory: [exactA, exactB, generic, semA, semB],
      exactCollisions: [exactFlag],
      genericFlags: [genericFlag],
      semanticCollisions: [semFlag],
      summary: {
        totalEntries: 5,
        totalFlags: 3,
        errorCount: 1,
        warningCount: 2,
        durationMs: 12.34,
        passDurations: { exact: 1.1, generic: 2.2, semantic: 9.04 },
      },
    }
  }

  it('renders all three collision sections with absolute paths', () => {
    const md = renderAuditReport(fullResult())

    // Section ordering: summary → exact → generic → semantic → recommended.
    const idxExact = md.indexOf('## Exact collisions')
    const idxGeneric = md.indexOf('## Generic-token flags')
    const idxSemantic = md.indexOf('## Semantic collisions')
    const idxRecommended = md.indexOf('## Recommended edits')
    expect(idxExact).toBeGreaterThan(0)
    expect(idxGeneric).toBeGreaterThan(idxExact)
    expect(idxSemantic).toBeGreaterThan(idxGeneric)
    expect(idxRecommended).toBeGreaterThan(idxSemantic)

    // Absolute paths surface for each collision kind.
    expect(md).toContain('/Users/me/.claude/skills/docker/SKILL.md')
    expect(md).toContain('/Users/me/.claude/commands/docker.md')
    expect(md).toContain('/Users/me/.claude/skills/run/SKILL.md')
    expect(md).toContain('/Users/me/.claude/skills/release-shipper/SKILL.md')
    expect(md).toContain('/Users/me/.claude/skills/deploy-tagger/SKILL.md')

    // Generic-token flag renders matched tokens.
    expect(md).toContain('`run`')
    expect(md).toContain('`execute`')

    // Semantic collision renders cosine score + overlapping phrases.
    expect(md).toContain('Cosine score: 0.873')
    expect(md).toContain('"ship a release"')
    expect(md).toContain('"cut a release"')

    // Summary totals reflect 1 error + 2 warnings.
    expect(md).toContain('Errors (exact collisions): 1')
    expect(md).toContain('Warnings (generic + semantic): 2')
  })
})

describe('renderAuditReport — SMI-4733 ReDoS hardening', () => {
  it('handles input with many trailing newlines', () => {
    // Construct a `RecommendedEdit` whose `before` snippet contains 1000
    // consecutive `\n` chars. The renderer splits `before` on `\n` and
    // emits each as a `-`-prefixed diff line — those propagate into the
    // joined-section input that the trailing-newline trim runs against.
    // Pre-fix code used `/\n+$/` (polynomial backtracking on this shape);
    // the trimEnd-based replacement is O(n) linear. Regression gate is
    // the CodeQL re-scan — we only assert correctness here.
    const edit: RecommendedEdit = {
      collisionId: '00112233aabbccdd' as CollisionId,
      category: 'description_overlap',
      pattern: 'add_domain_qualifier',
      filePath: '/tmp/SKILL.md',
      lineRange: { start: 1, end: 2 },
      before: '\n'.repeat(1000),
      after: 'description: ship a release for codehelper tasks',
      rationale: 'differentiates from another skill',
      applyAction: 'recommended_edit',
      applyMode: 'apply_with_confirmation',
      otherEntry: { identifier: 'release-tools', sourcePath: '/tmp/release-tools/SKILL.md' },
    }
    const md = renderAuditReport(emptyResult(), { recommendedEdits: [edit] })
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
  })

  it('handles empty result', () => {
    // Smoke test for the minimally-populated path (summary header only —
    // no collision sections). Asserts non-empty output ending with exactly
    // one `\n`. The trailing-newline regression itself is exercised by
    // the 1000-newline test above; this case just guards against the
    // empty-section branch returning `''` or losing its terminator.
    const md = renderAuditReport(emptyResult())
    expect(md.length).toBeGreaterThan(0)
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
  })
})

describe('writeAuditReport — atomic file write', () => {
  it('writes report.md and removes the .tmp file on success', async () => {
    const result = emptyResult()
    const auditDir = path.join(TEST_DIR, 'audits', result.auditId)
    const written = await writeAuditReport(result, { auditDir })
    expect(written.reportPath).toBe(path.join(auditDir, 'report.md'))
    expect(fs.existsSync(written.reportPath)).toBe(true)
    expect(fs.existsSync(`${written.reportPath}.tmp`)).toBe(false)
  })

  it('creates the audit directory on first run', async () => {
    const result = emptyResult()
    const auditDir = path.join(TEST_DIR, 'never-existed', 'audits', result.auditId)
    expect(fs.existsSync(auditDir)).toBe(false)
    const written = await writeAuditReport(result, { auditDir })
    expect(fs.existsSync(auditDir)).toBe(true)
    expect(fs.existsSync(written.reportPath)).toBe(true)
  })

  it('round-trips: written body matches renderAuditReport output (timestamp pinned)', async () => {
    const result = emptyResult({
      inventory: [entry({ kind: 'claude_md_rule' })],
    })
    const auditDir = path.join(TEST_DIR, 'audits', result.auditId)
    const generatedAt = new Date('2026-05-01T00:00:00.000Z')
    const written = await writeAuditReport(result, { auditDir, generatedAt })
    const onDisk = fs.readFileSync(written.reportPath, 'utf-8')
    expect(onDisk).toBe(renderAuditReport(result, { generatedAt }))
    expect(onDisk).toContain('## CLAUDE.md scan caveat')
  })
})
