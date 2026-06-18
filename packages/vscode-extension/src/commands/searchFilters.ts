/**
 * #1433 (SMI-5304) — the 3-step skippable QuickPick collector for discovery
 * filters (trust tier → category → min score).
 *
 * Extracted into its own module (plan-review #6) so `searchSkills.ts` stays
 * well under the 500-line gate and the collector is unit-testable in isolation.
 *
 * Each step offers an "Any" entry that CLEARS that facet; selecting it (or
 * leaving the step) drops the facet from the returned object. Pressing Escape
 * at any step ABORTS the whole flow and returns `undefined` so the caller can
 * leave existing filters untouched (vs. an explicit "clear all" which returns
 * `{}`).
 *
 * `showQuickPick` is injected (defaulting to `vscode.window.showQuickPick`) so
 * tests can drive the three steps deterministically without the extension host.
 */
import * as vscode from 'vscode'
import {
  type ExtensionTrustTier,
  getTrustTierCodicon,
  getTrustTierLabel,
} from '../sidebar/trustTier.js'
import { getCategoryQuickPickItems } from '../sidebar/categories.js'

/**
 * Discovery filter facets. An absent key means that facet is unset (no
 * filtering on it). This is the single shape stored on the provider and passed
 * to `SkillService.search` options.
 */
export interface SearchFilters {
  category?: string
  trustTier?: string
  minScore?: number
}

/** Minimum-score presets offered in step 3. */
const MIN_SCORE_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '50+', value: 50 },
  { label: '70+', value: 70 },
  { label: '90+', value: 90 },
]

/** Trust tiers offered in step 1, in canonical (highest-trust-first) order. */
const FILTER_TIERS: readonly ExtensionTrustTier[] = [
  'official',
  'verified',
  'curated',
  'community',
  'unverified',
]

/** The `vscode.window.showQuickPick` overload the collector relies on. */
type ShowQuickPick = (
  items: readonly vscode.QuickPickItem[],
  options: vscode.QuickPickOptions
) => Thenable<vscode.QuickPickItem | undefined>

/** Sentinel "Any" labels — selecting one clears that facet. */
const ANY_TIER = 'Any tier'
const ANY_CATEGORY = 'Any category'
const ANY_SCORE = 'Any score'

/**
 * Runs the 3-step QuickPick. Returns the collected `SearchFilters`, or
 * `undefined` if the user cancelled (Escape) at any step.
 */
export async function collectSearchFilters(
  showQuickPick: ShowQuickPick = vscode.window.showQuickPick.bind(vscode.window)
): Promise<SearchFilters | undefined> {
  const filters: SearchFilters = {}

  // Step 1/3 — trust tier.
  const tierItems: vscode.QuickPickItem[] = [
    { label: ANY_TIER },
    ...FILTER_TIERS.map((tier) => ({
      label: `${getTrustTierCodicon(tier)} ${getTrustTierLabel(tier)}`,
      description: tier,
    })),
  ]
  const tierPick = await showQuickPick(tierItems, {
    title: 'Filter Skills (1/3) — Trust tier',
    placeHolder: 'Select a trust tier (or Any to skip)',
  })
  if (tierPick === undefined) {
    return undefined
  }
  if (tierPick.label !== ANY_TIER && tierPick.description) {
    filters.trustTier = tierPick.description
  }

  // Step 2/3 — category.
  const categoryItems: vscode.QuickPickItem[] = [
    { label: ANY_CATEGORY },
    ...getCategoryQuickPickItems(),
  ]
  const categoryPick = await showQuickPick(categoryItems, {
    title: 'Filter Skills (2/3) — Category',
    placeHolder: 'Select a category (or Any to skip)',
  })
  if (categoryPick === undefined) {
    return undefined
  }
  if (categoryPick.label !== ANY_CATEGORY) {
    filters.category = categoryPick.label
  }

  // Step 3/3 — minimum score.
  const scoreItems: vscode.QuickPickItem[] = [
    { label: ANY_SCORE },
    ...MIN_SCORE_PRESETS.map((preset) => ({ label: preset.label })),
  ]
  const scorePick = await showQuickPick(scoreItems, {
    title: 'Filter Skills (3/3) — Minimum score',
    placeHolder: 'Select a minimum score (or Any to skip)',
  })
  if (scorePick === undefined) {
    return undefined
  }
  const preset = MIN_SCORE_PRESETS.find((p) => p.label === scorePick.label)
  if (preset) {
    filters.minScore = preset.value
  }

  return filters
}
