/**
 * Helper for Check 60 (README "What's New" Currency, SMI-5613).
 * Extracted for unit testability, matching the audit-mcp-tool-count-helpers.mjs
 * precedent (Check 25).
 */

/**
 * Extracts the version from a README's "## What's New in vX.Y.Z" heading.
 * Tolerates a missing leading "v". Returns null if no such heading is found.
 *
 * @param {string} readmeContent
 * @returns {string | null}
 */
export function extractWhatsNewVersion(readmeContent) {
  const match = readmeContent.match(/^## What's New in v?(\d+\.\d+\.\d+)/m)
  return match ? match[1] : null
}

/**
 * Matches a "## What's New in vX.Y.Z" heading, capturing the version, with
 * the `g` flag so callers can detect ambiguity (more than one match) — unlike
 * `extractWhatsNewVersion`'s non-global regex, which silently returns only
 * the first match.
 */
const WHATS_NEW_HEADING_RE = /^## What's New in v?(\d+\.\d+\.\d+)$/gm

/**
 * Loose detector for "this README has a What's New section at all", regardless
 * of whether the version suffix parses. Used by callers to distinguish "no
 * What's New section — not our concern" (most packages) from "has one but it's
 * malformed" (should fail closed, not be silently skipped).
 */
const LOOSE_WHATS_NEW_HEADING_RE = /^## What's New\b/m

/**
 * @param {string} readmeContent
 * @returns {boolean}
 */
export function hasWhatsNewHeading(readmeContent) {
  return LOOSE_WHATS_NEW_HEADING_RE.test(readmeContent)
}

/**
 * Reproduces GitHub's Markdown heading-to-anchor slug algorithm closely enough
 * for this file's own headings: lowercase, strip characters that aren't a
 * word character/space/hyphen (drops apostrophes and periods entirely, not
 * replaced with a hyphen), then hyphenate whitespace. Verified against the
 * real anchors this repo's READMEs currently use — "What's New in v0.11.4" ->
 * "whats-new-in-v0114" (packages/core/README.md) and "What's New in v0.8.4" ->
 * "whats-new-in-v084" (packages/cli/README.md).
 *
 * @param {string} headingText
 * @returns {string}
 */
export function githubHeadingSlug(headingText) {
  return headingText
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * Write-side counterpart to `extractWhatsNewVersion` (SMI-5663 Wave 1). Updates
 * a README's "## What's New in vX.Y.Z" heading — and any table-of-contents
 * anchor link referencing it (e.g. `[What's New](#whats-new-in-v0114)`) — to
 * `newVersion`, so `prepare-release.ts` and Check 60 (SMI-5613) structurally
 * cannot drift apart again.
 *
 * Fails closed: throws if the heading is missing entirely, or matches more
 * than once (ambiguous), rather than silently updating the first occurrence
 * or leaving the file untouched. Callers that need to distinguish "this
 * package legitimately has no What's New section at all" (skip) from "it has
 * one but this function can't safely update it" (fail closed) should check
 * `hasWhatsNewHeading()` first — most packages fall in the former bucket.
 *
 * @param {string} readmeContent
 * @param {string} newVersion - e.g. "0.11.5"
 * @returns {string} updated README content
 */
export function updateWhatsNewVersion(readmeContent, newVersion) {
  const headingMatches = [...readmeContent.matchAll(WHATS_NEW_HEADING_RE)]

  if (headingMatches.length === 0) {
    throw new Error(
      'updateWhatsNewVersion: no "## What\'s New in vX.Y.Z" heading found — cannot sync version'
    )
  }
  if (headingMatches.length > 1) {
    throw new Error(
      `updateWhatsNewVersion: ambiguous — found ${headingMatches.length} "## What's New in vX.Y.Z" headings, expected exactly 1`
    )
  }

  const [oldHeadingLine] = headingMatches[0]
  const newHeadingText = `What's New in v${newVersion}`
  let updated = readmeContent.replace(oldHeadingLine, `## ${newHeadingText}`)

  // Update a matching TOC anchor link, if one exists — e.g.
  // "- [What's New](#whats-new-in-v0114)". Not every README with a What's New
  // heading has a "## Contents" TOC (packages/mcp-server/README.md doesn't),
  // so this is best-effort: only rewrite the anchor when the OLD slug is
  // actually referenced somewhere in the file.
  //
  // Code-review correction (SMI-5663): derive the old slug from the ACTUAL
  // matched heading text, not by reconstructing it with a hardcoded "v" —
  // `extractWhatsNewVersion`/this regex both tolerate a heading without the
  // leading "v" (e.g. "## What's New in 1.2.3"), and reconstructing with a
  // hardcoded "v" would compute the wrong old slug for that case, silently
  // leaving a stale TOC link behind.
  const oldHeadingText = oldHeadingLine.replace(/^## /, '')
  const oldSlug = githubHeadingSlug(oldHeadingText)
  const newSlug = githubHeadingSlug(newHeadingText)
  if (oldSlug !== newSlug) {
    const tocLinkRe = new RegExp(`(\\(#)${oldSlug}(\\))`, 'g')
    updated = updated.replace(tocLinkRe, `$1${newSlug}$2`)
  }

  return updated
}
