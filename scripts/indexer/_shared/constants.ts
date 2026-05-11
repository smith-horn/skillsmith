/**
 * Shared constants (Node port)
 * @module scripts/indexer/_shared/constants
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/_shared/constants.ts`.
 * Pure constants — byte-identical to Deno parent.
 *
 * SMI-2273: Shared constants for indexer + edge functions.
 */

/**
 * Maximum allowed SKILL.md content size in bytes (1 MB).
 *
 * Prevents resource exhaustion from maliciously large files.
 * A legitimate SKILL.md should be well under 100KB.
 * The 1MB limit provides generous headroom while preventing abuse.
 */
export const MAX_SKILL_CONTENT_SIZE = 1_000_000
