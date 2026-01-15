/**
 * Type definitions for Skillsmith website
 */

/**
 * Pricing tier information
 */
export interface PricingTier {
  id: 'community' | 'individual' | 'team' | 'enterprise'
  name: string
  price: number | null // null for "Contact Us" pricing
  priceUnit: 'month' | 'user/month'
  apiCalls: number | 'unlimited'
  features: string[]
  highlighted?: boolean
  ctaText: string
  ctaLink: string
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
