/**
 * README "What's New" sync, extracted from prepare-release.ts (SMI-5663 Wave 1)
 * to keep the orchestrator under the 500-line file-length budget, matching the
 * SMI-4783 release-collision/release-changelog/release-git split.
 *
 * `scripts/prepare-release.ts` bumps each package's package.json version but
 * historically never touched the corresponding packages/*\/README.md's
 * "## What's New in vX.Y.Z" heading — Check 60 (SMI-5613,
 * scripts/audit-standards.mjs) compares that heading against package.json and
 * fails the release-cadence PR on drift. This module closes that gap by
 * reusing the checker's own read-side parser (`extractWhatsNewVersion`) and a
 * paired write-side helper (`updateWhatsNewVersion`), both defined in
 * scripts/audit-readme-whats-new-helpers.mjs, so the writer and the checker
 * structurally cannot drift apart again.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { ROOT_DIR } from './version-utils.js'
import { type BumpPlan } from './release-collision.js'
import { hasWhatsNewHeading, updateWhatsNewVersion } from '../audit-readme-whats-new-helpers.mjs'

/**
 * Syncs each bumped package's README "What's New" heading (and TOC anchor, if
 * present) to its new version and writes the file to disk. Returns the
 * repo-relative paths of every README actually modified, so the caller can
 * stage them into the release commit alongside package.json — writing them to
 * disk without staging leaves Check 60 failing on the resulting PR exactly as
 * before this fix (the single most load-bearing correction from the
 * GPT-5.6-Sol plan review, SMI-5663).
 *
 * Per package:
 *   - No README.md at all -> skipped (nothing to sync).
 *   - README exists but has no "## What's New" heading at all -> skipped
 *     silently. This mirrors Check 60's own asymmetric skip (most packages —
 *     enterprise, vscode-extension, website, doc-retrieval-mcp — legitimately
 *     have no such section).
 *   - README has a "## What's New" heading but `updateWhatsNewVersion` can't
 *     resolve it to exactly one parseable "## What's New in vX.Y.Z" match
 *     (missing version suffix, or more than one heading) -> throws. Fails the
 *     whole release-prep run rather than silently shipping a still-stale
 *     README that Check 60 will catch anyway, later, with less context.
 */
export function syncReadmeWhatsNew(plans: BumpPlan[]): { updated: string[] } {
  const updated: string[] = []

  for (const plan of plans) {
    const relPath = join(plan.spec.dir, 'README.md')
    const fullPath = join(ROOT_DIR, relPath)
    if (!existsSync(fullPath)) continue

    const content = readFileSync(fullPath, 'utf-8')
    if (!hasWhatsNewHeading(content)) continue

    // Fail closed (not caught here) if the heading exists but is missing or
    // ambiguous — see updateWhatsNewVersion's own doc comment.
    const nextContent = updateWhatsNewVersion(content, plan.newVersion)
    writeFileSync(fullPath, nextContent)
    updated.push(relPath)
  }

  return { updated }
}
