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
