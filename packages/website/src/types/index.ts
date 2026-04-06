/**
 * Type definitions for Skillsmith website
 */

/**
 * Feature in a pricing tier
 */
export interface PricingFeature {
  /** Feature display name */
  name: string
  /** Whether this feature is on the roadmap (not yet implemented) */
  roadmap?: boolean
}

/**
 * Pricing tier information (unified — canonical source: pricing-data.ts)
 */
export interface PricingTier {
  id: 'community' | 'individual' | 'team' | 'enterprise'
  name: string
  monthlyPrice: number
  period?: string
  description: string
  apiCalls: number | 'unlimited'
  apiCallsFormatted: string
  features: PricingFeature[]
  cta: string
  ctaHref: string
  highlighted?: boolean
}

/**
 * Skill data from API
 */
export interface Skill {
  id: string
  author: string
  name: string
  displayName: string
  description: string
  version: string
  trustTier: 'verified' | 'community' | 'experimental' | 'unknown'
  category: SkillCategory
  tags: string[]
  qualityScore: number
  downloadCount: number
  createdAt: string
  updatedAt: string
}

/**
 * Skill categories
 */
export type SkillCategory =
  | 'development'
  | 'testing'
  | 'devops'
  | 'documentation'
  | 'productivity'
  | 'ai'
  | 'data'
  | 'security'
  | 'other'

/**
 * Search parameters
 */
export interface SkillSearchParams {
  query?: string
  category?: SkillCategory
  trustTier?: Skill['trustTier']
  minScore?: number
  limit?: number
  offset?: number
}

/**
 * Search results from API
 */
export interface SkillSearchResult {
  skills: Skill[]
  total: number
  hasMore: boolean
}

/**
 * Navigation item
 */
export interface NavItem {
  label: string
  href: string
  external?: boolean
  children?: NavItem[]
}

/**
 * Feature item for landing page
 */
export interface Feature {
  title: string
  description: string
  icon: string
}

/**
 * Testimonial
 */
export interface Testimonial {
  quote: string
  author: string
  role: string
  company: string
  avatar?: string
}

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  data: T
  error?: string
  meta?: {
    total?: number
    page?: number
    limit?: number
  }
}
