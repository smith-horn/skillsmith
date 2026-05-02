/**
 * @fileoverview Local-inventory scanner for the consumer namespace audit.
 * @module @skillsmith/mcp-server/utils/local-inventory
 * @see SMI-4587 Wave 1 Step 2 — scan ~/.claude/{skills,commands,agents} +
 *      CLAUDE.md trigger phrases into a unified InventoryEntry[].
 *
 * Each source is independent — failure in one does not fail the others.
 * The scanner is read-only; bootstrapping unmanaged skills via `index_local`
 * is wired in a subsequent PR (Step 6a).
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { InventoryEntry, ScanResult, ScanWarning } from './local-inventory.types.js'
import {
  WARNING_CODES,
  capTriggerSurface,
  extractClaudeMdTriggers,
  firstNonEmptyLine,
  loadManifest,
  lookupAuthor,
  readBody,
  readFrontmatter,
  readMtime,
  splitDescriptionToPhrases,
} from './local-inventory.helpers.js'

const DEFAULT_HOME_CLAUDE_DIR = path.join(os.homedir(), '.claude')
const DEFAULT_MANIFEST_PATH = path.join(os.homedir(), '.skillsmith', 'manifest.json')

export interface ScanLocalInventoryOptions {
  /** Defaults to `os.homedir()`. */
  homeDir?: string
  /** Optional project CLAUDE.md to scan in addition to the user one. */
  projectDir?: string
  /** Override path to `~/.skillsmith/manifest.json`. */
  manifestPath?: string
}

/**
 * Scan `~/.claude/{skills,commands,agents}` and CLAUDE.md trigger phrases.
 *
 * Returns `entries[]` sorted by `kind` then `identifier`, plus any soft
 * `warnings[]` raised during scanning. `durationMs` measures wall-clock
 * time for the whole scan (excluding the optional bootstrap step that
 * lands in a subsequent PR).
 */
export async function scanLocalInventory(
  opts: ScanLocalInventoryOptions = {}
): Promise<ScanResult> {
  const startedAt = process.hrtime.bigint()

  const homeDir = opts.homeDir ?? os.homedir()
  const claudeDir = opts.homeDir ? path.join(opts.homeDir, '.claude') : DEFAULT_HOME_CLAUDE_DIR
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH

  const warnings: ScanWarning[] = []
  const entries: InventoryEntry[] = []

  const manifest = loadManifest(manifestPath)

  // Source 1: ~/.claude/skills/*/SKILL.md
  entries.push(...scanSkills(path.join(claudeDir, 'skills'), manifest, warnings))

  // Source 2: ~/.claude/commands/*.md
  entries.push(...scanCommands(path.join(claudeDir, 'commands'), warnings))

  // Source 3: ~/.claude/agents/*.md
  entries.push(...scanAgents(path.join(claudeDir, 'agents'), warnings))

  // Source 4: ~/.claude/CLAUDE.md and (optional) project CLAUDE.md
  const userClaudeMd = path.join(claudeDir, 'CLAUDE.md')
  if (fs.existsSync(userClaudeMd)) {
    entries.push(...extractClaudeMdTriggers(userClaudeMd, warnings))
  }
  if (opts.projectDir) {
    const projectClaudeMd = path.join(opts.projectDir, 'CLAUDE.md')
    if (fs.existsSync(projectClaudeMd)) {
      entries.push(...extractClaudeMdTriggers(projectClaudeMd, warnings))
    }
  }

  // Stable ordering for downstream consumers.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.identifier.localeCompare(b.identifier)
  })

  const elapsedNs = process.hrtime.bigint() - startedAt
  const durationMs = Number(elapsedNs) / 1_000_000

  // Suppress unused-variable warning while keeping the homeDir resolution
  // visible in opts handling above. Reserved for future per-OS path logic.
  void homeDir

  return { entries, warnings, durationMs }
}

/**
 * Scan `~/.claude/skills/*` for SKILL.md frontmatter. Returns one entry
 * per directory; entries without SKILL.md are still recorded (with
 * directory-name fallback) so the collision detector still sees them.
 */
function scanSkills(
  skillsDir: string,
  manifest: Record<string, unknown> | null,
  warnings: ScanWarning[]
): InventoryEntry[] {
  if (!fs.existsSync(skillsDir)) return []

  const out: InventoryEntry[] = []
  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const dirent of dirEntries) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    const skillDir = path.join(skillsDir, dirent.name)
    const skillMd = path.join(skillDir, 'SKILL.md')

    let identifier = dirent.name
    let description: string | undefined
    let mtime: number | undefined

    if (fs.existsSync(skillMd)) {
      const fm = readFrontmatter(skillMd)
      const fmName = typeof fm.name === 'string' ? fm.name : undefined
      if (fmName && fmName.trim()) identifier = fmName.trim()
      const fmDesc = coerceDescription(fm.description)
      if (fmDesc) description = fmDesc
      mtime = readMtime(skillMd)
    } else {
      // Skill directory without SKILL.md is unusual; record a soft warning
      // so the audit report can flag it but do not block the scan.
      warnings.push({
        code: WARNING_CODES.PARSE_FAILED,
        message: `skill directory ${skillDir} has no SKILL.md; using directory name as identifier`,
        context: { path: skillDir },
      })
    }

    const phrases = capTriggerSurface(
      identifier,
      [identifier, ...splitDescriptionToPhrases(description)],
      warnings
    )
    const author = lookupAuthor(manifest, identifier)

    out.push({
      kind: 'skill',
      source_path: skillMd,
      identifier,
      triggerSurface: phrases,
      mtime,
      meta: {
        description,
        author: author.author,
        tags: author.tags,
      },
    })
  }

  return out
}

/**
 * Scan `~/.claude/commands/*.md`. Frontmatter `description:` wins as
 * trigger surface; otherwise the first non-empty line of the body.
 * Tolerates frontmatter-less files (most slash commands have none).
 */
function scanCommands(commandsDir: string, warnings: ScanWarning[]): InventoryEntry[] {
  if (!fs.existsSync(commandsDir)) return []
  return scanMdDir(commandsDir, 'command', warnings)
}

/**
 * Scan `~/.claude/agents/*.md`. Subagent files always carry frontmatter
 * `description:` per Claude Code convention; surface that. Falls back to
 * filename + body first-line if frontmatter is absent.
 */
function scanAgents(agentsDir: string, warnings: ScanWarning[]): InventoryEntry[] {
  if (!fs.existsSync(agentsDir)) return []
  return scanMdDir(agentsDir, 'agent', warnings)
}

/**
 * Shared scan logic for commands + agents — both follow the
 * "filename = identifier; description from frontmatter or body" shape.
 */
function scanMdDir(
  dir: string,
  kind: 'command' | 'agent',
  warnings: ScanWarning[]
): InventoryEntry[] {
  const out: InventoryEntry[] = []
  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const dirent of dirEntries) {
    if (!dirent.isFile()) continue
    if (!dirent.name.endsWith('.md')) continue
    if (dirent.name.startsWith('.')) continue

    const filePath = path.join(dir, dirent.name)
    const identifier = dirent.name.slice(0, -3) // strip .md
    const fm = readFrontmatter(filePath)
    const description = coerceDescription(fm.description)
    let triggerLine = description ?? ''
    if (!triggerLine) {
      triggerLine = firstNonEmptyLine(readBody(filePath))
    }

    const phrases = capTriggerSurface(
      identifier,
      [identifier, ...(triggerLine ? splitDescriptionToPhrases(triggerLine) : [])],
      warnings
    )

    out.push({
      kind,
      source_path: filePath,
      identifier,
      triggerSurface: phrases,
      mtime: readMtime(filePath),
      meta: {
        description: triggerLine || undefined,
      },
    })
  }
  return out
}

/**
 * `parseYamlFrontmatter` returns `string | string[] | undefined` for
 * description (depending on block-scalar syntax). Normalize to a single
 * string for downstream consumers.
 */
function coerceDescription(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (Array.isArray(value)) {
    const joined = value
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0)
      .join(' ')
    return joined.length > 0 ? joined : undefined
  }
  return undefined
}
