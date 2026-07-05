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

import type { InventoryEntry } from '../utils/local-inventory.types.js'

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
  durationMs: number
}

/** Result returned to CLI / MCP / digest callers. */
export interface RunSecurityAuditResult {
  /** ULID for this run (folded into each finding's `securityId`). */
  auditId: string
  findings: SecurityAuditFinding[]
  summary: SecurityAuditSummary
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
}
