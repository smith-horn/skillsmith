/**
 * telemetry-body.ts
 *
 * SMI-5394: Pure body-parse helper for the /api/account/telemetry PUT route.
 * Extracted so the "optional boolean or omit" contract can be unit-tested
 * without wiring up a full API request.
 *
 * The route calls this after reading the existing row so the fallback can be
 * seeded from the stored value — preserving the intent of "omit = keep as-is".
 */

/**
 * Parse `inventory_sync_enabled` from an untrusted PUT body field.
 *
 * - Field absent (`undefined`) → use `fallback` (read-modify-write semantics).
 * - Field present and `boolean` → use that value.
 * - Field present and NOT a `boolean` → return an error string.
 */
export function parseInventorySyncEnabled(
  value: unknown,
  fallback: boolean
): { value: boolean; error: null } | { value: null; error: string } {
  if (value === undefined) {
    return { value: fallback, error: null }
  }
  if (typeof value === 'boolean') {
    return { value, error: null }
  }
  return { value: null, error: 'invalid_inventory_sync_enabled' }
}

/** Existing-row columns the PUT route reads to preserve on a partial update. */
export interface ExistingTelemetryRow {
  anonymous_id: string | null
  anonymous_id_created_at: string | null
  inventory_sync_enabled: boolean
}

/** The row upserted into user_telemetry_preferences. */
export interface TelemetryUpsertRow {
  user_id: string
  enabled: boolean
  anonymous_id: string | null
  anonymous_id_created_at: string | null
  updated_at: string
  inventory_sync_enabled: boolean
}

/**
 * Build the upsert row, preserving anonymous_id + its creation timestamp across
 * a partial PUT: a newly-supplied (changed) anonymous_id gets `now` as its
 * created_at; an unchanged or omitted id retains the stored timestamp. `enabled`
 * and `inventorySyncEnabled` (already resolved via parseInventorySyncEnabled)
 * pass straight through. Pure, so the preserve/clobber matrix is unit-testable.
 */
export function buildTelemetryUpsertRow(params: {
  userId: string
  enabled: boolean
  anonymousId: string | null
  inventorySyncEnabled: boolean
  existing: ExistingTelemetryRow | null | undefined
  now: string
}): TelemetryUpsertRow {
  const { userId, enabled, anonymousId, inventorySyncEnabled, existing, now } = params
  const anonymousIdChanged = anonymousId !== null && existing?.anonymous_id !== anonymousId
  const anonymousIdCreatedAt = anonymousIdChanged
    ? now
    : (existing?.anonymous_id_created_at ?? (anonymousId !== null ? now : null))
  return {
    user_id: userId,
    enabled,
    anonymous_id: anonymousId ?? existing?.anonymous_id ?? null,
    anonymous_id_created_at: anonymousIdCreatedAt,
    updated_at: now,
    inventory_sync_enabled: inventorySyncEnabled,
  }
}
