/**
 * @fileoverview Resolve team_id from license key via Supabase join chain
 * @module @skillsmith/mcp-server/utils/team-resolver
 * @see SMI-3914: Wave 0 Shared Infrastructure
 *
 * Join chain: license_keys -> subscriptions -> teams
 * LRU cache: max 100 entries, 60s TTL
 */

interface CacheEntry {
  teamId: string
  expiresAt: number
}

/** Shape of the Supabase join result for license_keys -> subscriptions -> teams */
interface TeamResolutionResult {
  subscriptions: { teams: { id: string } } | null
}

/** Minimal Supabase client interface for team resolution */
interface SupabaseQueryClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        single(): Promise<{ data: TeamResolutionResult | null; error: { message: string } | null }>
      }
    }
  }
}

const cache = new Map<string, CacheEntry>()
const MAX_CACHE_SIZE = 100
const CACHE_TTL_MS = 60_000

/**
 * Resolve a team ID from a license key via Supabase.
 * Results are cached with a 60-second TTL and LRU eviction at 100 entries.
 *
 * @param licenseKey - The license key to resolve
 * @returns The team ID associated with the license key
 * @throws Error if the team cannot be resolved
 */
export async function resolveTeamId(licenseKey: string): Promise<string> {
  // Check cache
  const cached = cache.get(licenseKey)
  if (cached && cached.expiresAt > Date.now()) return cached.teamId

  // Import supabase client
  const { getSupabaseAdminClient } = await import('../supabase-client.js')
  const supabase = await getSupabaseAdminClient()

  // Join chain: license_keys -> subscriptions -> teams
  const client = supabase as SupabaseQueryClient
  const { data, error } = await client
    .from('license_keys')
    .select('subscriptions(teams(id))')
    .eq('key_hash', licenseKey)
    .single()

  if (error || !data?.subscriptions?.teams?.id) {
    throw new Error('Could not resolve team from license key')
  }

  const teamId: string = data.subscriptions.teams.id

  // LRU eviction: remove oldest entry if at capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }

  cache.set(licenseKey, { teamId, expiresAt: Date.now() + CACHE_TTL_MS })
  return teamId
}

/** Clear the team resolver cache (for testing) */
export function clearTeamResolverCache(): void {
  cache.clear()
}
