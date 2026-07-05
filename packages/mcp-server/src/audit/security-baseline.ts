/**
 * @fileoverview Per-skill security baseline store (SMI-5541 Wave 2C).
 * @module @skillsmith/mcp-server/audit/security-baseline
 *
 * The security audit needs the PREVIOUS `ScanReport` per skill to feed
 * `compareScanReports(previous, current)` and detect a benign→malicious
 * rug-pull. No cross-run store existed (`audit-history.ts` persists only
 * whole-run collision results under a fresh ULID each run) — this module is
 * that store: a single JSON keyed by the skill's absolute `source_path`,
 * holding the last scan's content hash + report.
 *
 * Fail-safe by construction: a missing OR corrupt baseline loads as EMPTY
 * (never throws) — the audit then treats every skill as first-sight
 * (`malicious` if it fails now, otherwise it establishes a fresh baseline).
 * That degrades toward showing findings, never toward silently hiding a
 * rug-pull because a JSON blob was unreadable.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ScanReport, SecurityFinding } from '@skillsmith/core'

// `RiskScoreBreakdown` is not re-exported from the `@skillsmith/core` root
// barrel (only `ScanReport`/`SecurityFinding` are), so derive the breakdown
// type from `ScanReport` itself — no dependency on the barrel exporting the
// breakdown type by name.
type RiskScoreBreakdown = ScanReport['riskBreakdown']

/** Current on-disk schema version. Bumped only on a breaking shape change. */
export const SECURITY_BASELINE_VERSION = 1 as const

/**
 * A `ScanReport` with `scannedAt` serialized to an ISO string (JSON has no
 * Date). Everything else is JSON-native. `compareScanReports` reads only
 * `passed` / `riskScore` / `findings`, so a revived report is fully valid.
 */
export interface StoredScanReport {
  skillId: string
  passed: boolean
  findings: SecurityFinding[]
  riskScore: number
  riskBreakdown: RiskScoreBreakdown
  scannedAt: string
  scanDurationMs: number
}

/** One baseline row: the last content hash + report for a skill. */
export interface SecurityBaselineEntry {
  contentHash: string
  /**
   * Risk threshold the stored `report` (and its `passed`) was produced under.
   * The unchanged fast path trusts the stored verdict only when the current
   * run's threshold matches this — otherwise the skill is re-scanned, honoring
   * the `compareScanReports` caller contract (both reports at one threshold).
   */
  threshold: number
  report: StoredScanReport
  updatedAt: string
}

/** The whole store, keyed by absolute `source_path`. */
export interface SecurityBaseline {
  version: typeof SECURITY_BASELINE_VERSION
  skills: Record<string, SecurityBaselineEntry>
}

/** Absolute path to the baseline store, `~/.skillsmith/audits/security-baseline.json`. */
export function defaultBaselinePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.skillsmith', 'audits', 'security-baseline.json')
}

/** A fresh, empty baseline. */
export function emptyBaseline(): SecurityBaseline {
  return { version: SECURITY_BASELINE_VERSION, skills: {} }
}

/**
 * Load the baseline. Returns an EMPTY baseline on any failure (absent file,
 * unreadable, invalid JSON, wrong shape, or a version we don't understand) —
 * never throws. A version mismatch is treated as empty (safe re-baseline)
 * rather than a hard error, so a forward-compat store can't wedge the audit.
 */
export function loadSecurityBaseline(baselinePath: string): SecurityBaseline {
  let raw: string
  try {
    raw = fs.readFileSync(baselinePath, 'utf-8')
  } catch {
    return emptyBaseline()
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== SECURITY_BASELINE_VERSION ||
      typeof (parsed as { skills?: unknown }).skills !== 'object' ||
      (parsed as { skills?: unknown }).skills === null
    ) {
      return emptyBaseline()
    }
    return parsed as SecurityBaseline
  } catch {
    return emptyBaseline()
  }
}

/**
 * Atomically persist the baseline (tmp write + rename, so a crash mid-write
 * never leaves a truncated store) with owner-only perms — it embeds scan
 * findings. Directory is created if absent. Best-effort: a write failure is
 * swallowed by the caller's try/catch (a lost baseline just re-establishes
 * next run); this function itself surfaces the error for tests.
 */
export function saveSecurityBaseline(baselinePath: string, baseline: SecurityBaseline): void {
  const dir = path.dirname(baselinePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Unique tmp suffix so two concurrent audits can't clobber each other's tmp.
  const tmp = `${baselinePath}.tmp-${process.pid}-${process.hrtime.bigint()}`
  fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, baselinePath)
}

/** Serialize a live `ScanReport` (Date → ISO) for storage. */
export function serializeReport(report: ScanReport): StoredScanReport {
  return {
    skillId: report.skillId,
    passed: report.passed,
    findings: report.findings,
    riskScore: report.riskScore,
    riskBreakdown: report.riskBreakdown,
    scannedAt: report.scannedAt.toISOString(),
    scanDurationMs: report.scanDurationMs,
  }
}

/** Revive a `StoredScanReport` (ISO → Date) into a `ScanReport` for comparison. */
export function reviveReport(stored: StoredScanReport): ScanReport {
  return {
    skillId: stored.skillId,
    passed: stored.passed,
    findings: stored.findings,
    riskScore: stored.riskScore,
    riskBreakdown: stored.riskBreakdown,
    scannedAt: new Date(stored.scannedAt),
    scanDurationMs: stored.scanDurationMs,
  }
}
