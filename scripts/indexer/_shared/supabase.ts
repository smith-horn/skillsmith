/**
 * Supabase client factory for the Node indexer entrypoint
 * @module scripts/indexer/_shared/supabase
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/_shared/supabase.ts`.
 * Substitutes `process.env` for `Deno.env.get`, npm import for `esm.sh` URL.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Create an admin Supabase client (bypasses RLS).
 * Used by the indexer runner for all DB writes.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    )
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

/**
 * Generate a request ID for tracing.
 * `crypto.randomUUID()` is available on Node ≥ 19 (Node 22 in CI).
 */
export function getRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Log function invocation as a single JSON line.
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
