/**
 * @fileoverview Helpers for the local-inventory scanner (SMI-4587 Wave 1 Step 2).
 * @module @skillsmith/mcp-server/utils/local-inventory.helpers
 *
 * Pure functions extracted to keep `local-inventory.ts` thin — CLAUDE.md
 * regex extraction (testable in isolation) and the shared skill-directory
 * scan walk both live here.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { CANONICAL_CLIENT } from '@skillsmith/core/install'

import { parseYamlFrontmatter } from '../tools/validate.helpers.js'
import type { InventoryEntry, ScanWarning } from './local-inventory.types.js'

/**
 * Stable warning code catalog. Keep this in sync with the writer; the audit
 * report renders messages keyed off `code`.
 */
export const WARNING_CODES = {
  TRIGGER_SURFACE_TRUNCATED: 'namespace.inventory.trigger_surface_truncated',
  BOOTSTRAP_FAILED: 'namespace.inventory.bootstrap_failed',
  CLAUDE_MD_RECALL_LOW: 'namespace.inventory.claude_md_recall_low',
  REGEX_EXTRACTION_SKIPPED: 'namespace.inventory.regex_extraction_skipped',
  UNMANAGED_SKILL_BOOTSTRAPPED: 'namespace.inventory.unmanaged_skill_bootstrapped',
  PARSE_FAILED: 'namespace.inventory.parse_failed',
  /** SMI-6228 Source 5 (plugin-skill scan): an enabled plugin id could not be
   * resolved to a scannable `skills/` directory — malformed
   * `<plugin>@<marketplace>` shape, missing cache directory, or the cache
   * directory doesn't have exactly one version subdirectory. Always
   * fail-soft: the plugin is skipped, not thrown. */
  PLUGIN_SCAN_SKIPPED: 'namespace.inventory.plugin_scan_skipped',
} as const

/** Maximum trigger phrases retained per entry — matches `OverlapDetector.MAX_TRIGGER_PHRASES_PER_SKILL`. */
export const MAX_TRIGGER_PHRASES_PER_SKILL = 50

/**
 * Cap an array of trigger phrases at MAX_TRIGGER_PHRASES_PER_SKILL. When
 * truncation occurs, append a warning of code `trigger_surface_truncated`
 * with the dropped count so the user sees it in the audit report.
 */
export function capTriggerSurface(
  identifier: string,
  phrases: string[],
  warnings: ScanWarning[]
): string[] {
  if (phrases.length <= MAX_TRIGGER_PHRASES_PER_SKILL) {
    return phrases
  }

  warnings.push({
    code: WARNING_CODES.TRIGGER_SURFACE_TRUNCATED,
    message: `triggerSurface for "${identifier}" was capped at ${MAX_TRIGGER_PHRASES_PER_SKILL} phrases (${phrases.length - MAX_TRIGGER_PHRASES_PER_SKILL} dropped)`,
    context: {
      entry_identifier: identifier,
      dropped_count: phrases.length - MAX_TRIGGER_PHRASES_PER_SKILL,
    },
  })

  return phrases.slice(0, MAX_TRIGGER_PHRASES_PER_SKILL)
}

/**
 * Split a description into sentence-level trigger phrases. Empty or
 * whitespace-only segments are filtered.
 */
export function splitDescriptionToPhrases(description: string | undefined): string[] {
  if (!description) return []
  // Split on sentence terminators; tolerate runs of whitespace and trailing
  // punctuation. Not a strict NLP tokenizer — close-enough for trigger surface.
  return description
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Read the YAML frontmatter from a `.md` file. Returns `{}` if no
 * frontmatter or the file cannot be parsed.
 */
export function readFrontmatter(filePath: string): Record<string, unknown> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return parseYamlFrontmatter(content) ?? {}
  } catch {
    return {}
  }
}

/**
 * Extract the body of a `.md` file (everything after the closing
 * frontmatter delimiter, or the full content if no frontmatter).
 */
export function readBody(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    if (!content.startsWith('---')) return content
    const end = content.indexOf('---', 3)
    if (end === -1) return content
    return content.slice(end + 3).trimStart()
  } catch {
    return ''
  }
}

/**
 * Pull the first non-empty line from a body string. Used as the fallback
 * trigger surface for frontmatter-less command files.
 */
export function firstNonEmptyLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * Stable identifier for a CLAUDE.md trigger line. The identifier doubles as
 * dedup key — two scans of the same line produce the same id. Hashed
 * because the line itself can be long; first 12 hex chars are sufficient.
 */
export function hashClaudeMdLine(claudeMdPath: string, line: string): string {
  const norm = line.trim().toLowerCase()
  const hash = crypto
    .createHash('sha256')
    .update(`${claudeMdPath}:${norm}`)
    .digest('hex')
    .slice(0, 12)
  return `claude_md:${hash}`
}

/**
 * Best-effort regex extractor for CLAUDE.md trigger phrases.
 *
 * Two patterns are recognized (per Wave 0 spike goal #3):
 *
 * 1. Bullet items under headings matching
 *    `/^#{1,3}\s*(Trigger phrases|Use when|Skills)\b/i`. Recall is
 *    best-effort — false negatives expected for non-standard heading text.
 * 2. Any line containing the high-confidence marker
 *    `<!-- skillsmith:trigger -->`. The full line is captured as a phrase.
 *
 * Returns one `InventoryEntry` per extracted line. Failures (file missing,
 * unparseable) emit a `warnings[]` entry — never throw.
 */
export function extractClaudeMdTriggers(
  claudeMdPath: string,
  warnings: ScanWarning[]
): InventoryEntry[] {
  let content: string
  try {
    content = fs.readFileSync(claudeMdPath, 'utf-8')
  } catch {
    // Missing file is silent (no CLAUDE.md is a normal state).
    return []
  }

  const entries: InventoryEntry[] = []
  let stat: fs.Stats | undefined
  try {
    stat = fs.statSync(claudeMdPath)
  } catch {
    stat = undefined
  }

  let captureMode: 'heading' | 'marker' | 'idle' = 'idle'
  let lines: string[]
  try {
    lines = content.split('\n')
  } catch {
    warnings.push({
      code: WARNING_CODES.REGEX_EXTRACTION_SKIPPED,
      message: `CLAUDE.md at ${claudeMdPath} unparseable; trigger-phrase scan skipped`,
      context: { path: claudeMdPath },
    })
    return []
  }

  // Headings considered as trigger sections. Case-insensitive, allow up to
  // three leading hashes (per spec line 104).
  const headingRe = /^#{1,3}\s*(Trigger phrases|Use when|Skills)\b/i
  const otherHeadingRe = /^#{1,6}\s+/
  const bulletRe = /^[-*]\s+(.+)$/
  const markerRe = /<!--\s*skillsmith:trigger\s*-->/

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (markerRe.test(line)) {
      // High-confidence marker line — capture the whole line minus the marker.
      const phrase = line.replace(markerRe, '').trim()
      if (phrase) {
        entries.push(makeClaudeMdEntry(claudeMdPath, phrase, stat?.mtimeMs))
      }
      continue
    }

    if (headingRe.test(line)) {
      captureMode = 'heading'
      continue
    }

    // Reset capture mode on any other heading.
    if (otherHeadingRe.test(line)) {
      captureMode = 'idle'
      continue
    }

    if (captureMode === 'heading') {
      const m = bulletRe.exec(line)
      if (m && m[1]) {
        const phrase = m[1].trim()
        if (phrase) {
          entries.push(makeClaudeMdEntry(claudeMdPath, phrase, stat?.mtimeMs))
        }
      }
    }
  }

  return entries
}

function makeClaudeMdEntry(
  claudeMdPath: string,
  phrase: string,
  mtime: number | undefined
): InventoryEntry {
  return {
    kind: 'claude_md_rule',
    source_path: claudeMdPath,
    identifier: hashClaudeMdLine(claudeMdPath, phrase),
    triggerSurface: [phrase],
    mtime,
    // CLAUDE.md rules are Claude Code-only (SMI-6077) — no other supported
    // client reads this file today.
    client: CANONICAL_CLIENT,
    // Source 4 — a native-client entry, not a plugin-scan one (SMI-6228).
    origin: 'native-client',
    meta: { description: phrase },
  }
}

/**
 * Parse `~/.claude/settings.json`'s `enabledPlugins` map and return the ids
 * (`<plugin>@<marketplace>` shape) whose value is exactly `true` (SMI-6228
 * Source 5). Anything else — `false`, missing, a non-boolean value, a
 * missing `enabledPlugins` key, a missing/unreadable/malformed
 * settings.json — yields `[]` (fail-soft; a malformed-JSON file
 * additionally raises a `PARSE_FAILED` warning since that indicates a
 * corrupt file, not a normal absent state).
 *
 * The exact-`true` check is load-bearing, not incidental: a disabled plugin
 * (`false`) must NOT surface its skills as inventory entries, or a stale
 * collision against a since-disabled plugin would resurface as a false
 * positive.
 */
export function readEnabledPluginIds(settingsPath: string, warnings: ScanWarning[]): string[] {
  if (!fs.existsSync(settingsPath)) return []

  let raw: string
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warnings.push({
      code: WARNING_CODES.PARSE_FAILED,
      message: `${settingsPath} is not valid JSON; plugin-skill scan skipped`,
      context: { path: settingsPath },
    })
    return []
  }

  if (!parsed || typeof parsed !== 'object') return []
  const enabledPlugins = (parsed as Record<string, unknown>)['enabledPlugins']
  if (!enabledPlugins || typeof enabledPlugins !== 'object') return []

  return Object.entries(enabledPlugins as Record<string, unknown>)
    .filter(([, value]) => value === true)
    .map(([id]) => id)
}

/**
 * Resolve `~/.skillsmith/manifest.json` and return the parsed object, or
 * `null` if absent / unreadable. Scanner uses this to populate
 * `entry.meta.author` for installed skills.
 */
export function loadManifest(manifestPath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(manifestPath)) return null
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Look up an `author` (and `tags`) for a given skill identifier in the
 * manifest. Manifest shape varies — be tolerant: walk the top-level keys
 * and any obvious `skills` array/object.
 */
export function lookupAuthor(
  manifest: Record<string, unknown> | null,
  identifier: string
): { author?: string; tags?: string[] } {
  if (!manifest) return {}

  // Many manifest shapes possible; check common ones.
  const skills = (manifest.skills ?? manifest.installed) as unknown
  if (Array.isArray(skills)) {
    for (const s of skills) {
      if (
        s &&
        typeof s === 'object' &&
        ((s as Record<string, unknown>).id === identifier ||
          (s as Record<string, unknown>).name === identifier)
      ) {
        const rec = s as Record<string, unknown>
        return {
          author: typeof rec.author === 'string' ? rec.author : undefined,
          tags: Array.isArray(rec.tags) ? (rec.tags as string[]) : undefined,
        }
      }
    }
  }
  if (skills && typeof skills === 'object') {
    const rec = (skills as Record<string, unknown>)[identifier]
    if (rec && typeof rec === 'object') {
      const r = rec as Record<string, unknown>
      return {
        author: typeof r.author === 'string' ? r.author : undefined,
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : undefined,
      }
    }
  }
  return {}
}

/**
 * Cross-platform mtime read. Returns `undefined` on stat failure rather
 * than throwing — mtime is informational for ordering, not load-bearing.
 */
export function readMtime(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Resolve absolute path joining `dir + filename`. Centralized so future
 * portability work (E-ANTI-1 v2) can swap in a relative-to-home derivation.
 */
export function joinPath(dir: string, filename: string): string {
  return path.join(dir, filename)
}

/**
 * Rejects path separators, `.`/`..` segments, and empty strings — an
 * `enabledPlugins` id component is an unvalidated settings-file KEY, not
 * something guaranteed traversal-free upstream of the plugin scanner
 * (SMI-6228 Source 5, cross-provider review finding GPT-5.6-Sol). Moved
 * here from `local-inventory.ts` to keep that file under the 500-line cap.
 */
export function isSafePathComponent(component: string): boolean {
  return (
    component.length > 0 &&
    component !== '.' &&
    component !== '..' &&
    !component.includes('/') &&
    !component.includes('\\')
  )
}

/**
 * True when `candidate`, once resolved to its REAL (symlink-followed) path,
 * is `root` or nested under it. Lexical `path.resolve` doesn't follow
 * symlinks, so a symlinked cache subdirectory could escape a purely-lexical
 * check even though `readdirSync`/`readFileSync` would then genuinely
 * follow it outside (GPT-5.6-Sol review finding). A nonexistent path makes
 * `realpathSync` throw — treated as "not within root" (fail-soft, same as
 * the caller's existing missing-directory skip).
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  let resolvedRoot: string
  let resolvedCandidate: string
  try {
    resolvedRoot = fs.realpathSync(root)
    resolvedCandidate = fs.realpathSync(candidate)
  } catch {
    return false
  }
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep)
}

/**
 * `parseYamlFrontmatter` returns `string | string[] | undefined` for
 * description (depending on block-scalar syntax). Normalize to a single
 * string for downstream consumers.
 */
export function coerceDescription(value: unknown): string | undefined {
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

/**
 * Core directory walk shared by every "one SKILL.md per subdirectory" scan
 * source (`local-inventory.ts`'s Source 1/5/6 wrappers): one entry per
 * subdirectory, from `SKILL.md` frontmatter when present, else the
 * directory name (with a soft warning). Returns entries with
 * `client`/`origin`/`pluginId` unset — callers tag their own. Moved here
 * from `local-inventory.ts` to keep that file under the 500-line cap.
 */
export function scanSkillsDirEntries(
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
