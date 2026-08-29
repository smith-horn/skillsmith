/**
 * SSO role-mapping preview (SMI-6205 / SMI-6200 Wave 4 Step 2).
 *
 * Thin wrapper around the `sso_map_role(p_group_claims, p_role_mapping)` RPC —
 * the same pure, IMMUTABLE, zero-table-access function `record_sso_login()`
 * calls to decide a real SSO login's role. Per the Wave 4 Step 2 design,
 * this file owns ONLY the RPC call plus error/timeout handling — no mapping
 * rules live here, and there is no second (TypeScript) mapping
 * implementation to keep in sync ("no TypeScript twin").
 *
 * Error handling mirrors how packages/website/src/pages/login.astro wraps
 * `signInWithSSO` with `withAuthTimeout` (SMI-5055): a preview is UI-only
 * (an admin trying out a mapping before saving it), so a timeout, an RPC
 * error, or a missing client all collapse to `null` — the same value a
 * legitimate "no group matches" answer produces. Callers that need to
 * distinguish "no match" from "couldn't ask" should watch the console.
 */

import { AuthTimeoutError, withAuthTimeout } from './auth-timeout'
import { getSupabaseClient } from './supabase-client'

/**
 * Mirrors `team_sso_settings.role_mapping`'s CHECK constraint shape
 * (supabase/migrations/20260828000001_team_sso_settings.sql:
 * `team_sso_settings_role_mapping_shape`): an object keyed only by
 * `admin`/`member`, each an array of IdP group-name strings. `'owner'` is
 * structurally not a valid key — the constraint rejects it at write time,
 * and `sso_map_role()` cannot produce it as an output either way.
 */
export interface SsoRoleMapping {
  admin?: string[]
  member?: string[]
}

export type TeamRole = 'admin' | 'member'

const PREVIEW_TIMEOUT_MS = 8000

const VALID_ROLES: ReadonlySet<TeamRole> = new Set(['admin', 'member'])

/**
 * Preview what `sso_map_role()` would resolve a set of IdP group claims to
 * under a given (possibly unsaved) role mapping. Returns `null` when no
 * group matches any configured role, AND on any error/timeout — this
 * function makes no security decision, so it degrades to the same "no
 * match" shape a caller would see from a legitimately empty mapping.
 */
export async function previewSsoRoleMapping(
  groups: string[],
  mapping: SsoRoleMapping
): Promise<TeamRole | null> {
  const supabase = getSupabaseClient()
  if (!supabase) {
    console.error('[sso-role-preview] Supabase client not configured')
    return null
  }

  try {
    // supabase.rpc(...) returns a PostgrestFilterBuilder (thenable, not a
    // structural Promise — missing .catch/.finally/Symbol.toStringTag), so
    // it must be coerced via Promise.resolve() before withAuthTimeout's
    // Promise<T> race can accept it.
    const { data, error } = await withAuthTimeout(
      Promise.resolve(
        supabase.rpc('sso_map_role', {
          p_group_claims: groups,
          p_role_mapping: mapping,
        })
      ),
      PREVIEW_TIMEOUT_MS,
      'Role-mapping preview did not respond in time.'
    )
    if (error) {
      console.error('[sso-role-preview] sso_map_role RPC error:', error.message)
      return null
    }
    return typeof data === 'string' && VALID_ROLES.has(data as TeamRole) ? (data as TeamRole) : null
  } catch (err) {
    if (err instanceof AuthTimeoutError) {
      console.error('[sso-role-preview]', err.message)
    } else {
      console.error('[sso-role-preview] sso_map_role threw:', err)
    }
    return null
  }
}
