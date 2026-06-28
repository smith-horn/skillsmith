/**
 * cross-harness-inventory.helpers.ts
 *
 * SMI-5395 — Supabase / browser / cleanup helpers for the cross-harness
 * skill inventory e2e. Adapted from device-login-roundtrip.helpers.ts
 * (SMI-4460): the CLI-process machinery is omitted (option-b driver; M4),
 * and inventory-specific helpers are added.
 *
 * Helper responsibilities:
 *   - injectRealSupabase(page, {url, anonKey}): inject __SUPABASE_CONFIG__
 *   - signInTestUser(page, {email, password}): node-side signInWithPassword +
 *     localStorage transplant; returns { accessToken } for uploadInventory (L1)
 *   - admin(): lazy service-role SupabaseClient singleton
 *   - uploadInventory(accessToken, payload): POST /functions/v1/inventory-upload
 *     with both apikey + Bearer (L1); returns { status, body }
 *   - readDeviceSkills(deviceId): service-role direct read of device_skills rows
 *   - seedRegistrySkill({author, name, contentHash}): minimal skills INSERT for
 *     Test B drift validation (M1/L2 — no pinned_version, search_vector omitted)
 *   - deleteRegistrySkill({author, name}): Test B teardown
 *   - cleanupDevice(deviceId): delete user_devices row (FK CASCADE clears device_skills)
 *   - readUserConsent(userId): service-role read of user_telemetry_preferences
 *     .inventory_sync_enabled → boolean (H7)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Page } from '@playwright/test'
import { getConfig } from './cross-harness-inventory.config'
import { withTimeout, STAGING_CALL_TIMEOUT_MS } from './cross-harness-inventory.timeout'

// ─── Browser-side Supabase injection ──────────────────────────────────────

/**
 * Inject `__SUPABASE_CONFIG__` pointing at REAL staging. Mirrors the
 * `injectSupabaseStub` shape from complete-profile.helpers.ts but does NOT
 * route page traffic — fetches go to the real staging Supabase host.
 */
export async function injectRealSupabase(
  page: Page,
  opts: { url: string; anonKey: string }
): Promise<void> {
  await page.addInitScript(
    ({ url, anonKey }) => {
      ;(window as unknown as Record<string, unknown>).__SUPABASE_CONFIG__ = { url, anonKey }
    },
    { url: opts.url, anonKey: opts.anonKey }
  )
}

/**
 * Sign the test user in via supabase-js from node, then transplant the
 * resulting session into the browser's localStorage. This avoids needing
 * supabase-js loaded in a blank page and the resulting CORS/init dance.
 *
 * Returns { accessToken } so the spec can pass it directly to uploadInventory
 * without a second auth round-trip (L1).
 */
export async function signInTestUser(
  page: Page,
  opts: { email: string; password: string }
): Promise<{ accessToken: string }> {
  const cfg = getConfig()
  const anonClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await withTimeout(
    anonClient.auth.signInWithPassword({
      email: opts.email,
      password: opts.password,
    }),
    STAGING_CALL_TIMEOUT_MS,
    'signInTestUser/signInWithPassword'
  )
  if (error || !data.session) {
    throw new Error(`[SMI-5395] signInTestUser failed: ${error?.message ?? 'no session'}`)
  }
  const session = data.session
  // Compute the localStorage key supabase-js v2 uses for persistence.
  // Key shape: sb-<project-ref>-auth-token. Project ref = the URL host's first label.
  const ref = new URL(cfg.supabaseUrl).hostname.split('.')[0]
  const storageKey = `sb-${ref}-auth-token`
  // Push into localStorage BEFORE any page navigation completes so
  // getSupabaseClient() sees the session on first read.
  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* localStorage may be unavailable in some test contexts */
      }
    },
    {
      key: storageKey,
      value: JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        expires_in: session.expires_in,
        token_type: session.token_type,
        user: session.user,
      }),
    }
  )
  return { accessToken: session.access_token }
}

// ─── DB access (service-role) ─────────────────────────────────────────────

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (_admin) return _admin
  const cfg = getConfig()
  _admin = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _admin
}

// ─── Inventory edge function ──────────────────────────────────────────────

export interface InventorySkillInput {
  harness: string
  skill_id: string
  version?: string
  content_hash?: string
  pinned_version?: string
}

export interface InventoryPayload {
  device: {
    device_id: string
    label?: string
    platform?: string
    arch?: string
    cli_version?: string
  }
  skills: InventorySkillInput[]
}

export interface UploadInventoryResult {
  status: number
  body: unknown
}

/**
 * POST to /functions/v1/inventory-upload with BOTH apikey + Bearer headers
 * (L1 — gateway-verified fn requires the Supabase anon key and a valid JWT).
 * Returns { status, body } so assertions can inspect both independently.
 */
export async function uploadInventory(
  accessToken: string,
  payload: InventoryPayload
): Promise<UploadInventoryResult> {
  const cfg = getConfig()
  const res = await withTimeout(
    fetch(`${cfg.supabaseUrl}/functions/v1/inventory-upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    }),
    STAGING_CALL_TIMEOUT_MS,
    'uploadInventory/fetch'
  )
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

// ─── device_skills read (service-role) ───────────────────────────────────

export interface DeviceSkillRow {
  harness: string
  skill_id: string
  version: string | null
  present: boolean
  content_hash: string | null
  pinned_version: string | null
}

/** Service-role direct read of device_skills for a given device_id. */
export async function readDeviceSkills(deviceId: string): Promise<DeviceSkillRow[]> {
  const { data, error } = await withTimeout(
    admin()
      .from('device_skills')
      .select('harness, skill_id, version, present, content_hash, pinned_version')
      .eq('device_id', deviceId),
    STAGING_CALL_TIMEOUT_MS,
    'readDeviceSkills'
  )
  if (error) throw new Error(`[SMI-5395] readDeviceSkills: ${error.message}`)
  return (data ?? []) as DeviceSkillRow[]
}

// ─── Registry skill seed / teardown (Test B — M1/L2) ─────────────────────

/**
 * Insert a minimal synthetic registry skill so Test B can assert the drift
 * join key `(author||'/'||name) = skill_id` without relying on production data.
 *
 * Schema notes (001_initial_schema.sql + 039_skill_security_scanning.sql):
 *   - name NOT NULL (required)
 *   - search_vector is GENERATED ALWAYS AS ... STORED — MUST be omitted
 *   - created_at, updated_at NOT NULL DEFAULT NOW() — omitted (server fills)
 *   - quarantined NOT NULL DEFAULT FALSE — omitted (server fills)
 *   - author, content_hash nullable — included as they are the test join key
 *   - pinned_version intentionally absent (L2: drives current/drifted branch,
 *     not pinned, so the skill_state CASE reaches current/drifted)
 */
export async function seedRegistrySkill(opts: {
  author: string
  name: string
  contentHash: string
}): Promise<void> {
  const { error } = await withTimeout(
    admin().from('skills').insert({
      author: opts.author,
      name: opts.name,
      content_hash: opts.contentHash,
    }),
    STAGING_CALL_TIMEOUT_MS,
    'seedRegistrySkill'
  )
  if (error) throw new Error(`[SMI-5395] seedRegistrySkill: ${error.message}`)
}

/** Delete the synthetic registry skill seeded by seedRegistrySkill (Test B teardown). */
export async function deleteRegistrySkill(opts: { author: string; name: string }): Promise<void> {
  const { error } = await withTimeout(
    admin().from('skills').delete().eq('author', opts.author).eq('name', opts.name),
    STAGING_CALL_TIMEOUT_MS,
    'deleteRegistrySkill'
  )
  if (error) throw new Error(`[SMI-5395] deleteRegistrySkill: ${error.message}`)
}

// ─── Device cleanup ───────────────────────────────────────────────────────

/**
 * Delete the user_devices row for a given device_id. The FK ON DELETE CASCADE
 * on device_skills clears all child rows automatically. Used in afterEach to
 * prevent device rows from accumulating between test runs.
 */
export async function cleanupDevice(deviceId: string): Promise<void> {
  const { error } = await withTimeout(
    admin().from('user_devices').delete().eq('device_id', deviceId),
    STAGING_CALL_TIMEOUT_MS,
    'cleanupDevice'
  )
  if (error) throw new Error(`[SMI-5395] cleanupDevice: ${error.message}`)
}

// ─── Consent read (service-role, H7) ─────────────────────────────────────

/**
 * Service-role read of user_telemetry_preferences.inventory_sync_enabled for
 * a given user_id. Returns false if no row exists (the consent gate defaults
 * to false, matching the NOT NULL DEFAULT FALSE schema). Used in Test A to
 * assert the consent-ON user's pref is indeed true before the render step (H7).
 */
export async function readUserConsent(userId: string): Promise<boolean> {
  const { data, error } = await withTimeout(
    admin()
      .from('user_telemetry_preferences')
      .select('inventory_sync_enabled')
      .eq('user_id', userId)
      .maybeSingle(),
    STAGING_CALL_TIMEOUT_MS,
    'readUserConsent'
  )
  if (error) throw new Error(`[SMI-5395] readUserConsent: ${error.message}`)
  if (!data) return false
  return (data as { inventory_sync_enabled: boolean }).inventory_sync_enabled === true
}
