/**
 * Linear issue description validation contract (SMI-5841, extracted SMI-5846).
 *
 * This is the canonical home for `validateIssueDescription` and its
 * constants. It is consumed by:
 *   - `scripts/lint-linear-issues.mjs` (SMI-5841) — scheduled CI backstop
 *     that queries Linear's API for recently-created issues and validates
 *     them after the fact.
 *   - `scripts/linear-issue-creation-guard.mjs` (SMI-5846) — client-side
 *     PreToolUse hook that validates a `mcp__linear__save_issue` create
 *     call's description before it reaches Linear.
 *
 * Extracted into this shared module so both consumers stay in sync by
 * construction rather than by hand — the exact "ported copy, kept in sync
 * by hand" risk this repo's own SMI-5841 plan doc flagged for its
 * relationship to the *external* CLI-path source
 * (`~/.claude/skills/linear/scripts/lib/issue-description.ts`) must not be
 * repeated internally, between two files this repo does own.
 *
 * Validation contract is PORTED from
 * `~/.claude/skills/linear/scripts/lib/issue-description.ts`'s
 * `validateIssueDescription()` — that file is not trackable from this
 * repo's CI (a personal, untracked package), so the rules below must be
 * kept in sync BY HAND if that source ever changes its contract. Ported
 * rules (all required to pass):
 *   1. Non-empty after trim.
 *   2. Body >= MIN_BODY_CHARS after stripping heading lines.
 *   3. Contains an "Acceptance Criteria" heading (H1-H6).
 *   4. >= MIN_AC_ITEMS non-placeholder bulleted items under that heading.
 */

export const MIN_BODY_CHARS = 120
export const MIN_AC_ITEMS = 2
export const AC_HEADING_RE = /^#{1,6}\s+Acceptance Criteria\b.*$/im
export const PLACEHOLDER_RE =
  /^\s*(TODO|FIXME|TBD|TBA|N\/A|XXX|\?+|<[^>]*>|\.\.\.|-{2,}|_{2,})\s*$/i

/**
 * Validate an issue description against the ported Acceptance Criteria
 * contract. Returns a list of error strings (empty = valid).
 *
 * @param {string | null | undefined} description
 * @returns {string[]}
 */
export function validateIssueDescription(description) {
  const errors = []
  const trimmed = (description ?? '').trim()

  if (trimmed.length === 0) {
    errors.push('Description is empty')
    return errors
  }

  const bodyChars = trimmed
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('\n').length
  if (bodyChars < MIN_BODY_CHARS) {
    errors.push(`Description body is ${bodyChars} chars; minimum is ${MIN_BODY_CHARS}`)
  }

  const acHeadingMatch = trimmed.match(AC_HEADING_RE)
  if (!acHeadingMatch) {
    errors.push('Acceptance Criteria heading missing')
  } else {
    const lines = trimmed.split(/\r?\n/)
    const headingIdx = lines.findIndex((l) => AC_HEADING_RE.test(l))
    const acItems = []
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^#{1,6}\s/.test(line)) break // next heading ends the section
      const bullet = line.match(/^\s*(?:-|\*)\s+(?:\[[ xX]\]\s+)?(.*)$/)
      if (!bullet) continue
      const body = bullet[1].trim()
      if (body.length === 0) continue
      if (PLACEHOLDER_RE.test(body)) continue
      acItems.push(body)
    }
    if (acItems.length < MIN_AC_ITEMS) {
      errors.push(
        `Fewer than ${MIN_AC_ITEMS} acceptance-criteria items found (got ${acItems.length})`
      )
    }
  }

  return errors
}
