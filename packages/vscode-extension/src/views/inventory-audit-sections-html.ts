/**
 * Per-section HTML renderers for the Skill Inventory Audit panel
 * (SMI-5318 / #1459).
 *
 * Each function takes the relevant array (or the summary object) and returns a
 * host-built HTML string, returning `''` when its array is empty so empty
 * sections never render. Split out of inventory-audit-panel-html.ts to keep
 * both files under the 500-line cap.
 *
 * Security: every untrusted field is escaped via `escapeHtml`; nested arrays
 * are iterated and escaped per-element (never `JSON.stringify`-d raw into the
 * markup). Severity → CSS class goes through a whitelist (`severityBadgeClass`)
 * so a malformed severity can never be interpolated into a class attribute.
 */

import { escapeHtml } from '../utils/security.js'
import type {
  McpExactCollision,
  McpGenericFlag,
  McpInventoryEntry,
  McpRecommendedEdit,
  McpRenameSuggestion,
  McpSemanticCollision,
} from '../mcp/types.js'

/**
 * Map a severity string to a whitelisted badge CSS class. Anything that is not
 * exactly `'error'` or `'warning'` falls back to `badge-default` — the raw
 * severity is never interpolated into the class attribute.
 */
export function severityBadgeClass(severity: string): string {
  if (severity === 'error') return 'badge-error'
  if (severity === 'warning') return 'badge-warning'
  return 'badge-default'
}

/** Render the `kind` of an entry as a small escaped tag. */
function renderKind(kind: string): string {
  return `<span class="tag">${escapeHtml(kind)}</span>`
}

/** Render one inventory entry (identifier + kind + source path), all escaped. */
function renderEntryLine(entry: McpInventoryEntry): string {
  const identifier = typeof entry.identifier === 'string' ? entry.identifier : ''
  const kind = typeof entry.kind === 'string' ? entry.kind : ''
  const sourcePath = typeof entry.source_path === 'string' ? entry.source_path : ''
  return `
    <div class="entry-line">
      ${renderKind(kind)}
      <span class="entry-id">${escapeHtml(identifier)}</span>
      <span class="entry-path">${escapeHtml(sourcePath)}</span>
    </div>`
}

/** Render a severity badge + reason header shared by collision rows. */
function renderRowHeader(severity: string, identifier: string, reason: string): string {
  const badgeClass = severityBadgeClass(severity)
  const safeSeverity = escapeHtml(severity)
  return `
    <div class="row-header">
      <span class="badge ${badgeClass}">${safeSeverity}</span>
      <span class="row-identifier">${escapeHtml(identifier)}</span>
    </div>
    <div class="row-reason">${escapeHtml(reason)}</div>`
}

/** Exact identifier collisions (severity always `error`). */
export function getExactCollisionsSection(items: McpExactCollision[]): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  const rows = items
    .map((c) => {
      const identifier = typeof c.identifier === 'string' ? c.identifier : ''
      const reason = typeof c.reason === 'string' ? c.reason : ''
      const entries = Array.isArray(c.entries) ? c.entries : []
      const entryLines = entries.map((e) => renderEntryLine(e)).join('')
      return `
      <div class="collision-row">
        ${renderRowHeader(c.severity, identifier, reason)}
        <div class="entry-list">${entryLines}</div>
      </div>`
    })
    .join('')
  return `
    <section aria-labelledby="exact-collisions-heading">
      <h2 id="exact-collisions-heading">Exact Collisions</h2>
      ${rows}
    </section>`
}

/** Semantic-overlap collisions (severity always `warning`; deep pass only). */
export function getSemanticSection(items: McpSemanticCollision[]): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  const rows = items
    .map((c) => {
      const reason = typeof c.reason === 'string' ? c.reason : ''
      const score = Number.isFinite(c.cosineScore) ? c.cosineScore.toFixed(2) : '—'
      const phrases = Array.isArray(c.overlappingPhrases) ? c.overlappingPhrases : []
      const phraseLines = phrases
        .map((p) => {
          const phrase1 = typeof p.phrase1 === 'string' ? p.phrase1 : ''
          const phrase2 = typeof p.phrase2 === 'string' ? p.phrase2 : ''
          const sim = Number.isFinite(p.similarity) ? p.similarity.toFixed(2) : '—'
          return `
          <div class="phrase-line">
            <span class="phrase">${escapeHtml(phrase1)}</span>
            <span class="phrase-sep">↔</span>
            <span class="phrase">${escapeHtml(phrase2)}</span>
            <span class="phrase-sim">${escapeHtml(sim)}</span>
          </div>`
        })
        .join('')
      return `
      <div class="collision-row">
        ${renderRowHeader(c.severity, '', reason)}
        <div class="semantic-entries">
          ${renderEntryLine(c.entryA)}
          ${renderEntryLine(c.entryB)}
        </div>
        <div class="cosine-score">Cosine similarity: ${escapeHtml(score)}</div>
        <div class="phrase-list">${phraseLines}</div>
      </div>`
    })
    .join('')
  return `
    <section aria-labelledby="semantic-collisions-heading">
      <h2 id="semantic-collisions-heading">Semantic Overlaps</h2>
      ${rows}
    </section>`
}

/** Generic-token flags (severity always `warning`). */
export function getGenericFlagsSection(items: McpGenericFlag[]): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  const rows = items
    .map((f) => {
      const identifier = typeof f.identifier === 'string' ? f.identifier : ''
      const reason = typeof f.reason === 'string' ? f.reason : ''
      const tokens = Array.isArray(f.matchedTokens) ? f.matchedTokens : []
      const tokenTags = tokens
        .filter((t) => typeof t === 'string')
        .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
        .join(' ')
      return `
      <div class="collision-row">
        ${renderRowHeader(f.severity, identifier, reason)}
        ${renderEntryLine(f.entry)}
        <div class="matched-tokens">${tokenTags || '<span class="muted">—</span>'}</div>
      </div>`
    })
    .join('')
  return `
    <section aria-labelledby="generic-flags-heading">
      <h2 id="generic-flags-heading">Generic-Token Flags</h2>
      ${rows}
    </section>`
}

/** Suggested renames — each row carries a copy button reading `data-copy`. */
export function getRenameSuggestionsSection(items: McpRenameSuggestion[]): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  const rows = items
    .map((r) => {
      const currentName = typeof r.currentName === 'string' ? r.currentName : ''
      const suggested = typeof r.suggested === 'string' ? r.suggested : ''
      const reason = typeof r.reason === 'string' ? r.reason : ''
      return `
      <div class="rename-row">
        <div class="rename-names">
          <span class="rename-current">${escapeHtml(currentName)}</span>
          <span class="rename-arrow">→</span>
          <span class="rename-suggested">${escapeHtml(suggested)}</span>
          <button class="copy-btn" data-copy="${escapeHtml(suggested)}">Copy</button>
        </div>
        ${renderEntryLine(r.entry)}
        <div class="row-reason">${escapeHtml(reason)}</div>
      </div>`
    })
    .join('')
  return `
    <section aria-labelledby="rename-suggestions-heading">
      <h2 id="rename-suggestions-heading">Rename Suggestions</h2>
      ${rows}
    </section>`
}

/** Recommended prose edits — READ-ONLY (before → after + rationale, no apply). */
export function getRecommendedEditsSection(items: McpRecommendedEdit[]): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  const rows = items
    .map((e) => {
      const filePath = typeof e.filePath === 'string' ? e.filePath : ''
      const before = typeof e.before === 'string' ? e.before : ''
      const after = typeof e.after === 'string' ? e.after : ''
      const rationale = typeof e.rationale === 'string' ? e.rationale : ''
      return `
      <div class="edit-row">
        <div class="edit-file">${escapeHtml(filePath)}</div>
        <div class="edit-diff">
          <div class="edit-before"><span class="edit-label">Before</span><pre>${escapeHtml(before)}</pre></div>
          <div class="edit-after"><span class="edit-label">After</span><pre>${escapeHtml(after)}</pre></div>
        </div>
        <div class="row-reason">${escapeHtml(rationale)}</div>
      </div>`
    })
    .join('')
  return `
    <section aria-labelledby="recommended-edits-heading">
      <h2 id="recommended-edits-heading">Recommended Edits (read-only)</h2>
      ${rows}
    </section>`
}

/** Summary type, mirrored locally to avoid importing the whole response shape. */
export interface InventoryAuditSummary {
  totalEntries: number
  totalFlags: number
  errorCount: number
  warningCount: number
  durationMs: number
}

/** Render the summary counts block (aria-live updates on retry). */
export function getSummarySection(summary: InventoryAuditSummary): string {
  const totalEntries = Number.isFinite(summary.totalEntries) ? summary.totalEntries : 0
  const errorCount = Number.isFinite(summary.errorCount) ? summary.errorCount : 0
  const warningCount = Number.isFinite(summary.warningCount) ? summary.warningCount : 0
  return `
    <div class="summary" aria-live="polite">
      <span class="summary-stat">${totalEntries} entries scanned</span>
      <span class="summary-stat summary-error">${errorCount} error${errorCount === 1 ? '' : 's'}</span>
      <span class="summary-stat summary-warning">${warningCount} warning${warningCount === 1 ? '' : 's'}</span>
    </div>`
}
