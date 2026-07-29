/**
 * @fileoverview Type vocabulary for the local security-acceptance store (SMI-5883 Wave 2).
 * @module @skillsmith/mcp-server/audit/security-acceptance.types
 *
 * A local, per-user JSON store letting a user mark a reviewed
 * SecurityScanner false-positive finding as "accepted" so it is suppressed
 * from future `sklx audit security` runs. Acceptance is keyed on
 * `(contentDigest, findingFingerprint, rulesetVersion)` -- NEVER on file
 * path or skill name (D-1): a path-keyed allowlist would suppress a later,
 * genuinely different hostile finding in the same file.
 *
 * Suppression is applied in the SHARED `runSecurityAudit` result assembly
 * (`security-audit.ts`), not literally only "in CLI files" as an earlier
 * version of this comment claimed (code-review round 2) -- any consumer of
 * `runSecurityAudit` (the CLI, but also any future MCP tool or the email
 * digest) sees the SAME `finding.accepted` annotation and the SAME adjusted
 * `summary.malicious`/`summary.accepted` counts. The one invariant that
 * matters is still true regardless of consumer: `compareScanReports` (the
 * rug-pull/hostile-update comparator, called earlier in that same assembly)
 * always sees the RAW, unmodified scan report -- acceptance state is
 * annotated onto `findings[]` strictly AFTER that comparison runs, never fed
 * into it.
 */

/** Current on-disk schema version. Bumped only on a breaking shape change. */
export const ACCEPTANCE_STORE_VERSION = 1 as const

/** Bounded read cap for the store file -- refuses (never crashes on) an oversized file. */
export const MAX_STORE_BYTES = 4 * 1024 * 1024 // 4 MiB
/** Max records retained on load; excess (oldest first) is dropped with a warning. */
export const MAX_RECORDS = 500

/**
 * One accepted finding. `sourcePath`/`identifier` are diagnostic display
 * fields ONLY -- matching is on `(contentDigest, findingFingerprint,
 * rulesetVersion)`, so a moved or renamed skill with identical content
 * keeps its acceptance (a judgment about content, not location).
 */
export interface AcceptanceRecord {
  /** Primary key. Full 64-hex sha256 -- see `computeAcceptKey`. Never truncated anywhere. */
  acceptKey: string
  /** Absolute inventory `source_path` of the skill at acceptance time. Diagnostic only. */
  sourcePath: string
  /** Human identifier at acceptance time. Diagnostic only. */
  identifier: string
  /** sha256 of the exact scanned content (the same function the baseline uses). */
  contentDigest: string
  /** 64-hex fingerprint of the specific finding -- see `findingFingerprint`. */
  findingFingerprint: string
  /** `SCANNER_RULESET_VERSION` at acceptance time. */
  rulesetVersion: string
  /** Display-only snapshot of the finding, for rendering without re-deriving from a stale scan. */
  display: {
    type: string
    severity: string
    message: string
    location: string | null
    lineNumber: number | null
  }
  /** ISO-8601 acceptance timestamp. */
  acceptedAt: string
  /** Free-text reason, required, 1..500 chars. */
  reason: string
}

export interface AcceptanceStore {
  version: typeof ACCEPTANCE_STORE_VERSION
  /** Monotonic counter. Foreign-writer / corruption detector -- NOT the concurrency primitive (the lock is). */
  revision: number
  /** Self-consistency checksum over the canonical serialization of `{version, revision, records}`. NOT a keyed MAC -- self-consistency only, not authenticity (D-12). */
  storeDigest: string
  records: AcceptanceRecord[]
}

/** A fresh, empty store (revision 0; digest computed lazily by the caller if ever serialized). */
export function emptyAcceptanceStore(): AcceptanceStore {
  return { version: ACCEPTANCE_STORE_VERSION, revision: 0, storeDigest: '', records: [] }
}

export type AcceptanceWarningCode =
  | 'acceptance_records_malformed'
  | 'acceptance_records_over_capacity'
  | 'acceptance_records_ruleset_expired'
  | 'acceptance_store_unreadable'
  | 'acceptance_store_oversized'
  | 'acceptance_store_digest_mismatch'
  | 'acceptance_store_write_failed'
  | 'acceptance_store_foreign_revision'

/** Structured, machine-triageable warning. `count` is present for the three per-record codes. */
export interface AcceptanceWarning {
  code: AcceptanceWarningCode
  count?: number
  message: string
}
