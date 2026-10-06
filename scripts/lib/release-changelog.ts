/**
 * Changelog helpers extracted from prepare-release.ts (SMI-4783).
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { isReleaseBumpSubject } from './release-bump-subject.mjs'
import { ROOT_DIR } from './version-utils.js'

/** How far back the boundary search looks. */
export const BOUNDARY_SEARCH_DEPTH = 50

/**
 * SMI-7012: the result of looking for the previous release commit.
 *
 * Discriminated on purpose. The previous signature returned a bare string and
 * yielded the literal `'HEAD~20'` from BOTH the not-found path and the `catch`,
 * so "I could not establish the boundary" was indistinguishable from "the
 * boundary is twenty commits back" — and the caller then generated a changelog
 * over an arbitrary window with full confidence. ADR-177 § 5 forbids that
 * conflation: "could not inspect" is never "inspected and found nothing".
 */
export type ReleaseBoundary =
  | { readonly ok: true; readonly hash: string }
  | {
      readonly ok: false
      readonly reason: 'no-match-in-window' | 'git-failed'
      readonly detail: string
    }

/**
 * Find the commit that the previous release bump landed on.
 *
 * Returns a failure rather than a guess. The caller must refuse **before any
 * write** — see `prepare-release.ts`, where the resolution happens ahead of
 * Step 5 precisely so a failure here cannot leave a half-written release on
 * disk.
 *
 * Subject matching is a weaker signal than a published tag, which is what
 * ADR-177 § 4 records as authoritative and what `check-source-version-drift.mjs`
 * already prefers. Moving this to tags is tracked separately; it was out of
 * scope for SMI-7012's dated fix.
 */
export function findLastVersionBumpCommit(): ReleaseBoundary {
  let output: string
  try {
    output = execFileSync(
      'git',
      ['log', '--oneline', '--format=%H %s', `-${BOUNDARY_SEARCH_DEPTH}`],
      {
        cwd: ROOT_DIR,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim()
  } catch (err) {
    return {
      ok: false,
      reason: 'git-failed',
      detail: `git log failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    }
  }

  for (const line of output.split('\n')) {
    const [hash, ...rest] = line.split(' ')
    if (isReleaseBumpSubject(rest.join(' '))) {
      return { ok: true, hash }
    }
  }

  return {
    ok: false,
    reason: 'no-match-in-window',
    detail: `no release-bump commit found in the last ${BOUNDARY_SEARCH_DEPTH} commits`,
  }
}

/**
 * Extract identity tokens from a single changelog entry line.
 *
 * SMI-4928: tokens are used to decide whether a carried-forward `[Unreleased]`
 * entry already covers an auto-generated terse entry (so the terse one can be
 * suppressed). Tokens are every `SMI-\d+` reference and every `(#\d+)` PR-ref
 * in the line. A line with no recognizable token returns `[]` — the caller
 * fails safe by keeping such auto-generated lines.
 *
 * @param line A changelog entry line (typically starting with `- `).
 * @returns The list of identity tokens found (uppercased SMI refs + `#NN`).
 */
export function extractChangeTokens(line: string): string[] {
  const tokens: string[] = []
  for (const m of line.matchAll(/SMI-\d+/gi)) {
    tokens.push(m[0].toUpperCase())
  }
  for (const m of line.matchAll(/\(#(\d+)\)/g)) {
    tokens.push(`#${m[1]}`)
  }
  return tokens
}

/**
 * Combine the auto-generated terse `## vX.Y.Z` section with the carried-forward
 * `[Unreleased]` entry lines, suppressing auto-generated entries that a carried
 * line already covers (SMI-4928). Caller guarantees `carried` is non-empty.
 *
 * @param trimmedSection Auto-generated section: `## v...` header then `- ` lines.
 * @param carried Trimmed carried-forward `[Unreleased]` entry block.
 * @returns The combined section body (header + kept auto lines + carried).
 */
function dedupeAutoSection(trimmedSection: string, carried: string): string {
  const sectionLines = trimmedSection.split('\n')
  // Header is everything up to (and excluding) the first `- ` entry line.
  const firstEntryIdx = sectionLines.findIndex((l) => l.startsWith('- '))
  if (firstEntryIdx === -1) {
    // No auto-generated entry lines — nothing to dedupe.
    return `${trimmedSection}\n\n${carried}`
  }
  const headerLines = sectionLines.slice(0, firstEntryIdx)
  const autoEntryLines = sectionLines.slice(firstEntryIdx).filter((l) => l.startsWith('- '))

  // Union token set of every carried entry line.
  const carriedTokens = new Set<string>()
  for (const line of carried.split('\n')) {
    if (!line.startsWith('- ')) continue
    for (const token of extractChangeTokens(line)) {
      carriedTokens.add(token)
    }
  }

  // Drop an auto-generated entry IFF its tokens intersect the carried set.
  // Keep entries with no recognizable token (cannot prove duplicate).
  const keptAutoLines = autoEntryLines.filter((line) => {
    const tokens = extractChangeTokens(line)
    if (tokens.length === 0) return true
    return !tokens.some((t) => carriedTokens.has(t))
  })

  const header = headerLines.join('\n')
  // SMI-5057: join kept-auto and carried with a single newline. The
  // previous `\n\n${carried}` inserted a spurious blank line between
  // bullets of the same version section (e.g. PR #1268 cli/mcp-server
  // CHANGELOGs had a blank line between drained SMI-5008 and carried
  // SMI-5006 entries). The `\n{3,}` cleanup is preserved because the
  // empty-keptAutoLines path still produces `\n\n` between header and
  // carried, which is correct.
  //
  // Caller precondition: dedupeAutoSection is only invoked when
  // carried.length > 0 (release-changelog.ts:172). No need to guard
  // against an empty carried producing a trailing newline.
  return `${header}\n${keptAutoLines.join('\n')}\n${carried}`.replace(/\n{3,}/g, '\n\n')
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

  // Carry forward any entry lines that were sitting under [Unreleased].
  //
  // SMI-4928: when a merged PR already wrote a detailed `[Unreleased]` entry
  // for a change, the auto-generated terse section also contains a terse entry
  // for the same change — producing two lines for one change in the new
  // version section. Token-based dedupe (below) suppresses the auto-generated
  // terse line when a carried line already covers it by identity token
  // (`SMI-\d+` / `(#\d+)`). Auto-generated lines with no recognizable token are
  // kept (fail safe — cannot prove a duplicate). When `carried` is empty no
  // token logic runs and the output is byte-identical to the pre-SMI-4928
  // behaviour.
  const carried = unreleasedBody.trim()
  const sectionWithCarry =
    carried.length > 0 ? dedupeAutoSection(trimmedSection, carried) : trimmedSection

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
