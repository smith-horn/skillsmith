/**
 * @fileoverview Type definitions for the trigger-quality + namespace extension
 * of the `skill_pack_audit` tool.
 * @module @skillsmith/mcp-server/tools/skill-pack-audit.types
 * @see SMI-4124
 */

/**
 * A single generic-word flag on a skill's name or description.
 */
export interface GenericWordFlag {
  /** The flagged token (lowercased). */
  token: string
  /** Where the flag was detected. */
  location: 'name' | 'description'
  /**
   * Severity:
   * - `error` for skill-name hits (unconditional false-trigger magnet).
   * - `warning` for description-only hits.
   */
  severity: 'error' | 'warning'
  /**
   * Suggested rename of the form `${packDomain}-${token}`, or `null` when
   * the pack domain cannot be inferred.
   */
  suggested: string | null
  /** Human-readable explanation of why the token was flagged. */
  reason: string
}

/**
 * A single generic-namespace flag on the pack itself.
 */
export interface NamespaceFlag {
  /** The flagged pack name (directory name). */
  packName: string
  /** Always `warning` — namespace is author-level guidance, not a hard error. */
  severity: 'warning'
  /**
   * Suggested rename of the form `${derivedDomain}-skills`, or `null` when
   * the domain cannot be inferred from per-skill tags.
   */
  suggested: string | null
  /** Human-readable explanation. */
  reason: string
}

/**
 * Per-skill trigger-quality entry. `id` matches `PackSkillEntry.name`
 * within the same response (the skill's frontmatter `name`, falling back to
 * the directory name).
 */
export interface TriggerQualityEntry {
  /** Skill identifier (matches PackSkillEntry.name). */
  id: string
  /** Generic-word flags detected on this skill. */
  flags: GenericWordFlag[]
}

/**
 * Aggregate trigger-quality result across the whole pack.
 * Always present in responses when the check ran (even if empty).
 */
export interface TriggerQuality {
  /** Per-skill flag entries. Empty array = clean pack. */
  skills: TriggerQualityEntry[]
  /** Roll-up counters. */
  summary: {
    totalFlags: number
    errorCount: number
    warningCount: number
  }
}
