/**
 * Pricing tier configuration (re-exports from canonical source)
 *
 * Based on ADR-013 (Open Core Licensing) and ADR-017 (Quota Enforcement)
 * SMI-3909: Consolidated — all data lives in pricing-data.ts
 */

import type { PricingTier } from '../types/index'
import {
  pricingTiers,
  formatPrice as formatPriceFromData,
  formatApiCalls,
  getTierById,
} from './pricing-data'

/**
 * Complete pricing tier definitions (re-exported from pricing-data.ts)
 */
export const PRICING_TIERS: PricingTier[] = pricingTiers

export { formatApiCalls, getTierById }

/**
 * Format price for display (accepts a tier object)
 */
export function formatPrice(tier: PricingTier): string {
  return formatPriceFromData(tier.monthlyPrice)
}
