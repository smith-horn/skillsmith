/**
 * @fileoverview `indexLocalSkill` — pure core helper that registers a single
 *               SKILL.md file's metadata into the local manifest snapshot
 *               consumed by the namespace-audit collision detector
 *               (SMI-4587 Wave 1 PR #4 / NEW-E-2).
 * @module @skillsmith/core/skills/index-local
 *
 * Extracted from `executeIndexLocal` in `@skillsmith/mcp-server/tools/index-local`
 * so the audit's `bootstrapUnmanagedSkills` callback can wire a real
 * implementation instead of the no-op stub. The MCP tool delegates to this
 * helper and adds the MCP envelope (timing, formatted summaries) on top.
 *
 * Pure-ish contract:
 *   - Input: absolute path to a SKILL.md file (or its containing directory).
 *   - Output: deterministic `IndexLocalSkillResult` with frontmatter-derived
 *     metadata + a quality score. No global state mutated, no network IO.
 *   - Filesystem reads only (`fs.readFileSync` on the SKILL.md). Throws if the
 *     path resolves outside the caller's expected root — caller layers
 *     `path-traversal` checks; this helper trusts what it's given.
 *
 * Surface kept narrow on purpose: Wave 2/3/4 callers should NOT reach into
 * core internals. Anything beyond `indexLocalSkill(absPath, opts?)` belongs
 * in mcp-server's tool layer.
 *
 * @see SMI-4587 plan §466 (NEW-E-2 surface grounding).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Frontmatter shape parsed from `SKILL.md`. Matches the subset the local
 * skill indexer relies on; extra keys are ignored.
 */
export interface IndexLocalSkillFrontmatter {
  name: string | null
  description: string | null
  author: string | null
  tags: string[]
  version: string | null
  repository: string | null
  homepage: string | null
  compatibility: string[]
}

/**
 * Deterministic result shape returned by {@link indexLocalSkill}. Used by:
 *   - mcp-server's `executeIndexLocal` tool (formatted into the response)
 *   - the audit `bootstrapUnmanagedSkills` callback (treated as success when
 *     no error is thrown)
 *   - frozen-fixture regression tests in this package.
 */
export interface IndexLocalSkillResult {
  /** Skill ID in `local/{name}` shape — matches LocalIndexer.id. */
  id: string
  /** Skill name from frontmatter or the directory fallback. */
  name: string
  /** Description from frontmatter (may be null when missing). */
  description: string | null
  /** Author from frontmatter; defaults to `'local'` when absent. */
  author: string
  /** Tags from frontmatter (empty array when missing). */
  tags: string[]
  /** Quality score 0..100 derived from frontmatter completeness. */
  qualityScore: number
  /** Always `'local'` for this helper — local-only by definition. */
  trustTier: 'local'
  /** Always `'local'` for this helper. */
  source: 'local'
  /** Absolute path to the skill directory. */
  path: string
  /** Whether `SKILL.md` was actually found at the resolved path. */
  hasSkillMd: boolean
  /** ISO timestamp of last directory mtime (null when stat fails). */
  lastModified: string | null
  /** Source repository URL from frontmatter (null when missing). */
  repository: string | null
  /** Compatibility tags from frontmatter (undefined when none). */
  compatibility?: string[]
}

/**
 * Optional knobs for {@link indexLocalSkill}. Defaults wired so callers can
 * pass just `(absPath)` in the common case.
 */
export interface IndexLocalSkillOptions {
  /**
   * Override the SKILL.md filename when an alternate manifest layout is in
   * use. Defaults to `'SKILL.md'`.
   */
  skillManifestName?: string
  /**
   * Inject a frontmatter parser. Defaults to the bundled minimal parser. The
   * MCP tool layer can pass `parseFrontmatter` from the existing
   * `FrontmatterParser` to keep parity with the indexer.
   */
  parseFrontmatter?: (content: string) => IndexLocalSkillFrontmatter
}

const QUALITY_WEIGHTS = {
  hasSkillMd: 20,
  hasName: 10,
  hasDescription: 20,
  hasTags: 15,
  hasAuthor: 5,
  descriptionLength: 15,
  tagCount: 15,
} as const

/**
 * Index a single local skill given the absolute path to its `SKILL.md` file
 * (or the directory that contains it).
 *
 * Pure side-effect-light: reads filesystem, does not write anywhere. Returns
 * a deterministic `IndexLocalSkillResult`. Throws when the path doesn't
 * resolve to an existing directory — the caller (audit bootstrap) translates
 * thrown errors into typed warnings.
 *
 * Parity with `mcp-server/indexer/LocalIndexer.indexSkillDir` is intentional;
 * the MCP tool will delegate here once this lands. The split is along a
 * per-skill boundary (helper) vs. per-directory traversal (indexer).
 */
export function indexLocalSkill(
  absPath: string,
  opts: IndexLocalSkillOptions = {}
): IndexLocalSkillResult {
  const skillManifestName = opts.skillManifestName ?? 'SKILL.md'
  const parse = opts.parseFrontmatter ?? defaultParseFrontmatter

  const { skillDir, skillMdPath, dirName } = resolvePaths(absPath, skillManifestName)

  let hasSkillMd = false
  let content = ''
  let lastModified: string | null = null

  try {
    const stats = fs.statSync(skillDir)
    lastModified = stats.mtime.toISOString()
  } catch (err) {
    throw new Error(
      `indexLocalSkill: cannot stat ${skillDir}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (fs.existsSync(skillMdPath)) {
    hasSkillMd = true
    content = fs.readFileSync(skillMdPath, 'utf-8')
  }

  const frontmatter = parse(content)
  const name = frontmatter.name || dirName
  const qualityScore = calculateQualityScore(frontmatter, hasSkillMd)

  return {
    id: `local/${name}`,
    name,
    description: frontmatter.description,
    author: frontmatter.author || 'local',
    tags: frontmatter.tags,
    qualityScore,
    trustTier: 'local',
    source: 'local',
    path: skillDir,
    hasSkillMd,
    lastModified,
    repository: frontmatter.repository,
    compatibility: frontmatter.compatibility.length > 0 ? frontmatter.compatibility : undefined,
  }
}

/**
 * Resolve a caller-supplied path into a normalized `{ skillDir, skillMdPath,
 * dirName }` triple. Accepts either the SKILL.md file itself (the audit
 * inventory shape) or the parent directory (LocalIndexer's per-entry shape).
 */
function resolvePaths(
  absPath: string,
  skillManifestName: string
): { skillDir: string; skillMdPath: string; dirName: string } {
  // Audit inventory always passes the SKILL.md absolute path; the MCP tool
  // path may pass a directory. Normalize both.
  const looksLikeManifest = path.basename(absPath) === skillManifestName
  const skillDir = looksLikeManifest ? path.dirname(absPath) : absPath
  const skillMdPath = path.join(skillDir, skillManifestName)
  const dirName = path.basename(skillDir)
  return { skillDir, skillMdPath, dirName }
}

/**
 * Quality score 0..100. Mirrors the weights used by `LocalIndexer` so the
 * MCP tool's response stays unchanged after the refactor.
 */
function calculateQualityScore(
  frontmatter: IndexLocalSkillFrontmatter,
  hasSkillMd: boolean
): number {
  let score = 0
  if (hasSkillMd) score += QUALITY_WEIGHTS.hasSkillMd
  if (frontmatter.name) score += QUALITY_WEIGHTS.hasName
  if (frontmatter.description) {
    score += QUALITY_WEIGHTS.hasDescription
    const descLength = Math.min(frontmatter.description.length, 200)
    score += Math.round((descLength / 200) * QUALITY_WEIGHTS.descriptionLength)
  }
  if (frontmatter.tags.length > 0) {
    score += QUALITY_WEIGHTS.hasTags
    const tagBonus = Math.min(frontmatter.tags.length, 5) / 5
    score += Math.round(tagBonus * QUALITY_WEIGHTS.tagCount)
  }
  if (frontmatter.author) score += QUALITY_WEIGHTS.hasAuthor
  return Math.min(score, 100)
}

/**
 * Minimal YAML frontmatter parser scoped to `SKILL.md` keys. The MCP tool
 * layer overrides this with the existing `FrontmatterParser.parseFrontmatter`
 * so behavior stays identical to the LocalIndexer path.
 */
function defaultParseFrontmatter(content: string): IndexLocalSkillFrontmatter {
  const result: IndexLocalSkillFrontmatter = {
    name: null,
    description: null,
    author: null,
    tags: [],
    version: null,
    repository: null,
    homepage: null,
    compatibility: [],
  }
  if (!content.startsWith('---')) return result

  const closingMatch = content.match(/\n---(\r?\n|$)/)
  if (!closingMatch || closingMatch.index === undefined) return result

  const frontmatter = content.substring(3, closingMatch.index).trim()
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    assignKey(result, key, value)
  }
  return result
}

function assignKey(target: IndexLocalSkillFrontmatter, key: string, value: string): void {
  const cleaned = stripQuotes(value)
  switch (key) {
    case 'name':
      target.name = cleaned || null
      break
    case 'description':
      target.description = cleaned || null
      break
    case 'author':
      target.author = cleaned || null
      break
    case 'version':
      target.version = cleaned || null
      break
    case 'repository':
      target.repository = cleaned || null
      break
    case 'homepage':
      target.homepage = cleaned || null
      break
    case 'tags':
      target.tags = parseInlineList(cleaned)
      break
    case 'compatibility':
      target.compatibility = parseInlineList(cleaned)
      break
    default:
      break
  }
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function parseInlineList(value: string): string[] {
  if (!value) return []
  // Inline list `[a, b, c]` or `a, b, c`
  const trimmed = value.replace(/^\[/, '').replace(/\]$/, '')
  return trimmed
    .split(',')
    .map((t) => stripQuotes(t.trim()))
    .filter((t) => t.length > 0)
}
