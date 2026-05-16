/**
 * Changelog helpers extracted from prepare-release.ts (SMI-4783).
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { ROOT_DIR } from './version-utils.js'

export function findLastVersionBumpCommit(): string {
  try {
    const output = execFileSync('git', ['log', '--oneline', '--format=%H %s', '-50'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    for (const line of output.split('\n')) {
      const [hash, ...rest] = line.split(' ')
      const msg = rest.join(' ')
      if (
        msg.startsWith('chore(release):') ||
        msg.startsWith('chore: bump version') ||
        /^chore:.*bump.*\d+\.\d+\.\d+/.test(msg)
      ) {
        return hash
      }
    }
    return 'HEAD~20'
  } catch {
    return 'HEAD~20'
  }
}

/**
 * Insert a new `## vX.Y.Z` section into a CHANGELOG body.
 *
 * SMI-4920 (Bug A): the previous implementation spliced the new section before
 * the FIRST `## ` heading. When the file led with `## [Unreleased]` (the normal
 * case), the result was `## vX.Y.Z` ABOVE `## [Unreleased]`, which trips
 * `audit:standards` check 43 (Unreleased-before-versions ordering) and fails CI
 * on the release PR's first push.
 *
 * New behaviour:
 *  - If the first `## ` heading is `## [Unreleased]`: keep it on top (empty),
 *    move any entry lines currently under it into the new version section, and
 *    insert the new section directly after the (now empty) Unreleased block.
 *  - If there is no `## [Unreleased]` heading: emit an empty `## [Unreleased]`
 *    first, then the new version section, then the rest.
 *
 * Output is always conforming to check 43.
 *
 * @param body Raw CHANGELOG.md contents (or the synthesized default header).
 * @param section The new `## vX.Y.Z ...` section, header line first, no
 *   trailing newline required.
 * @returns The rewritten CHANGELOG body.
 */
export function insertVersionSection(body: string, section: string): string {
  const trimmedSection = section.trim()
  const firstHeading = body.indexOf('\n## ')

  // No `## ` heading at all — append Unreleased + section after the header.
  if (firstHeading === -1) {
    return `${body.trimEnd()}\n\n## [Unreleased]\n\n${trimmedSection}\n`
  }

  const before = body.slice(0, firstHeading + 1) // includes trailing newline
  const rest = body.slice(firstHeading + 1)

  // Locate the first heading line and test whether it is `## [Unreleased]`.
  const firstLineEnd = rest.indexOf('\n')
  const firstLine = (firstLineEnd === -1 ? rest : rest.slice(0, firstLineEnd)).trim()
  const isUnreleased = /^## \[?Unreleased\]?$/i.test(firstLine)

  if (!isUnreleased) {
    // No leading Unreleased block — synthesize an empty one, then the section.
    return `${before}## [Unreleased]\n\n${trimmedSection}\n\n${rest.trimEnd()}\n`
  }

  // Leading `## [Unreleased]` block: find where it ends (next `## ` heading).
  const afterFirstHeading = firstLineEnd === -1 ? '' : rest.slice(firstLineEnd + 1)
  const nextHeading = afterFirstHeading.indexOf('\n## ')

  let unreleasedBody: string
  let tail: string
  if (nextHeading === -1) {
    unreleasedBody = afterFirstHeading
    tail = ''
  } else {
    unreleasedBody = afterFirstHeading.slice(0, nextHeading)
    tail = afterFirstHeading.slice(nextHeading + 1) // strip the leading newline
  }

  // Carry forward any entry lines that were sitting under [Unreleased] (raw
  // append; dedupe is intentionally out of scope per SMI-4920).
  const carried = unreleasedBody.trim()
  const sectionWithCarry = carried.length > 0 ? `${trimmedSection}\n\n${carried}` : trimmedSection

  const tailBlock = tail.trim().length > 0 ? `\n\n${tail.trimEnd()}` : ''
  return `${before}## [Unreleased]\n\n${sectionWithCarry}${tailBlock}\n`
}

export function prependToChangelog(relPath: string, section: string): void {
  const fullPath = join(ROOT_DIR, relPath)
  let content: string
  if (existsSync(fullPath)) {
    content = readFileSync(fullPath, 'utf-8')
  } else {
    content = `# Changelog\n\nAll notable changes to this package are documented here.\n`
  }

  writeFileSync(fullPath, insertVersionSection(content, section))
}
