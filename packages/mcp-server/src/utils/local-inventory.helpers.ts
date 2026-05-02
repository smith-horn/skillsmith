/**
 * @fileoverview Helpers for the local-inventory scanner (SMI-4587 Wave 1 Step 2).
 * @module @skillsmith/mcp-server/utils/local-inventory.helpers
 *
 * Pure functions extracted to keep `local-inventory.ts` thin. CLAUDE.md
 * regex extraction lives here so the regex behavior can be tested in
 * isolation. Frontmatter helpers wrap the existing `parseYamlFrontmatter`.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

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
    meta: { description: phrase },
  }
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
