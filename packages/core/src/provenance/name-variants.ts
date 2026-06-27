/**
 * @fileoverview Affix-tolerant skill-name matching for registry recovery.
 * @module @skillsmith/core/provenance/name-variants
 * @see SMI-5413
 *
 * Skills are commonly installed under a short local directory name (e.g.
 * `ci-doctor`) while their published registry name carries a convention affix
 * (`wrsmith108/claude-skill-ci-doctor`, `vercel-react-best-practices`). The
 * recovery's registry-name tier originally matched on the EXACT name, so it
 * missed these. {@link skillNameVariants} expands a name into the small,
 * bounded set of convention variants to query the registry by; callers keep the
 * existing review-only confidence gating (a single match is `medium`, multiple
 * are `low` + candidates) and a PREFER-EXACT rule (see callers) so a genuine
 * exact match is never downgraded to ambiguous by the broadened query.
 */

/** Convention prefixes stripped/added when normalizing a skill name. */
const PREFIXES = ['claude-skill-', 'claude-'] as const
/** Convention suffixes stripped/added when normalizing a skill name (longest first). */
const SUFFIXES = ['-claude-skill', '-skills', '-skill'] as const

/**
 * Strip a single known convention affix (prefix and/or suffix) to the bare
 * skill name. Lower-cased + trimmed. Never reduces the name to empty.
 */
export function normalizeSkillName(name: string): string {
  let n = name.toLowerCase().trim()
  for (const p of PREFIXES) {
    if (n.startsWith(p) && n.length > p.length) {
      n = n.slice(p.length)
      break
    }
  }
  for (const s of SUFFIXES) {
    if (n.endsWith(s) && n.length > s.length) {
      n = n.slice(0, -s.length)
      break
    }
  }
  return n
}

/**
 * Expand a skill name into the bounded set of convention variants to query the
 * registry by — the original name, its affix-stripped bare form, and the bare
 * form re-wrapped in each known prefix/suffix. Deduplicated; empties removed.
 *
 * Order is irrelevant: callers prefer an exact-name match over any variant,
 * and multi-candidate results stay review-only, so the broadened query only
 * ever SURFACES more candidates for review — it never auto-binds a generic
 * short name (e.g. `docker`) to an unrelated `docker-*` repo.
 */
export function skillNameVariants(name: string): string[] {
  const bare = normalizeSkillName(name)
  const out = new Set<string>([name, name.toLowerCase().trim(), bare])
  for (const p of PREFIXES) out.add(p + bare)
  for (const s of SUFFIXES) out.add(bare + s)
  return [...out].filter((v) => v.length > 0)
}
