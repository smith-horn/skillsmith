/**
 * Shared Supabase configuration utility
 * Used by all auth pages to ensure consistent config handling
 */

export interface SupabaseConfig {
  url: string
  anonKey: string
  apiBaseUrl: string
}

/**
 * Get Supabase configuration from environment variables
 * Must be called from Astro frontmatter (server-side)
 */
export function getSupabaseConfig(): SupabaseConfig {
  return {
    url: import.meta.env.PUBLIC_SUPABASE_URL || '',
    anonKey: import.meta.env.PUBLIC_SUPABASE_ANON_KEY || '',
    apiBaseUrl: import.meta.env.PUBLIC_API_BASE_URL || 'https://api.skillsmith.app',
  }
}
