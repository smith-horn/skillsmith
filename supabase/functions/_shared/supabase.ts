/**
 * Supabase client factory for Edge Functions
 * @module _shared/supabase
 *
 * SMI-1180: API Development - Wave 3
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'

/**
 * Skill type matching the database schema
 */
export interface Skill {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url: string | null
  quality_score: number | null
  trust_tier: 'verified' | 'community' | 'experimental' | 'unknown'
  tags: string[]
  source: string | null
  stars: number | null
  created_at: string
  updated_at: string
}

/**
 * Search result with ranking
 */
export interface SearchResult extends Skill {
  rank?: number
  similarity?: number
}

/**
 * Create a Supabase client for Edge Functions
 * Uses environment variables for configuration
 *
 * @param authHeader - Optional Authorization header for RLS
 * @returns Configured Supabase client
 */
export function createSupabaseClient(authHeader?: string): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing required environment variables: SUPABASE_URL and SUPABASE_ANON_KEY')
  }

  const options: { global: { headers: Record<string, string> } } = {
    global: {
      headers: {},
    },
  }

  // Pass through auth header for RLS if provided
  if (authHeader) {
    options.global.headers['Authorization'] = authHeader
  }

  return createClient(supabaseUrl, supabaseKey, options)
}

/**
 * Create an admin Supabase client (bypasses RLS)
 * Only use for operations that require elevated privileges
 *
 * @returns Admin Supabase client
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing required environment variables for admin client')
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

/**
 * Validate and parse pagination parameters
 * @param limit - Requested limit
 * @param offset - Requested offset
 * @returns Validated pagination values
 */
export function validatePagination(
  limit?: string | number | null,
  offset?: string | number | null
): { limit: number; offset: number } {
  const parsedLimit = Number(limit) || 20
  const parsedOffset = Number(offset) || 0

  return {
    limit: Math.min(Math.max(1, parsedLimit), 100), // Clamp between 1 and 100
    offset: Math.max(0, parsedOffset),
  }
}

/**
 * Extract request ID from headers for tracing
 * @param headers - Request headers
 * @returns Request ID or generated UUID
 */
export function getRequestId(headers: Headers): string {
  return headers.get('x-request-id') || crypto.randomUUID()
}

/**
 * Log function invocation for debugging
 * @param functionName - Name of the edge function
 * @param requestId - Request tracking ID
 * @param metadata - Additional log metadata
 */
export function logInvocation(
  functionName: string,
  requestId: string,
  metadata?: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({
      type: 'invocation',
      function: functionName,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      ...metadata,
    })
  )
}

/**
 * Escape special characters for LIKE/ILIKE queries
 * Prevents wildcard injection attacks
 * @param input - User input string
 * @returns Escaped string safe for LIKE queries
 */
export function escapeLikePattern(input: string): string {
  // Escape special LIKE characters: %, _, and backslash
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Sanitize user input for safe use in PostgREST filters
 * Removes/escapes characters that could manipulate filter logic
 * @param input - User input string
 * @returns Sanitized string safe for filter construction
 */
export function sanitizeFilterInput(input: string): string {
  // Only allow alphanumeric, spaces, hyphens, and common punctuation
  // Remove any characters that could be used for filter injection
  return input
    .replace(/[^\w\s\-_.]/g, '') // Remove special characters except allowed ones
    .trim()
    .slice(0, 100) // Limit length
}

/**
 * Validate if input is safe for use in PostgREST filters
 * @param input - Input to validate
 * @returns True if safe, false otherwise
 */
export function isValidFilterInput(input: string): boolean {
  // Reject if contains filter syntax characters
  const dangerousPatterns = /[,."'[\](){}|&]/
  return !dangerousPatterns.test(input) && input.length <= 100
}
