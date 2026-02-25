/**
 * @fileoverview Heuristic change classifier for skill content diffs
 * @module @skillsmith/core/versioning/change-classifier
 * @see SMI-skill-version-tracking Wave 2
 *
 * Compares old and new SKILL.md content to produce a semantic change type:
 *   'major'   — structural regression (headings removed, large risk delta)
 *   'minor'   — new structure added (headings added only, dep added)
 *   'patch'   — body edits with no structural changes
 *   'unknown' — could not classify
 *
 * When the author provides a semver field in SKILL.md frontmatter the
 * caller should pass that through; this module trusts the semver bump
 * over heuristics when it is present and parseable.
 */

// ============================================================================
// Types
// ============================================================================

export type ChangeType = 'major' | 'minor' | 'patch' | 'unknown'

// ============================================================================
// Frontmatter parsing
// ============================================================================

/** Very thin YAML-style frontmatter reader — only extracts key: value pairs */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return result

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) result[key] = value
  }
  return result
}

/** Extract a semver string from frontmatter if present */
function extractSemver(frontmatter: Record<string, string>): string | null {
  const raw = frontmatter['version'] ?? frontmatter['semver'] ?? null
  if (!raw) return null
  // Accept bare semver: 1.2.3 or with optional v prefix
  return /^\s*v?\d+\.\d+\.\d+/.test(raw) ? raw.replace(/^\s*v/, '') : null
}

/** Parse semver into major/minor/patch numbers */
function parseSemverParts(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Derive ChangeType from two semver strings */
function classifyBySemver(oldSemver: string, newSemver: string): ChangeType | null {
  const oldParts = parseSemverParts(oldSemver)
  const newParts = parseSemverParts(newSemver)
  if (!oldParts || !newParts) return null

  if (newParts[0] > oldParts[0]) return 'major'
  if (newParts[0] < oldParts[0]) return 'major' // downgrade also = major
  if (newParts[1] > oldParts[1]) return 'minor'
  if (newParts[1] < oldParts[1]) return 'minor' // minor downgrade = minor
  if (newParts[2] !== oldParts[2]) return 'patch'
  return 'patch' // identical semver → treat as patch (re-record)
}

// ============================================================================
// Heading extraction
// ============================================================================

/** Extract H2/H3 heading text from markdown */
function extractHeadings(content: string): Set<string> {
  const headings = new Set<string>()
  for (const line of content.split('\n')) {
    const m = /^#{2,3}\s+(.+)/.exec(line)
    if (m) headings.add(m[1].trim().toLowerCase())
  }
  return headings
}

// ============================================================================
// Dependency extraction
// ============================================================================

/**
 * Extract dependency names from SKILL.md.
 *
 * Looks for lines that match common dependency list patterns:
 *   - `- dep-name` inside a "## Dependencies" or "## Requirements" section
 *   - `dependencies: [dep1, dep2]` in frontmatter
 */
function extractDependencies(content: string, frontmatter: Record<string, string>): Set<string> {
  const deps = new Set<string>()

  // Frontmatter array-style: dependencies: [a, b]
  const fmDeps = frontmatter['dependencies'] ?? frontmatter['requires'] ?? ''
  if (fmDeps) {
    for (const d of fmDeps.replace(/[[\]]/g, '').split(',')) {
      const trimmed = d.trim()
      if (trimmed) deps.add(trimmed.toLowerCase())
    }
  }

  // Body: lines under a dependencies/requirements heading
  let inDepsSection = false
  for (const line of content.split('\n')) {
    if (/^#{1,3}\s+(dependencies|requirements|requires)/i.test(line)) {
      inDepsSection = true
      continue
    }
    if (/^#{1,3}\s+/.test(line)) {
      inDepsSection = false
      continue
    }
    if (inDepsSection) {
      const m = /^[-*]\s+(\S+)/.exec(line)
      if (m) deps.add(m[1].trim().toLowerCase())
    }
  }

  return deps
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Classify the change between two versions of a SKILL.md.
 *
 * Order of precedence:
 *  1. Author-provided semver in frontmatter (trusted over heuristics)
 *  2. Removed headings → 'major'
 *  3. Risk score delta > 20 → upgrade to 'major'
 *  4. Removed dependencies → 'major'
 *  5. Added headings only → 'minor'
 *  6. Added dependencies → 'minor'
 *  7. Body edits with no structural changes → 'patch'
 *  8. No detectable change → 'patch'
 *  9. Error during classification → 'unknown'
 *
 * @param oldContent    Previous SKILL.md content
 * @param newContent    Updated SKILL.md content
 * @param oldRiskScore  Risk score of the old version (0–100, optional)
 * @param newRiskScore  Risk score of the new version (0–100, optional)
 * @returns Semantic change type
 */
export function classifyChange(
  oldContent: string,
  newContent: string,
  oldRiskScore?: number,
  newRiskScore?: number
): ChangeType {
  try {
    const oldFm = parseFrontmatter(oldContent)
    const newFm = parseFrontmatter(newContent)

    // 1. Trust author-provided semver — only when the semver actually changed
    const oldSemver = extractSemver(oldFm)
    const newSemver = extractSemver(newFm)
    if (oldSemver && newSemver && oldSemver !== newSemver) {
      const fromSemver = classifyBySemver(oldSemver, newSemver)
      if (fromSemver) return fromSemver
    }

    // 2. Heading analysis
    const oldHeadings = extractHeadings(oldContent)
    const newHeadings = extractHeadings(newContent)

    const removedHeadings = [...oldHeadings].filter((h) => !newHeadings.has(h))
    const addedHeadings = [...newHeadings].filter((h) => !oldHeadings.has(h))

    if (removedHeadings.length > 0) return 'major'

    // 3. Risk score delta — large increase signals a major change
    if (
      typeof oldRiskScore === 'number' &&
      typeof newRiskScore === 'number' &&
      newRiskScore - oldRiskScore > 20
    ) {
      return 'major'
    }

    // 4. Dependency analysis
    const oldDeps = extractDependencies(oldContent, oldFm)
    const newDeps = extractDependencies(newContent, newFm)

    const removedDeps = [...oldDeps].filter((d) => !newDeps.has(d))
    const addedDeps = [...newDeps].filter((d) => !oldDeps.has(d))

    if (removedDeps.length > 0) return 'major'

    // 5–6. Additions-only → minor
    if (addedHeadings.length > 0 || addedDeps.length > 0) return 'minor'

    // 7–8. Any textual change or no change → patch
    return 'patch'
  } catch {
    return 'unknown'
  }
}
