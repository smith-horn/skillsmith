/**
 * SMI-5897 (C-18/C-19, Wave 4 fix): Shared "quiet mode" detection for
 * fallback/degraded-mode warnings.
 *
 * Extracted from `embeddings/probe.ts`'s original inline `envQuiet()` helper
 * so the boot-time capability probe (`embeddings/probe.ts`), `EmbeddingService`'s
 * own model-load-failure warning (`embeddings/index.ts`), and
 * `db/createDatabase.ts`'s WASM-driver fallback notice all honor the
 * `SKILLSMITH_QUIET` env var identically.
 *
 * Lives in `utils/` (not `embeddings/`) specifically because it moved a
 * second time in Wave 4: `db/createDatabase.ts`'s WASM-fallback `console.warn`
 * needed the same guard, and a db-layer file reaching into an unrelated
 * embeddings-layer directory for a generic env-var check would be a layering
 * smell. `utils/` already hosts other small shared utilities (`retry.ts`,
 * `rate-limit.ts`) with no dependents of their own, so importing from any
 * layer (db, embeddings) creates no cycle.
 */

/** Detect `SKILLSMITH_QUIET` env var (case-insensitive truthy match). */
export function isQuietModeEnabled(): boolean {
  const v = process.env.SKILLSMITH_QUIET
  if (v == null) return false
  return v.toLowerCase() === 'true' || v === '1'
}
