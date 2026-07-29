/**
 * @fileoverview Type vocabulary for the local security audit (SMI-5541 Wave
 *               2C, Option 1 — client-side continuous audit engine).
 * @module @skillsmith/mcp-server/audit/security-audit.types
 *
 * The security audit is the PRODUCER that feeds the shipped 2A comparator
 * (`compareScanReports`, SMI-5535). It scans each installed skill's on-disk
 * content with `@skillsmith/core`'s `SecurityScanner`, compares the current
 * `ScanReport` against a per-skill baseline persisted across runs, and emits
 * one finding per skill whose security posture is hostile / suspicious /
 * currently-failing. Mirrors `rot-detector.types.ts`'s shape (a finding type
 * plus an options type) so the report writer + digest can consume it
 * uniformly.
 */

import type { SecurityFinding } from '@skillsmith/core'

import type { InventoryEntry } from '../utils/local-inventory.types.js'
import type { AcceptanceRecord, AcceptanceWarning } from './security-acceptance.types.js'

/**
 * The three user-facing security verdicts.
 *
 * - `hostile`   — a previously-passing skill introduced new high/critical
 *   findings (or crossed the risk threshold): a genuine benign→malicious
 *   rug-pull, per `compareScanReports`.
 * - `suspicious`— an update materially worsened the skill's risk without
 *   meeting the hostile bar (new medium findings or a material score rise).
 * - `malicious` — the skill FAILS the scanner right now and we have no prior
 *   baseline to prove a transition (freshly-tracked or side-loaded skill that
 *   never passed through the install-time quarantine gate). Not a rug-pull,
 *   but an actively-flagged skill worth surfacing.
 */
export type SecurityVerdict = 'hostile' | 'suspicious' | 'malicious'

/**
 * A single security finding for one inventory entry. One finding per skill —
 * the strongest verdict wins (hostile > suspicious; `malicious` only applies
 * when there is no baseline to compare against).
 */
export interface SecurityAuditFinding {
  kind: 'security'
  /** Stable per-finding id — sha256(auditId:source_path:verdict).slice(0,16). */
  securityId: string
  /** The scanned entry (skill/command/agent). */
  entry: InventoryEntry
  verdict: SecurityVerdict
  /**
   * Digest severity, derived from the verdict: `hostile`/`malicious` →
   * `critical`, `suspicious` → `medium`. Kept explicit so the email digest +
   * report writer can sort/threshold without re-deriving.
   */
  severity: 'critical' | 'medium'
  /** Current scan risk score (0-100). */
  riskScore: number
  /**
   * `current.riskScore - previous.riskScore` for hostile/suspicious; `null`
   * for `malicious` (no prior baseline).
   */
  riskDelta: number | null
  /** How many findings are new vs the baseline (0 for `malicious`). */
  newFindingCount: number
  /** One concrete human-readable sentence citing the deciding signal. */
  reason: string
  /**
   * SMI-5883 Wave 2: present iff this skill's `malicious` verdict was
   * suppressed because EVERY finding on it has an active local acceptance
   * (§3g). The finding itself is NOT removed from `findings[]` (INV-5 --
   * accepted findings are shown as accepted, never silently hidden); the CLI
   * renders it under a distinct "ACCEPTED" section instead of "FAILING".
   * `acceptedAt`/`reason` reflect the MOST RECENTLY accepted covering
   * record. Never set for `hostile`/`suspicious` (INV-2 -- acceptance never
   * suppresses those).
   */
  accepted?: {
    count: number
    acceptedAt: string
    reason: string
  }
}

/**
 * SMI-5883 Wave 2 (§3a): one candidate finding for `--accept` resolution.
 * Raw and verdict-independent -- every finding on every scanned skill is a
 * candidate, INCLUDING skills whose report currently passes (D-10): a later
 * content change could push that same finding across the bar, and
 * pre-accepting it is a legitimate user action.
 */
export interface Candidate {
  /** Primary key -- see `computeAcceptKey` (`@skillsmith/mcp-server/audit/security-acceptance`). Full 64-hex. */
  acceptKey: string
  /** Absolute inventory `source_path` of the owning skill. */
  sourcePath: string
  /** Human identifier of the owning skill. */
  identifier: string
  /** sha256 of the exact scanned content. */
  contentDigest: string
  /** 64-hex fingerprint of this specific finding. */
  findingFingerprint: string
  /** `SCANNER_RULESET_VERSION` this candidate was derived under. */
  rulesetVersion: string
  /** The raw, unmodified finding. */
  finding: SecurityFinding
  /** `report.passed` for the owning skill (D-10 -- candidacy does not depend on the verdict). */
  skillPassed: boolean
  /** ISO-8601 acceptedAt iff an active acceptance matches this candidate's key; else `null`. */
  acceptedAt: string | null
  /**
   * Count of byte-identical findings across the WHOLE RUN (not necessarily
   * the same skill -- keying is content-based, per D-1) that collapsed into
   * this one candidate (H-15e). 1 when there is no collision. Code-review
   * round 2: this can legitimately span more than one skill (see
   * `affectedSkills`) when two different skills happen to share byte-
   * identical scanned content and the same finding.
   */
  duplicateCount: number
  /**
   * Distinct (sourcePath, identifier) pairs whose finding collapsed into
   * this candidate -- almost always just the one recorded in `sourcePath`/
   * `identifier` above. Code-review round 2 finding: keying purely on
   * content (D-1) means a genuinely different skill with byte-identical
   * content and the same finding collapses into this SAME candidate --
   * accepting it suppresses the finding on EVERY skill listed here, not
   * only the first one recorded. Surfaced so the CLI can disclose this
   * rather than silently suppressing an unseen skill.
   */
  affectedSkills: ReadonlyArray<{ sourcePath: string; identifier: string }>
}

/** Per-run counts for the summary + the email digest header. */
export interface SecurityAuditSummary {
  /** Entries freshly scanned this run (content new or changed since baseline). */
  scanned: number
  /** Entries whose content was byte-identical to the baseline (verified, not re-scanned). */
  unchanged: number
  /**
   * Entries that could NOT be audited this run — content unreadable, or the
   * scan threw. Surfaced separately (never folded into `unchanged`) so the
   * user knows coverage was incomplete; the skill's prior baseline is
   * preserved rather than pruned.
   */
  unreadable: number
  hostile: number
  suspicious: number
  malicious: number
  /** SMI-5883 Wave 2: count of skills whose `malicious` verdict was suppressed this run via full acceptance (§3g). */
  accepted: number
  /** SMI-5883 Wave 2: total uncapped candidate count across the whole run (INV-6 -- every candidate is resolvable regardless of what was rendered). */
  candidateTotal: number
  durationMs: number
}

/** Result returned to CLI / MCP / digest callers. */
export interface RunSecurityAuditResult {
  /** ULID for this run (folded into each finding's `securityId`). */
  auditId: string
  findings: SecurityAuditFinding[]
  summary: SecurityAuditSummary
  /**
   * SMI-5883 Wave 2: the UNCAPPED candidate index -- the ONLY resolution
   * surface for `--accept` (§3f). Not JSON-serializable as-is (a `Map`); the
   * CLI's own render layer projects it into the paginated `candidates[]` +
   * `pagination` JSON fields. Absent (empty Map) when
   * `SKILLSMITH_AUDIT_ACCEPT_DISABLE=1`.
   */
  candidateIndex: Map<string, Candidate>
  /** SMI-5883 Wave 2: the full acceptance store contents (<=500 by construction) -- `--json`'s `acceptances` field and `--revoke`'s resolution surface (D-9). */
  acceptances: AcceptanceRecord[]
  /** SMI-5883 Wave 2: structured, machine-triageable acceptance-store warnings (fail-open causes, GC counts). Empty when the store was clean or the kill switch is set. */
  warnings: AcceptanceWarning[]
}

/**
 * PUBLIC input for {@link runSecurityAudit}. All fields optional.
 *
 * Deliberately holds NO injectable overrides for the scanner, the content
 * reader, or the baseline path: the production entry point must not be able to
 * accept a stub scanner that neuters the audit. Those seams live in the
 * non-exported `SecurityAuditSeams` type in `security-audit.ts`, reachable
 * only by the co-located test.
 */
export interface RunSecurityAuditOptions {
  /** Override `os.homedir()` — also relocates the default baseline path. */
  homeDir?: string
  /**
   * Inject a pre-computed inventory (e.g. reuse `runInventoryAudit`'s scan).
   * When omitted, `runSecurityAudit` scans the inventory itself.
   */
  inventory?: InventoryEntry[]
  /**
   * Scanner risk threshold. Recorded in each baseline entry; a skill whose
   * baseline was produced under a DIFFERENT threshold is re-scanned rather
   * than trusted (the `compareScanReports` caller contract). Defaults to 40 —
   * the `SecurityScanner` + comparator default.
   */
  riskThreshold?: number
  /**
   * SMI-5883 Wave 2: override the acceptance-store path (test seam +
   * `homeDir`-relative default override; NOT security-sensitive the way the
   * scanner/reader seams are, since it only relocates where local acceptance
   * judgments are read from). Defaults to `defaultAcceptancePath(homeDir)`.
   */
  acceptancePath?: string
}
