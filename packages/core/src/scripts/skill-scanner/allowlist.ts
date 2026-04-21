/**
 * SMI-4396: Imported-skills security allowlist.
 *
 * Loads data/skills-security-allowlist.json and produces an AllowlistMatcher
 * that shouldQuarantine + scanSkill consult to drop known false-positive
 * findings from the quarantine predicate.
 *
 * Design invariants:
 * - Per-(skillId, findingType, messagePattern, matchField) scope — never whole-skill bypass.
 * - 90-day expiry enforced at match time; expired entries behave as absent.
 * - ReDoS-hardened: load-time regex validation rejects nested quantifiers and
 *   unbounded wildcards; runtime uses safeRegexTest with length cap.
 * - Fail-safe toward quarantine: malformed entries throw at load; unknown
 *   matchField rejects.
 */

import * as fs from 'fs'
import { safeRegexCheck } from '../../security/scanner/regex-utils.js'
import type { AllowlistEntry, AllowlistFile, AllowlistMatcher, SecurityFinding } from './types.js'

const REQUIRED_ENTRY_FIELDS: Array<keyof AllowlistEntry> = [
  'skillId',
  'findingType',
  'messagePattern',
  'reason',
  'reviewedBy',
  'reviewedAt',
  'expiresAt',
]

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Reject regex patterns known to cause catastrophic backtracking.
 * Callers must catch; signals a bad allowlist file at load time.
 */
function validateRegexSafety(pattern: string, entryIndex: number): void {
  // Nested quantifier: (x+)+, (x*)*, (x+)*, etc.
  if (/\([^)]*[*+?][^)]*\)[*+?]/.test(pattern)) {
    throw new Error(
      `Allowlist entry #${entryIndex} messagePattern has nested quantifier (ReDoS risk): ${pattern}`
    )
  }
  // Unbounded greedy wildcard outside a character class: .* or .+ without upper bound.
  // Character-class forms like [^x]* are allowed since they bound the repeated set.
  if (/(?<!\[[^\]]*)\.[*+](?!\?)/.test(pattern)) {
    throw new Error(
      `Allowlist entry #${entryIndex} messagePattern has unbounded .*/.+ (ReDoS risk). ` +
        `Use bounded form like .{0,100}? or a character class instead: ${pattern}`
    )
  }
  // Compile to surface any other regex syntax errors up-front.
  try {
    new RegExp(pattern)
  } catch (err) {
    throw new Error(
      `Allowlist entry #${entryIndex} messagePattern is invalid regex: ${(err as Error).message}`
    )
  }
}

function validateEntryShape(entry: unknown, entryIndex: number): AllowlistEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`Allowlist entry #${entryIndex} is not an object`)
  }
  const e = entry as Record<string, unknown>
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
      throw new Error(
        `Allowlist entry #${entryIndex} missing or empty required field: ${String(field)}`
      )
    }
  }
  if (e.matchField !== undefined && e.matchField !== 'message' && e.matchField !== 'location') {
    throw new Error(
      `Allowlist entry #${entryIndex} matchField must be 'message' or 'location', got: ${String(e.matchField)}`
    )
  }
  if (!DATE_PATTERN.test(e.reviewedAt as string)) {
    throw new Error(
      `Allowlist entry #${entryIndex} reviewedAt must be YYYY-MM-DD, got: ${String(e.reviewedAt)}`
    )
  }
  if (!DATE_PATTERN.test(e.expiresAt as string)) {
    throw new Error(
      `Allowlist entry #${entryIndex} expiresAt must be YYYY-MM-DD, got: ${String(e.expiresAt)}`
    )
  }
  validateRegexSafety(e.messagePattern as string, entryIndex)
  return e as unknown as AllowlistEntry
}

/**
 * Parse a raw allowlist file object. Throws on malformed shape, invalid
 * dates, unsafe regex, or missing required fields.
 */
export function parseAllowlistFile(raw: unknown): AllowlistFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Allowlist file root must be an object')
  }
  const r = raw as Record<string, unknown>
  if (r.version !== 1) {
    throw new Error(`Unsupported allowlist file version: ${String(r.version)} (expected 1)`)
  }
  if (typeof r.generatedAt !== 'string') {
    throw new Error('Allowlist file missing generatedAt (ISO-8601 string)')
  }
  if (!Array.isArray(r.allowlist)) {
    throw new Error('Allowlist file .allowlist must be an array')
  }
  const entries = r.allowlist.map((entry, i) => validateEntryShape(entry, i))
  return { version: 1, generatedAt: r.generatedAt, allowlist: entries }
}

/**
 * Matcher implementation backed by a pre-validated entry list.
 */
class EntryListMatcher implements AllowlistMatcher {
  private readonly compiledEntries: Array<{
    entry: AllowlistEntry
    regex: RegExp
    expiresAt: Date
  }>

  constructor(entries: AllowlistEntry[]) {
    this.compiledEntries = entries.map((entry) => ({
      entry,
      regex: new RegExp(entry.messagePattern),
      expiresAt: new Date(`${entry.expiresAt}T23:59:59Z`),
    }))
  }

  isAllowed(skillId: string, finding: SecurityFinding, today: Date = new Date()): boolean {
    for (const compiled of this.compiledEntries) {
      const { entry, regex, expiresAt } = compiled
      if (entry.skillId !== skillId) continue
      if (entry.findingType !== finding.type) continue
      if (today > expiresAt) {
        // Expired entry: log once per (skillId, findingType) and fall through to next.
        logExpiryWarning(entry)
        continue
      }
      const field = entry.matchField ?? 'message'
      const target = field === 'location' ? (finding.location ?? '') : finding.message
      if (safeRegexCheck(regex, target)) {
        return true
      }
    }
    return false
  }
}

/** Tracks already-logged expiry warnings so we don't spam on every finding. */
const loggedExpirySet = new Set<string>()

function logExpiryWarning(entry: AllowlistEntry): void {
  const key = `${entry.skillId}::${entry.findingType}::${entry.expiresAt}`
  if (loggedExpirySet.has(key)) return
  loggedExpirySet.add(key)
  console.warn(
    `allowlist:expired skillId=${entry.skillId} findingType=${entry.findingType} ` +
      `expiredAt=${entry.expiresAt} — entry behaving as absent (fail-safe). ` +
      `Refresh reviewedAt/expiresAt in data/skills-security-allowlist.json or remove.`
  )
}

/** Reset expiry-warning dedupe cache. Exposed for tests. */
export function _resetExpiryWarningCache(): void {
  loggedExpirySet.clear()
}

/**
 * Empty matcher — returns false for every check. Used when the allowlist file
 * is absent and for callers that want to opt out without conditional plumbing.
 */
export const EMPTY_ALLOWLIST: AllowlistMatcher = {
  isAllowed(): boolean {
    return false
  },
}

/**
 * Load + validate an allowlist JSON file and return a matcher.
 *
 * If `path` does not exist, returns EMPTY_ALLOWLIST. A malformed file throws
 * (fail-safe toward quarantine — never silently skip validation).
 */
export function loadAllowlist(path: string): AllowlistMatcher {
  if (!fs.existsSync(path)) {
    return EMPTY_ALLOWLIST
  }
  const raw = fs.readFileSync(path, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Allowlist file ${path} is not valid JSON: ${(err as Error).message}`)
  }
  const file = parseAllowlistFile(parsed)
  return new EntryListMatcher(file.allowlist)
}

/** Build a matcher from an in-memory entry list (test + inline use). */
export function buildMatcher(entries: AllowlistEntry[]): AllowlistMatcher {
  // Run the same validation pass as file load to catch unsafe patterns.
  entries.forEach((entry, i) => validateEntryShape(entry, i))
  return new EntryListMatcher(entries)
}
