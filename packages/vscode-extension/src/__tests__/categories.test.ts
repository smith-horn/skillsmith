/**
 * Tests for the local API_CATEGORIES mirror (#1433 / SMI-5304).
 *
 * Mirror non-empty + drift guard: asserts the documented 6-value length so a
 * core-side change to packages/core/src/api/types.ts API_CATEGORIES is caught
 * here rather than silently diverging (ADR-113 — mirror, do not import).
 */
import { describe, it, expect, vi } from 'vitest'

// categories.ts imports `* as vscode` only for the QuickPickItem type + helper;
// nothing is called at module load, so a bare stub is sufficient.
vi.mock('vscode', () => ({}))

import { API_CATEGORIES, getCategoryQuickPickItems } from '../sidebar/categories.js'

describe('categories mirror (#1433 / SMI-5304)', () => {
  it('mirror is non-empty', () => {
    expect(API_CATEGORIES.length).toBeGreaterThan(0)
  })

  it('drift guard: exactly 6 categories (keep in sync with core API_CATEGORIES)', () => {
    expect(API_CATEGORIES).toHaveLength(6)
  })

  it('contains the canonical category set', () => {
    expect([...API_CATEGORIES]).toEqual([
      'Development',
      'Testing',
      'DevOps',
      'Documentation',
      'Productivity',
      'Security',
    ])
  })

  it('getCategoryQuickPickItems returns one item per category, labelled', () => {
    const items = getCategoryQuickPickItems()
    expect(items).toHaveLength(API_CATEGORIES.length)
    expect(items.map((i) => i.label)).toEqual([...API_CATEGORIES])
  })
})
