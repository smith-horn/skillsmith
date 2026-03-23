/**
 * Shared Supabase client singleton (SMI-3595)
 *
 * All client-side code must use getSupabaseClient() instead of
 * calling createClient() directly. This avoids multiple GoTrueClient
 * instances competing for the same auth storage keys.
 *
 * Requires window.__SUPABASE_CONFIG__ to be set by the page
 * (injected via BaseLayout.astro or page-level is:inline script).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Returns a singleton SupabaseClient, creating it on first call.
 * Returns null if __SUPABASE_CONFIG__ is missing or incomplete.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (window.__SUPABASE_CLIENT__) return window.__SUPABASE_CLIENT__

  const config = window.__SUPABASE_CONFIG__
  if (!config?.url || !config?.anonKey) return null

  window.__SUPABASE_CLIENT__ = createClient(config.url, config.anonKey)
  return window.__SUPABASE_CLIENT__
}
