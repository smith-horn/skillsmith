// Shared types for website components

// SMI-5217: alias the canonical 5-tier public vocabulary (terminology.ts) so the
// rendering layer can't re-drift to the legacy DB tiers (experimental/unknown).
export type { TrustTierId as TrustTier } from '../constants/terminology'
