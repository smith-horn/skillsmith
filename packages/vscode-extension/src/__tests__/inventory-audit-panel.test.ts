/**
 * Tests for inventory-audit-panel-html.ts and inventory-audit-sections-html.ts
 * (SMI-5318 / Epic D / PR-D3).
 *
 * Pure HTML builder functions — no webview needed; just call them and assert
 * on the returned string. No vscode import at module-load time for these modules,
 * but we stub vscode defensively in case of transitive needs.
 */
import { describe, it, expect } from 'vitest'

// ── vscode stub (no-op; sections/panel-html don't import vscode) ──────────────
import { vi } from 'vitest'
vi.mock('vscode', () => ({}))

// ── SUTs ──────────────────────────────────────────────────────────────────────
import {
  getInventoryAuditHtml,
  getInventoryAuditErrorHtml,
} from '../views/inventory-audit-panel-html.js'
import {
  severityBadgeClass,
  getExactCollisionsSection,
  getSemanticSection,
  getRenameSuggestionsSection,
  getRecommendedEditsSection,
} from '../views/inventory-audit-sections-html.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────
const NONCE = 'testNonce1234567890ABCD'

function makeEntry(id = 'org/foo', path = '/home/u/.claude/skills/org/foo') {
  return {
    kind: 'skill' as const,
    source_path: path,
    identifier: id,
    triggerSurface: [] as string[],
  }
}

function makeResponse(
  overrides: Partial<{
    totalFlags: number
    errorCount: number
    warningCount: number
    totalEntries: number
    withCollision: boolean
    withSemantic: boolean
    withRename: boolean
    withEdit: boolean
    editApplyMode: 'manual_review' | 'apply_with_confirmation'
    identifier: string
  }> = {}
) {
  const {
    totalFlags = 0,
    errorCount = 0,
    warningCount = 0,
    totalEntries = 5,
    withCollision = false,
    withSemantic = false,
    withRename = false,
    withEdit = false,
    editApplyMode = 'manual_review',
    identifier = 'org/foo',
  } = overrides

  const entryA = makeEntry(identifier)
  const entryB = makeEntry('org/bar', '/home/u/.claude/skills/org/bar')

  return {
    auditId: 'aud_test',
    inventory: [entryA],
    exactCollisions: withCollision
      ? [
          {
            kind: 'exact' as const,
            collisionId: 'c1',
            identifier,
            entries: [entryA, entryB],
            severity: 'error' as const,
            reason: 'duplicate identifier found',
          },
        ]
      : [],
    semanticCollisions: withSemantic
      ? [
          {
            kind: 'semantic' as const,
            collisionId: 'c2',
            entryA,
            entryB,
            cosineScore: 0.91,
            overlappingPhrases: [
              { phrase1: 'search files', phrase2: 'find files', similarity: 0.88 },
            ],
            severity: 'warning' as const,
            reason: 'high semantic overlap',
          },
        ]
      : [],
    genericFlags: [],
    renameSuggestions: withRename
      ? [
          {
            collisionId: 'c1',
            entry: entryA,
            currentName: 'foo',
            suggested: 'foo-2',
            applyAction: 'rename_skill_dir_and_frontmatter' as const,
            reason: 'resolves collision with org/bar',
          },
        ]
      : [],
    recommendedEdits: withEdit
      ? [
          {
            collisionId: 'c1',
            category: 'description_overlap' as const,
            pattern: 'add_domain_qualifier' as const,
            filePath: '/home/u/.claude/skills/org/foo/SKILL.md',
            lineRange: { start: 1, end: 2 },
            before: 'Searches files in the repo.',
            after: 'Searches TypeScript files in the repo.',
            rationale: 'Narrow scope to reduce overlap.',
            applyAction: 'recommended_edit' as const,
            applyMode: editApplyMode,
            otherEntry: { identifier: 'org/bar', sourcePath: '/home/u/.claude/skills/org/bar' },
          },
        ]
      : [],
    reportPath: '/home/u/.skillsmith/audits/aud_test/report.md',
    summary: { totalEntries, totalFlags, errorCount, warningCount, durationMs: 5 },
  }
}

// ── severityBadgeClass ────────────────────────────────────────────────────────
describe('severityBadgeClass', () => {
  it("maps 'error' to 'badge-error'", () => {
    expect(severityBadgeClass('error')).toBe('badge-error')
  })

  it("maps 'warning' to 'badge-warning'", () => {
    expect(severityBadgeClass('warning')).toBe('badge-warning')
  })

  it("maps any unknown value to 'badge-default'", () => {
    expect(severityBadgeClass('bogus')).toBe('badge-default')
  })
})

// ── inventory-audit HTML (SMI-5318) ───────────────────────────────────────────
describe('inventory-audit HTML (SMI-5318)', () => {
  it('exact-collision render: contains badge-error, escaped identifier, and section heading', () => {
    const items = makeResponse({
      withCollision: true,
      totalFlags: 1,
      errorCount: 1,
    }).exactCollisions
    const html = getExactCollisionsSection(items)

    expect(html).toContain('badge-error')
    expect(html).toContain('org/foo')
    expect(html).toContain('Exact Collisions')
  })

  it('semantic render: contains badge-warning and cosine value', () => {
    const items = makeResponse({
      withSemantic: true,
      totalFlags: 1,
      warningCount: 1,
    }).semanticCollisions
    const html = getSemanticSection(items)

    expect(html).toContain('badge-warning')
    expect(html).toContain('0.91')
  })

  it('rename suggestion: contains currentName, suggested, copy + Apply-rename buttons', () => {
    const items = makeResponse({ withRename: true }).renameSuggestions
    const html = getRenameSuggestionsSection(items)

    expect(html).toContain('foo')
    expect(html).toContain('foo-2')
    expect(html).toContain('data-copy="foo-2"')
    // SMI-5325: Apply-rename button carries the collisionId (escaped).
    expect(html).toContain('apply-rename-btn')
    expect(html).toContain('data-collision="c1"')
    expect(html).toContain('Apply rename')
  })

  it('recommendedEdits (manual_review): shows the manual-review hint, NOT an Apply button', () => {
    const items = makeResponse({ withEdit: true, editApplyMode: 'manual_review' }).recommendedEdits
    const html = getRecommendedEditsSection(items)

    expect(html).toContain('Recommended Edits')
    expect(html).toContain('Searches files in the repo.')
    expect(html).toContain('Searches TypeScript files in the repo.')
    expect(html).toContain('Narrow scope to reduce overlap.')
    // manual_review → hint, no apply-edit button
    expect(html).toContain('Review and apply manually')
    expect(html).not.toContain('apply-edit-btn')
  })

  it('recommendedEdits (apply_with_confirmation): renders the Apply-edit button with data-collision', () => {
    const items = makeResponse({
      withEdit: true,
      editApplyMode: 'apply_with_confirmation',
    }).recommendedEdits
    const html = getRecommendedEditsSection(items)

    expect(html).toContain('apply-edit-btn')
    expect(html).toContain('data-collision="c1"')
    expect(html).toContain('Apply edit')
    expect(html).not.toContain('Review and apply manually')
  })

  it('recommendedEdits: editApplyUnavailable collapses an applyable row to the hint', () => {
    const items = makeResponse({
      withEdit: true,
      editApplyMode: 'apply_with_confirmation',
    }).recommendedEdits
    const html = getRecommendedEditsSection(items, true)

    expect(html).not.toContain('apply-edit-btn')
    expect(html).toContain('Review and apply manually')
  })

  it('XSS escape: a malicious collisionId is escaped into the data-collision attribute', () => {
    const xss = '"><img src=x onerror=alert(1)>'
    const items = [
      {
        collisionId: xss,
        entry: makeEntry(),
        currentName: 'foo',
        suggested: 'foo-2',
        applyAction: 'rename_skill_dir_and_frontmatter' as const,
        reason: 'collision',
      },
    ]
    const html = getRenameSuggestionsSection(items)

    expect(html).not.toContain('onerror=alert(1)>')
    expect(html).toContain('&lt;img')
  })

  it('XSS escape: <script> identifier is escaped, raw form absent', () => {
    const xssId = '<script>alert(1)</script>'
    const items = [
      {
        kind: 'exact' as const,
        collisionId: 'xss1',
        identifier: xssId,
        entries: [makeEntry(xssId)],
        severity: 'error' as const,
        reason: 'dup',
      },
    ]
    const html = getExactCollisionsSection(items)

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('clean state: contains "No namespace collisions found." and scanned-entries count', () => {
    const response = makeResponse({ totalFlags: 0, totalEntries: 42 })
    const html = getInventoryAuditHtml(response, NONCE)

    expect(html).toContain('No namespace collisions found.')
    expect(html).toContain('42')
  })

  it('clean state: still contains Open Full Report affordance', () => {
    const response = makeResponse({ totalFlags: 0 })
    const html = getInventoryAuditHtml(response, NONCE)

    expect(html).toContain('Open Full Report')
  })

  it('empty section skip: exactCollisions:[] → no "Exact Collisions" heading', () => {
    const response = makeResponse({
      totalFlags: 1,
      warningCount: 1,
      withSemantic: true,
    })
    const html = getInventoryAuditHtml(response, NONCE)

    expect(html).not.toContain('Exact Collisions')
  })

  it('error builder: getInventoryAuditErrorHtml contains message and Retry button', () => {
    const html = getInventoryAuditErrorHtml('boom', NONCE)

    expect(html).toContain('boom')
    expect(html).toContain('Retry')
  })
})
