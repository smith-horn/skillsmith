/**
 * Local mirror of the canonical 6-value category enum
 * (packages/core/src/api/types.ts API_CATEGORIES). ADR-113 forbids importing
 * @skillsmith/core into the extension; keep this in sync with
 * packages/core/src/api/types.ts API_CATEGORIES.
 *
 * Used by the #1433 filter QuickPick (src/commands/searchFilters.ts). A drift
 * guard (src/__tests__/categories.test.ts) asserts the documented length so a
 * core-side change is caught at CI rather than silently diverging.
 */
import * as vscode from 'vscode'

/**
 * The canonical 6 category filter values, mirroring API_CATEGORIES from
 * packages/core/src/api/types.ts. Order matches core (insertion order).
 */
export const API_CATEGORIES = [
  'Development',
  'Testing',
  'DevOps',
  'Documentation',
  'Productivity',
  'Security',
] as const

/** A single category value. */
export type ApiCategory = (typeof API_CATEGORIES)[number]

/**
 * Builds QuickPick items for the category filter step. The returned list is
 * just the 6 categories — the "Any" (clear) entry is composed by the collector
 * (src/commands/searchFilters.ts) so the clear semantics live in one place.
 */
export function getCategoryQuickPickItems(): vscode.QuickPickItem[] {
  return API_CATEGORIES.map((category) => ({ label: category }))
}
