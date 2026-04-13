/**
 * @fileoverview Generic trigger-word + namespace detection helpers for
 * `skill_pack_audit`.
 * @module @skillsmith/mcp-server/tools/skill-pack-audit.helpers
 * @see SMI-4124
 *
 * Pure functions — no I/O, no database access. Tested via
 * `tests/unit/skill-pack-audit.test.ts`.
 */

import type { GenericTriggersStoplist } from '@skillsmith/core'
import { FIELD_LIMITS } from './validate.types.js'
import type { GenericWordFlag, NamespaceFlag } from './skill-pack-audit.types.js'

/**
 * Coerce a description value into a plain string. `parseYamlFrontmatter` returns
 * block-scalar (`description: |`) values as `string[]`, so we join with spaces.
 * Non-string/non-string-array values yield an empty string.
 */
function coerceDescription(description: unknown): string {
  if (typeof description === 'string') return description
  if (Array.isArray(description)) {
    return description.filter((item): item is string => typeof item === 'string').join(' ')
  }
  return ''
}

/** Split cleaned description text into lowercase word tokens. */
function tokenizeForTriggers(text: string): string[] {
  // Clamp to the same limit `validate` enforces to prevent quadratic scans
  // on malicious oversized frontmatter.
  const clamped = text.slice(0, FIELD_LIMITS.description)
  // Strip common punctuation / markdown, collapse whitespace.
  return clamped
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/**
 * Detect generic trigger words in a skill's name and description.
 *
 * - Skill-name hits produce `severity: 'error'` (unconditional false-trigger magnet).
 * - Description hits produce `severity: 'warning'`.
 * - `suggested` is `${packDomain}-${token}` when a pack domain is available,
 *   otherwise `null`.
 *
 * @param description - Raw description value from frontmatter (may be string
 *                      or string[] from block-scalar parsing, or other).
 * @param skillName   - Skill's `name` frontmatter value (falls back to dir name).
 * @param packDomain  - Inferred pack domain, or `null` when indeterminate.
 * @param stoplist    - Curated stoplist from `@skillsmith/core`.
 * @returns Flags (name errors first, then description warnings).
 */
export function detectGenericTriggerWords(
  description: unknown,
  skillName: string,
  packDomain: string | null,
  stoplist: GenericTriggersStoplist
): GenericWordFlag[] {
  const flags: GenericWordFlag[] = []
  const triggerSet = new Set(stoplist.triggerWords.map((w) => w.toLowerCase()))

  // Name check (error): tokenize on non-alphanumerics so "spec-builder" flags both.
  const nameTokens = new Set(
    skillName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0)
  )
  for (const token of nameTokens) {
    if (triggerSet.has(token)) {
      flags.push({
        token,
        location: 'name',
        severity: 'error',
        suggested: packDomain ? `${packDomain}-${token}` : null,
        reason:
          `Skill name contains generic trigger word "${token}". ` +
          `This causes Claude's skill-trigger heuristic to misfire on unrelated prompts. ` +
          (packDomain
            ? `Rename to "${packDomain}-${token}" to qualify the scope.`
            : `Qualify with a domain prefix (e.g. "planning-${token}").`),
      })
    }
  }

  // Description check (warning): full-text tokenization.
  const descText = coerceDescription(description)
  if (descText.length > 0) {
    const descTokens = tokenizeForTriggers(descText)
    const seen = new Set<string>()
    for (const token of descTokens) {
      if (seen.has(token)) continue
      if (nameTokens.has(token)) continue // already flagged as name error
      if (triggerSet.has(token)) {
        seen.add(token)
        flags.push({
          token,
          location: 'description',
          severity: 'warning',
          suggested: packDomain ? `${packDomain}-${token}` : null,
          reason:
            `Description contains generic trigger word "${token}". ` +
            `Consider rewording or qualifying the skill's activation phrasing to ` +
            `avoid false-positive skill triggers.`,
        })
      }
    }
  }

  return flags
}

/**
 * Aggregate per-skill `tags` across a pack to derive a pack domain.
 *
 * Priority:
 * 1. If `packName` ends with `-skills` and is not itself generic, strip the
 *    suffix and return the prefix (e.g. `planning-skills` → `planning`).
 * 2. Otherwise, compute the mode of non-generic tags across all skills.
 * 3. Returns `null` when no domain can be inferred with confidence.
 *
 * @param packName  - Pack directory name.
 * @param allSkills - Per-skill tag arrays (undefined / non-array → ignored).
 * @param stoplist  - Curated stoplist (for generic-tag filtering).
 */
export function derivePackDomain(
  packName: string,
  allSkills: Array<{ tags?: unknown }>,
  stoplist: GenericTriggersStoplist
): string | null {
  const genericNamespaces = new Set(stoplist.namespaces.map((n) => n.toLowerCase()))
  const genericWords = new Set(stoplist.triggerWords.map((w) => w.toLowerCase()))

  // Strategy 1: strip `-skills` suffix from non-generic pack name.
  const lowerPack = packName.toLowerCase()
  if (lowerPack.endsWith('-skills') && !genericNamespaces.has(lowerPack)) {
    const prefix = lowerPack.slice(0, -'-skills'.length)
    if (prefix.length > 0 && !genericNamespaces.has(prefix) && !genericWords.has(prefix)) {
      return prefix
    }
  }

  // Strategy 2: mode of per-skill tags.
  const counts = new Map<string, number>()
  for (const skill of allSkills) {
    if (!Array.isArray(skill.tags)) continue
    for (const raw of skill.tags) {
      if (typeof raw !== 'string') continue
      const tag = raw.toLowerCase().trim()
      if (tag.length === 0) continue
      if (genericNamespaces.has(tag) || genericWords.has(tag)) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  if (counts.size === 0) return null

  let bestTag: string | null = null
  let bestCount = 0
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      bestTag = tag
      bestCount = count
    }
  }

  // Require the mode to cover at least 2 skills (or the only skill) to avoid
  // picking random one-offs.
  const minSkills = allSkills.length >= 2 ? 2 : 1
  return bestCount >= minSkills ? bestTag : null
}

/**
 * Detect a generic pack namespace.
 *
 * @returns NamespaceFlag when the pack name matches a generic namespace,
 *          otherwise null.
 */
export function detectGenericNamespace(
  packName: string,
  allSkills: Array<{ tags?: unknown }>,
  stoplist: GenericTriggersStoplist
): NamespaceFlag | null {
  const lowerPack = packName.toLowerCase()
  const genericNamespaces = new Set(stoplist.namespaces.map((n) => n.toLowerCase()))

  if (!genericNamespaces.has(lowerPack)) return null

  const domain = derivePackDomain(packName, allSkills, stoplist)
  const suggested = domain ? `${domain}-skills` : null
  const reason = suggested
    ? `Pack name "${packName}" is a generic namespace. Rename to "${suggested}" ` +
      `to reflect its domain (inferred from per-skill tags).`
    : `Pack name "${packName}" is a generic namespace and per-skill tags do not ` +
      `converge on a clear domain. Rename to "<domain>-skills" where <domain> is ` +
      `a specific scope (e.g. "planning-skills", "cicd-skills").`

  return {
    packName,
    severity: 'warning',
    suggested,
    reason,
  }
}
