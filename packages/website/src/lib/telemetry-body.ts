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

/**
 * Parse `audit_email_enabled` from an untrusted PUT body field.
 *
 * SMI-5540: dedicated, opt-in (default-off) consent for the continuous-audit
 * email — NEVER derived from or conflated with `enabled` (the unrelated
 * skill-invocation telemetry flag). Same "omit = keep as-is" contract as
 * `parseInventorySyncEnabled`.
 *
 * - Field absent (`undefined`) → use `fallback` (read-modify-write semantics).
 * - Field present and `boolean` → use that value.
 * - Field present and NOT a `boolean` → return an error string.
 */
export function parseAuditEmailEnabled(
  value: unknown,
  fallback: boolean
): { value: boolean; error: null } | { value: null; error: string } {
  if (value === undefined) {
    return { value: fallback, error: null }
  }
  if (typeof value === 'boolean') {
    return { value, error: null }
  }
  return { value: null, error: 'invalid_audit_email_enabled' }
}

/** Existing-row columns the PUT route reads to preserve on a partial update. */
export interface ExistingTelemetryRow {
  anonymous_id: string | null
  anonymous_id_created_at: string | null
  inventory_sync_enabled: boolean
  audit_email_enabled: boolean
  /**
   * SMI-6362 §3a: the route's read-before-write select must also fetch this
   * column so `buildTelemetryUpsertRow` can apply first-decision-wins
   * semantics. `null`/`undefined` here means "never decided" (or "column
   * unavailable to the caller" for an existing test/type that predates this
   * field) — both are treated identically: stamp `now`.
   */
  consent_decided_at?: string | null
}

/** The row upserted into user_telemetry_preferences. */
export interface TelemetryUpsertRow {
  user_id: string
  enabled: boolean
  anonymous_id: string | null
  anonymous_id_created_at: string | null
  updated_at: string
  inventory_sync_enabled: boolean
  audit_email_enabled: boolean
  /**
   * SMI-6362 §3a (rev 4, round-3 item 2): stamped on EVERY explicit save,
   * regardless of `enabled`'s value — an opt-out is a decision too, and
   * only stamping on `enabled = true` would leave every dashboard opt-out
   * permanently re-promptable, the same defect in the opposite direction.
   * `resolve_telemetry_identity` (SMI-6362 migration) and this route are
   * the only two places that read/write this column's meaning; keep them
   * in sync if either changes.
   */
  consent_decided_at: string
}

/**
 * Build the upsert row, preserving anonymous_id + its creation timestamp across
 * a partial PUT: a newly-supplied (changed) anonymous_id gets `now` as its
 * created_at; an unchanged or omitted id retains the stored timestamp. `enabled`,
 * `inventorySyncEnabled`, and `auditEmailEnabled` (each already resolved via their
 * respective parse* helper) pass straight through. Pure, so the preserve/clobber
 * matrix is unit-testable.
 *
 * SMI-6362 §3a: `consent_decided_at` is set via COALESCE(existing, now)
 * semantics — first decision wins, a later save never re-stamps. This is
 * what "set exactly once per explicit save" in the column's comment was
 * always supposed to mean; re-stamping would silently reset the
 * audit-relevant timestamp of when consent was actually given. This route
 * (`api/account/telemetry.ts`'s PUT handler) is the only writer of this
 * column anywhere in `packages/` — every call here IS an explicit save, so
 * unlike `enabled`/`inventorySyncEnabled`/`auditEmailEnabled` there is no
 * "omitted field, keep existing" case to thread through: this function is
 * only ever reached via a real PUT.
 *
 * Known, accepted limitation (NEEDLE cross-provider confirmation round,
 * finding 2): the COALESCE happens in application memory, not as a
 * database-atomic operation -- this route's read-before-write + upsert are
 * two round-trips, not one transaction. Two genuinely concurrent FIRST-ever
 * saves for the same user (no existing row yet) could each read `existing
 * = null`, each compute their own `now`, and the later upsert's timestamp
 * wins. Not fixed here: doing so requires either a DB-level function/trigger
 * or an `ON CONFLICT DO UPDATE SET consent_decided_at =
 * COALESCE(user_telemetry_preferences.consent_decided_at, EXCLUDED.consent_decided_at)`
 * merge expression, which PostgREST's `.upsert()` client call does not
 * expose -- a real migration, not a route-level fix. Accepted because the
 * only reachable trigger is two near-simultaneous submits of the SAME
 * user's SAME explicit decision (a double-click or a client retry), so
 * both candidate timestamps are within milliseconds of the same real
 * consent event -- unlike the cross-session race this column exists to
 * prevent (an established decision being silently re-stamped by an
 * UNRELATED later save, which the COALESCE against a REAL existing row
 * value already prevents regardless of this narrower race).
 */
export function buildTelemetryUpsertRow(params: {
  userId: string
  enabled: boolean
  anonymousId: string | null
  inventorySyncEnabled: boolean
  auditEmailEnabled: boolean
  existing: ExistingTelemetryRow | null | undefined
  now: string
}): TelemetryUpsertRow {
  const { userId, enabled, anonymousId, inventorySyncEnabled, auditEmailEnabled, existing, now } =
    params
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
    audit_email_enabled: auditEmailEnabled,
    consent_decided_at: existing?.consent_decided_at ?? now,
  }
}
