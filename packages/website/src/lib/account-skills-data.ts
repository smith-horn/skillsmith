/**
 * Skill Inventory page (`/account/skills`) client-side data loading (M7).
 *
 * Extracted out of account/skills.astro's inline client script to keep the
 * page under the repo's 500-line-per-file standard (same extraction pattern
 * as account-nav.ts / team-access.ts / account-summary-data.ts /
 * account-overview-data.ts / account-profile-data.ts). Render/DOM-building
 * helpers remain in lib/skills-page-render.ts — this module is data-fetch
 * only, matching that file's own "<500 line split" convention.
 *
 * @see docs/internal/implementation/account-dashboard-ux-consolidation.md
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildInventoryView, detectEmptyState } from './inventory-view'
import type { DeviceView, EmptyState, InventoryRow } from './inventory-view'

export interface SkillsInventoryData {
  emptyState: EmptyState
  devices: DeviceView[]
}

/**
 * Fetch the signed-in user's inventory-sync consent preference and their
 * `get_user_inventory()` rows in parallel, then shape them into the
 * page's DeviceView list and empty-state classification.
 *
 * Throws when either fetch errors — the caller surfaces this via its
 * existing error state rather than defaulting consent to off (a user with
 * sync ON + devices would otherwise be wrongly shown the "turn it on"
 * prompt).
 */
export async function loadSkillsInventoryData(
  supabase: SupabaseClient,
  userId: string
): Promise<SkillsInventoryData> {
  const [consentResult, invResult] = await Promise.all([
    supabase
      .from('user_telemetry_preferences')
      .select('inventory_sync_enabled')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase.rpc('get_user_inventory'),
  ])

  if (invResult.error || consentResult.error) {
    throw new Error('Could not load inventory. Check your connection and try again.')
  }

  const consentEnabled = (consentResult.data?.inventory_sync_enabled as boolean | null) ?? false
  const rows = (invResult.data as InventoryRow[]) ?? []
  const devices = buildInventoryView(rows)
  const emptyState = detectEmptyState(consentEnabled, devices.length)

  return { emptyState, devices }
}
