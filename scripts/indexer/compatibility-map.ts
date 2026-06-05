/**
 * skill_path → compatibility-slug derivation (SMI-5177, Phase 2a).
 * @module scripts/indexer/compatibility-map
 *
 * Single source of truth for the `skills.compatibility` JSONB column, used by BOTH
 * producers: the indexer forward-populate (`skill-processor.ts`) calls
 * `deriveCompatibility`, and the migration backfill embeds `compatibilityCaseSql()`.
 * Generating the SQL from the same matrix makes the two impossible to drift
 * (`compatibility-map.test.ts` snapshots the migration against the generator).
 *
 * Matrix authority: docs/internal/research/cross-ecosystem-skill-index-expansion.md §A.
 *
 * Matching rule: a path maps only when a convention appears as a leading
 * segment-exact prefix (`p === conv || p.startsWith(conv + '/')`). This keeps
 * `.agent/skills` (Antigravity) distinct from `.agents/skills` (cross-tool), and
 * treats nested plugin paths (e.g. `.github/plugins/.../skills/...`) and generic
 * `skills/*` / `plugins/*` / bare names / root as unscoped. An empty result means
 * "unknown / unscoped" — NOT "incompatible".
 */

/** Convention dir (segment-exact prefix) → compatible client/framework slugs. */
export const COMPATIBILITY_MATRIX: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['.claude/skills', ['claude-code']],
  ['.agents/skills', ['windsurf', 'antigravity', 'codex']], // cross-tool standard
  ['.github/skills', ['copilot']],
  ['.agent/skills', ['antigravity']], // Antigravity project-local (singular)
  ['.codex/skills', ['codex']],
  ['.cursor/skills', ['cursor']],
  ['.gemini/skills', ['gemini']],
  ['.windsurf/skills', ['windsurf']],
  // `.ai/skills` is intentionally absent — neutral/unscoped → falls through to [].
]

/**
 * Derive the compatibility slug array for a skill's `skill_path`.
 * Returns a fresh array (callers may mutate). Unknown/empty → `[]` (unscoped).
 */
export function deriveCompatibility(skillPath: string): string[] {
  const path = (skillPath ?? '').trim()
  if (path === '') return []
  for (const [conv, slugs] of COMPATIBILITY_MATRIX) {
    if (path === conv || path.startsWith(conv + '/')) {
      return [...slugs]
    }
  }
  return []
}

/**
 * Generate the SQL `CASE` expression for the migration backfill, derived from
 * `COMPATIBILITY_MATRIX` so the backfill and `deriveCompatibility` cannot diverge.
 * The convention strings contain no LIKE wildcards (`_`/`%`); single quotes are
 * escaped defensively. Mirrors the TS rule: `= conv OR LIKE conv/%`.
 */
export function compatibilityCaseSql(column = 'skill_path'): string {
  const arms = COMPATIBILITY_MATRIX.map(([conv, slugs]) => {
    const c = conv.replace(/'/g, "''")
    const json = JSON.stringify(slugs)
    return `    WHEN ${column} = '${c}' OR ${column} LIKE '${c}/%' THEN '${json}'::jsonb`
  })
  return `CASE\n${arms.join('\n')}\n    ELSE '[]'::jsonb\n  END`
}
