/**
 * Tests for the 3-step QuickPick filter collector (#1433 / SMI-5304).
 *
 * `collectSearchFilters` takes an injected `showQuickPick` so the three steps
 * (trust tier → category → min score) can be driven deterministically without
 * the extension host. Asserts: facets collected; "Any"/skip clears that facet;
 * Escape (undefined) at any step aborts the whole flow (returns undefined).
 */
import { describe, it, expect, vi } from 'vitest'

// searchFilters.ts → trustTier.ts imports `* as vscode` but only touches it in
// getTrustTierIcon (never reached here); a bare stub is sufficient.
vi.mock('vscode', () => ({
  window: { showQuickPick: vi.fn() },
}))

import { collectSearchFilters, type SearchFilters } from '../commands/searchFilters.js'
import type * as vscode from 'vscode'

type QPItem = vscode.QuickPickItem

/**
 * Builds an injectable showQuickPick that returns the supplied picks in order.
 * `undefined` simulates Escape at that step.
 */
function scriptedQuickPick(picks: Array<QPItem | undefined>) {
  let call = 0
  const fn = vi.fn(async (items: readonly QPItem[], _opts: vscode.QuickPickOptions) => {
    const choice = picks[call]
    call++
    if (choice === undefined) {
      return undefined
    }
    // Resolve the scripted choice against the actual items by label so tests
    // pin to the collector's real item set (catches label drift).
    return items.find((i) => i.label === choice.label) ?? choice
  })
  return fn
}

/** Locate an item by a label substring among a step's offered items. */
function pickByLabel(label: string): QPItem {
  return { label }
}

describe('collectSearchFilters (#1433 / SMI-5304)', () => {
  it('collects tier + category + score into a SearchFilters object', async () => {
    const showQuickPick = scriptedQuickPick([
      { label: '$(verified) Verified', description: 'verified' },
      pickByLabel('Testing'),
      pickByLabel('70+'),
    ])

    const result = await collectSearchFilters(showQuickPick)

    expect(result).toEqual<SearchFilters>({
      trustTier: 'verified',
      category: 'Testing',
      minScore: 70,
    })
    expect(showQuickPick).toHaveBeenCalledTimes(3)
  })

  it('"Any" at each step clears that facet (empty filters)', async () => {
    const showQuickPick = scriptedQuickPick([
      pickByLabel('Any tier'),
      pickByLabel('Any category'),
      pickByLabel('Any score'),
    ])

    const result = await collectSearchFilters(showQuickPick)

    expect(result).toEqual<SearchFilters>({})
  })

  it('a skipped middle facet is cleared while the others are kept', async () => {
    const showQuickPick = scriptedQuickPick([
      { label: '$(verified-filled) Official', description: 'official' },
      pickByLabel('Any category'),
      pickByLabel('90+'),
    ])

    const result = await collectSearchFilters(showQuickPick)

    expect(result).toEqual<SearchFilters>({ trustTier: 'official', minScore: 90 })
    expect(result?.category).toBeUndefined()
  })

  it('Escape on step 1 aborts the whole flow (undefined)', async () => {
    const showQuickPick = scriptedQuickPick([undefined])
    const result = await collectSearchFilters(showQuickPick)
    expect(result).toBeUndefined()
    expect(showQuickPick).toHaveBeenCalledTimes(1)
  })

  it('Escape on step 2 aborts the whole flow (undefined)', async () => {
    const showQuickPick = scriptedQuickPick([
      { label: '$(verified) Verified', description: 'verified' },
      undefined,
    ])
    const result = await collectSearchFilters(showQuickPick)
    expect(result).toBeUndefined()
    expect(showQuickPick).toHaveBeenCalledTimes(2)
  })

  it('Escape on step 3 aborts the whole flow (undefined)', async () => {
    const showQuickPick = scriptedQuickPick([
      { label: '$(verified) Verified', description: 'verified' },
      pickByLabel('Testing'),
      undefined,
    ])
    const result = await collectSearchFilters(showQuickPick)
    expect(result).toBeUndefined()
    expect(showQuickPick).toHaveBeenCalledTimes(3)
  })

  it('step 1 offers an Any entry plus all 5 canonical tiers', async () => {
    let tierItems: readonly QPItem[] = []
    const showQuickPick = vi.fn(async (items: readonly QPItem[]) => {
      if (tierItems.length === 0) {
        tierItems = items
      }
      return undefined // abort after capturing step 1
    })
    await collectSearchFilters(showQuickPick)
    expect(tierItems).toHaveLength(6) // Any + 5 tiers
    expect(tierItems[0]?.label).toBe('Any tier')
  })
})
