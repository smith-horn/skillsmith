/**
 * Local (bare-id) skill reader for the detail panel (SMI-5401).
 *
 * Installed skills are keyed in the tree by their bare on-disk directory slug
 * (e.g. `ci-doctor`), which the registry `get_skill` tool always rejects. This
 * module reads such a skill's metadata + markdown body straight from
 * `<skills-root>/<slug>/SKILL.md` and adapts it to the panel's `ExtendedSkillData`
 * contract, never touching the MCP server.
 *
 * Mirror-don't-import: the VS Code extension is esbuild-bundled with
 * `vsce package --no-dependencies` and intentionally does NOT depend on
 * `@skillsmith/core` (importing it would pull `better-sqlite3` / `onnxruntime-node`
 * into the bundle — see the same notes in `src/sidebar/trustTier.ts` and
 * `src/sidebar/categories.ts`). Core's `indexLocalSkill` parser is therefore
 * mirrored here, with two additions: it captures the SKILL.md body (which the
 * panel's "Skill Content" section needs) and adapts to `ExtendedSkillData`.
 *
 * @module services/localSkillReader
 */
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtendedSkillData } from '../types/skill.js'

/** Async file reader signature (injectable for unit tests). */
export type SkillFileReader = (filePath: string, encoding: 'utf-8') => Promise<string>

/**
 * Frontmatter subset parsed from `SKILL.md`. Mirrors the keys
 * `@skillsmith/core/skills/index-local` relies on; extra keys are ignored.
 * `null` (not `undefined`) marks an absent value, matching core's parser shape.
 */
export interface LocalSkillFrontmatter {
  name: string | null
  description: string | null
  author: string | null
  tags: string[]
  version: string | null
  repository: string | null
}

/**
 * Resolve the configured skills root, mirroring
 * `SkillTreeDataProvider.doLoadInstalledSkills` exactly: read
 * `skillsmith.skillsDirectory` (default `~/.claude/skills`) and expand a leading
 * `~` via `os.homedir()`.
 */
export function resolveSkillsRoot(): string {
  const config = vscode.workspace.getConfiguration('skillsmith')
  let skillsDir = config.get<string>('skillsDirectory') || '~/.claude/skills'
  if (skillsDir.startsWith('~')) {
    skillsDir = path.join(os.homedir(), skillsDir.slice(1))
  }
  return skillsDir
}

/**
 * Security guard (path traversal): resolve `<root>/<skillId>` only when
 * `skillId` is a single safe path segment, and assert the result stays directly
 * under the resolved root. By construction a local-shaped id has no `/`, so this
 * is defense-in-depth, mirroring the `LocalFilesystemConfig` containment posture
 * (CLAUDE.md "Symlink outside skills root (SMI-4287)"). Must run before any fs
 * read.
 *
 * @throws if `skillId` is empty, contains `/`, `\`, `..`, a leading `.`, or a
 *   NUL byte, or if the resolved path escapes the skills root.
 */
export function resolveLocalSkillDir(skillId: string, root: string): string {
  if (
    skillId.length === 0 ||
    skillId.includes('/') ||
    skillId.includes('\\') ||
    skillId.includes('..') ||
    skillId.startsWith('.') ||
    skillId.includes('\0')
  ) {
    throw new Error(`Unsafe skill id: "${skillId}"`)
  }
  const resolvedRoot = path.resolve(root)
  const dir = path.resolve(resolvedRoot, skillId)
  if (!dir.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Skill id "${skillId}" escapes the skills root`)
  }
  return dir
}

// Mirrors QUALITY_WEIGHTS from packages/core/src/skills/index-local.ts:100-108. Keep in sync if core weights change.
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
 * Quality score 0..100 derived from frontmatter completeness. Mirrors core's
 * `calculateQualityScore` so the panel's Score row matches the indexer rather
 * than rendering a bare `0`. `hasSkillMd` is always true at our call site (we
 * only score after a successful read) but kept for fidelity with core.
 */
export function calculateLocalQualityScore(fm: LocalSkillFrontmatter, hasSkillMd = true): number {
  let score = 0
  if (hasSkillMd) score += QUALITY_WEIGHTS.hasSkillMd
  if (fm.name) score += QUALITY_WEIGHTS.hasName
  if (fm.description) {
    score += QUALITY_WEIGHTS.hasDescription
    const descLength = Math.min(fm.description.length, 200)
    score += Math.round((descLength / 200) * QUALITY_WEIGHTS.descriptionLength)
  }
  if (fm.tags.length > 0) {
    score += QUALITY_WEIGHTS.hasTags
    const tagBonus = Math.min(fm.tags.length, 5) / 5
    score += Math.round(tagBonus * QUALITY_WEIGHTS.tagCount)
  }
  if (fm.author) score += QUALITY_WEIGHTS.hasAuthor
  return Math.min(score, 100)
}

/**
 * Split a `SKILL.md` into its parsed frontmatter and markdown body. Mirrors
 * core's `defaultParseFrontmatter` and additionally returns the body after the
 * closing `---`. When no frontmatter delimiter is present, the whole content is
 * treated as the body.
 */
export function splitFrontmatter(content: string): {
  frontmatter: LocalSkillFrontmatter
  body: string
} {
  const frontmatter: LocalSkillFrontmatter = {
    name: null,
    description: null,
    author: null,
    tags: [],
    version: null,
    repository: null,
  }
  if (!content.startsWith('---')) {
    return { frontmatter, body: content }
  }
  const closingMatch = content.match(/\n---(\r?\n|$)/)
  if (!closingMatch || closingMatch.index === undefined) {
    return { frontmatter, body: content }
  }
  const fmText = content.substring(3, closingMatch.index).trim()
  const body = content.slice(closingMatch.index + closingMatch[0].length).replace(/^\n+/, '')
  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    assignKey(frontmatter, line.slice(0, sep).trim(), line.slice(sep + 1).trim())
  }
  return { frontmatter, body }
}

function assignKey(target: LocalSkillFrontmatter, key: string, value: string): void {
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
    case 'tags':
      target.tags = parseInlineList(cleaned)
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
  const trimmed = value.replace(/^\[/, '').replace(/\]$/, '')
  return trimmed
    .split(',')
    .map((t) => stripQuotes(t.trim()))
    .filter((t) => t.length > 0)
}

/**
 * Read `<dir>/SKILL.md`, parse its frontmatter + body, and adapt to
 * `ExtendedSkillData`. The `id` is the on-disk directory slug (M1) — never the
 * frontmatter `name` — so telemetry, installed-state cross-referencing, and
 * `inferRepositoryUrl(skill.id)` key off the stable slug; `name` is the only
 * display-facing field that may use the frontmatter `name`.
 *
 * @throws a user-friendly error when `SKILL.md` is missing (M3), so it reads
 *   correctly after passing through `mapErrorToUserMessage` unchanged.
 */
export async function loadLocalSkillFromDir(
  dir: string,
  readFile: SkillFileReader = fs.promises.readFile
): Promise<ExtendedSkillData> {
  const id = path.basename(dir)
  const skillMdPath = path.join(dir, 'SKILL.md')

  let content: string
  try {
    content = await readFile(skillMdPath, 'utf-8')
  } catch {
    throw new Error(`Skill "${id}" has no SKILL.md. Check ~/.claude/skills/${id}/`)
  }

  const { frontmatter: fm, body } = splitFrontmatter(content)

  const data: ExtendedSkillData = {
    id,
    name: fm.name || id,
    description: fm.description ?? '',
    author: fm.author ?? 'local',
    category: 'local',
    trustTier: 'local',
    score: calculateLocalQualityScore(fm),
    version: fm.version ?? undefined,
    tags: fm.tags,
    installCommand: undefined,
    scoreBreakdown: undefined,
    content: body,
    securityPassed: null,
    securityRiskScore: null,
    securityScannedAt: null,
    securityFindingsCount: null,
  }
  if (fm.repository) {
    data.repository = fm.repository
  }
  return data
}

/**
 * Load a local skill by its bare id. Prefers `knownDir` (the tree's validated
 * installed-entry `path`) when available; otherwise resolves
 * `<skills-root>/<id>` through the path-traversal guard before reading.
 */
export async function loadLocalSkillById(
  skillId: string,
  knownDir?: string,
  readFile: SkillFileReader = fs.promises.readFile
): Promise<ExtendedSkillData> {
  const dir = knownDir ?? resolveLocalSkillDir(skillId, resolveSkillsRoot())
  return loadLocalSkillFromDir(dir, readFile)
}
