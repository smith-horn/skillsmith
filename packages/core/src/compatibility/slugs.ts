/**
 * @fileoverview Canonical cross-ecosystem compatibility slug vocabulary (SMI-5178).
 *
 * Single source of truth for the compatibility slugs the indexer derives from
 * `skill_path` (see `scripts/indexer/compatibility-map.ts` `COMPATIBILITY_MATRIX`,
 * SMI-5177). Consumed by the MCP search restrictive default and (mirrored, with a
 * parity test) by the website badge renderer. Pure module — no runtime deps — so
 * it is safe to import anywhere without pulling the heavy `@skillsmith/core` graph.
 *
 * `[]` / absent compatibility = unknown / unscoped, NOT incompatible.
 */

/** Canonical filterable compatibility slugs (the union of `COMPATIBILITY_MATRIX` values). */
export const COMPATIBILITY_SLUGS = [
  'claude-code',
  'cursor',
  'copilot',
  'windsurf',
  'antigravity',
  'codex',
  'gemini',
] as const

export type CompatibilitySlug = (typeof COMPATIBILITY_SLUGS)[number]

/** Human-readable display labels for each slug (badge UI). */
export const COMPATIBILITY_LABELS: Record<CompatibilitySlug, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  codex: 'Codex',
  gemini: 'Gemini',
}

/**
 * Slugs that are filterable/browsable but have NO install target yet — the
 * install-client enum (`install/paths.ts` `ClientId`) lacks them.
 * `antigravity` was un-deferred (SMI-5982 Wave 6) — it now has a real
 * `ClientId` + `CLIENT_NATIVE_PATHS` entry, so it moved out of this list.
 * `gemini` has no install target (it names a model family, not a distinct
 * install client) and remains browse-only; adding it (if ever justified) is
 * still Phase 2c (SMI-5179). Until then the UI labels `gemini` "browse-only"
 * rather than implying installability.
 */
export const BROWSE_ONLY_SLUGS: readonly CompatibilitySlug[] = ['gemini']

/**
 * Map an install `ClientId` to the compatibility slug to restrict by when that
 * client is the user's explicit tool (MCP restrictive default, SMI-5178).
 * `agents` is the Codex / cross-tool `.agents/skills` client (`install/paths.ts`),
 * so it restricts by `codex` — rows at `.agents/skills` are tagged for codex
 * (and windsurf/antigravity) by the matrix, so they still surface.
 */
export const CLIENT_TO_COMPATIBILITY_SLUG: Record<string, CompatibilitySlug> = {
  'claude-code': 'claude-code',
  cursor: 'cursor',
  copilot: 'copilot',
  windsurf: 'windsurf',
  agents: 'codex',
  // SMI-5982 Wave 6: antigravity is now a real ClientId with its own 1:1
  // compatibility slug (same pattern as claude-code/cursor/copilot/windsurf).
  antigravity: 'antigravity',
}

/** Display label for a slug; falls back to the raw slug for unknown values. */
export function compatibilityLabel(slug: string): string {
  return (COMPATIBILITY_LABELS as Record<string, string>)[slug] ?? slug
}
