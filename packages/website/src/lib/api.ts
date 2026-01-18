/**
 * API client for Skillsmith backend
 *
 * Integrates with api.skillsmith.app for skill data retrieval.
 *
 * SMI-1071: Path configuration for different API types
 */

import type { Skill, SkillSearchParams, SkillSearchResult, ApiResponse } from '../types/index'

// Base URLs for different environments
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || 'https://api.skillsmith.app'

/**
 * API path prefixes for different endpoint types
 *
 * - REST: Standard REST API endpoints (skills, users, etc.)
 * - EDGE: Supabase Edge Functions (stats, checkout, etc.)
 *
 * @example
 * // REST API: /v1/skills/search
 * const searchUrl = `${API_BASE_URL}${API_PATHS.rest}/skills/search`
 *
 * // Edge Function: /functions/v1/stats
 * const statsUrl = `${API_BASE_URL}${API_PATHS.edge}/stats`
 */
export const API_PATHS = {
  /** REST API prefix - e.g., /v1/skills/search */
  rest: '/v1',
  /** Supabase Edge Functions prefix - e.g., /functions/v1/checkout */
  edge: '/functions/v1',
} as const

/**
 * Get the full URL for a REST API endpoint
 */
export function getRestUrl(path: string): string {
  return `${API_BASE_URL}${API_PATHS.rest}${path}`
}

/**
 * Get the full URL for a Supabase Edge Function
 */
export function getEdgeFunctionUrl(functionName: string): string {
  return `${API_BASE_URL}${API_PATHS.edge}/${functionName}`
}

/**
 * Get the base API URL (for client-side use)
 */
export function getApiBaseUrl(): string {
  return API_BASE_URL
}

/**
 * Generic fetch wrapper with error handling
 */
async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const url = `${API_BASE_URL}${endpoint}`

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return {
        data: null as T,
        error: errorData.message || `HTTP ${response.status}: ${response.statusText}`,
      }
    }

    const data = await response.json()
    return { data }
  } catch (error) {
    return {
      data: null as T,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}

/**
 * Search for skills with optional filters
 */
export async function searchSkills(
  params: SkillSearchParams = {}
): Promise<ApiResponse<SkillSearchResult>> {
  const queryParams = new URLSearchParams()

  if (params.query) queryParams.set('q', params.query)
  if (params.category) queryParams.set('category', params.category)
  if (params.trustTier) queryParams.set('trust_tier', params.trustTier)
  if (params.minScore !== undefined) queryParams.set('min_score', String(params.minScore))
  if (params.limit !== undefined) queryParams.set('limit', String(params.limit))
  if (params.offset !== undefined) queryParams.set('offset', String(params.offset))

  const queryString = queryParams.toString()
  const endpoint = `/v1/skills/search${queryString ? `?${queryString}` : ''}`

  return apiFetch<SkillSearchResult>(endpoint)
}

/**
 * Get a single skill by ID
 */
export async function getSkill(id: string): Promise<ApiResponse<Skill>> {
  return apiFetch<Skill>(`/v1/skills/${encodeURIComponent(id)}`)
}

/**
 * Get featured skills for landing page
 */
export async function getFeaturedSkills(limit = 6): Promise<ApiResponse<Skill[]>> {
  return apiFetch<Skill[]>(`/v1/skills/featured?limit=${limit}`)
}

/**
 * Get skill categories with counts
 */
export async function getCategories(): Promise<
  ApiResponse<Array<{ category: string; count: number }>>
> {
  return apiFetch<Array<{ category: string; count: number }>>('/v1/skills/categories')
}

/**
 * Get popular skills
 */
export async function getPopularSkills(limit = 10): Promise<ApiResponse<Skill[]>> {
  return apiFetch<Skill[]>(`/v1/skills/popular?limit=${limit}`)
}

/**
 * Get recently added skills
 */
export async function getRecentSkills(limit = 10): Promise<ApiResponse<Skill[]>> {
  return apiFetch<Skill[]>(`/v1/skills/recent?limit=${limit}`)
}
