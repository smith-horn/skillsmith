/**
 * SMI-4408: Indexer blocklist for non-skill repos.
 *
 * Loads data/indexer-blocklist.json and produces a BlocklistMatcher consumed
 * by the main() CLI in import-github-skills.ts. The filter runs between
 * deduplicateSkills() and saveOutput() so blocked repos never reach
 * data/imported-skills.json.
 *
 * Tactical fix for known-bad repos. The structural fix (require a
 * signal-of-intent signal per ingested repo) is tracked as Tier 2
 * follow-up under ADR-109 SPARC.
 *
 * Design invariants:
 * - Exact-match only (`owner/name`, case-sensitive) — no wildcards. Keeps
 *   scope tight and auditable. If wildcards become necessary, file a
 *   follow-up issue rather than widening this module.
 * - Malformed entries throw at load (fail-safe toward ingestion rejection
 *   would be wrong here — ingestion should NOT proceed with an unverified
 *   blocklist file).
 * - version=1 contract: future schema changes must bump and handle migration.
 */

import * as fs from 'fs'

export interface BlocklistEntry {
  /** GitHub full_name: `owner/name`. Exact match, case-sensitive. */
  repo: string
  /** Why this entry is blocked — human-readable, required. */
  reason: string
  /** Who added the entry — required for audit trail. */
  addedBy: string
  /** YYYY-MM-DD string — required. */
  addedAt: string
}

export interface BlocklistFile {
  version: 1
  updatedAt: string
  blocked: BlocklistEntry[]
}

export interface BlocklistMatcher {
  /**
   * True when `repo` (format: `owner/name`) appears in the blocklist. Exact
   * match, case-sensitive.
   */
  isBlocked(repo: string): boolean
  /** Expose entries for audit-logging in the import summary. */
  entries(): readonly BlocklistEntry[]
}

const REQUIRED_ENTRY_FIELDS: Array<keyof BlocklistEntry> = ['repo', 'reason', 'addedBy', 'addedAt']

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

function validateEntryShape(entry: unknown, entryIndex: number): BlocklistEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`Blocklist entry #${entryIndex} is not an object`)
  }
  const e = entry as Record<string, unknown>
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
      throw new Error(
        `Blocklist entry #${entryIndex} missing or empty required field: ${String(field)}`
      )
    }
  }
  if (!REPO_PATTERN.test(e.repo as string)) {
    throw new Error(
      `Blocklist entry #${entryIndex} repo must be 'owner/name' (GitHub full_name), got: ${String(e.repo)}`
    )
  }
  if (!DATE_PATTERN.test(e.addedAt as string)) {
    throw new Error(
      `Blocklist entry #${entryIndex} addedAt must be YYYY-MM-DD, got: ${String(e.addedAt)}`
    )
  }
  return e as unknown as BlocklistEntry
}

/**
 * Parse a raw blocklist file object. Throws on malformed shape or missing
 * required fields. Callers must catch.
 */
export function parseBlocklistFile(raw: unknown): BlocklistFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Blocklist file root must be an object')
  }
  const r = raw as Record<string, unknown>
  if (r.version !== 1) {
    throw new Error(`Unsupported blocklist file version: ${String(r.version)} (expected 1)`)
  }
  if (typeof r.updatedAt !== 'string' || !DATE_PATTERN.test(r.updatedAt)) {
    throw new Error(`Blocklist file updatedAt must be YYYY-MM-DD, got: ${String(r.updatedAt)}`)
  }
  if (!Array.isArray(r.blocked)) {
    throw new Error('Blocklist file .blocked must be an array')
  }
  const entries = r.blocked.map((entry, i) => validateEntryShape(entry, i))
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.repo)) {
      throw new Error(`Blocklist file contains duplicate entry: ${entry.repo}`)
    }
    seen.add(entry.repo)
  }
  return { version: 1, updatedAt: r.updatedAt, blocked: entries }
}

class SetBackedMatcher implements BlocklistMatcher {
  private readonly blocked: Set<string>
  private readonly entryList: readonly BlocklistEntry[]

  constructor(entries: BlocklistEntry[]) {
    this.blocked = new Set(entries.map((e) => e.repo))
    this.entryList = entries
  }

  isBlocked(repo: string): boolean {
    return this.blocked.has(repo)
  }

  entries(): readonly BlocklistEntry[] {
    return this.entryList
  }
}

/**
 * Empty matcher — blocks nothing. Used when the blocklist file is absent or
 * callers want to opt out without conditional plumbing.
 */
export const EMPTY_BLOCKLIST: BlocklistMatcher = {
  isBlocked(): boolean {
    return false
  },
  entries(): readonly BlocklistEntry[] {
    return []
  },
}

/**
 * Load + validate a blocklist JSON file and return a matcher.
 *
 * If `path` does not exist, returns EMPTY_BLOCKLIST (no-op). A malformed
 * file throws so the importer refuses to proceed with a corrupt blocklist.
 */
export function loadBlocklist(path: string): BlocklistMatcher {
  if (!fs.existsSync(path)) {
    return EMPTY_BLOCKLIST
  }
  const raw = fs.readFileSync(path, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Blocklist file ${path} is not valid JSON: ${(err as Error).message}`)
  }
  const file = parseBlocklistFile(parsed)
  return new SetBackedMatcher(file.blocked)
}

/** Build a matcher from an in-memory entry list (test + inline use). */
export function buildBlocklist(entries: BlocklistEntry[]): BlocklistMatcher {
  entries.forEach((entry, i) => validateEntryShape(entry, i))
  return new SetBackedMatcher(entries)
}
