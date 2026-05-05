// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * @fileoverview Types for the Enterprise scheduled-scan governance pass.
 * @module @skillsmith/enterprise/audit/scheduled-scan.types
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §7
 * (Wave 4 PR 6/6, SMI-4590).
 *
 * The runner exists so an Enterprise admin's scheduled job (cron, GitHub
 * Actions, manual invocation) can produce a governance-grade audit pass
 * with `applyExclusions: false` — un-filtered findings for policy review.
 *
 * The runner is idempotent within a configurable cache window (default 5
 * minutes, env `SKILLSMITH_SCHEDULED_AUDIT_CACHE_MIN`) so duplicate fires
 * (CI retries, manual reruns) don't double-scan.
 */

/**
 * Output sink for the scheduled-scan result. Webhook delivery is
 * best-effort: a delivery failure falls back to file output and records
 * the failure in `~/.skillsmith/scheduled-scan-webhook-failures.log`
 * (scheme+host only — never path/query, which can carry secrets).
 */
export type ScheduledScanOutput = { kind: 'file'; path?: string } | { kind: 'webhook'; url: string }

export interface ScheduledScanOptions {
  /**
   * Override `os.homedir()`. Tests stub this to a tmp dir.
   */
  homeDir?: string

  /**
   * Optional project CLAUDE.md to include in the inventory scan. Mirrors
   * `runInventoryAudit`'s `projectDir` plumbing.
   */
  projectDir?: string

  /**
   * Output destination. Defaults to `{ kind: 'file' }` which writes the
   * canonical audit dir under `~/.skillsmith/audits/<auditId>/`. When
   * `kind === 'webhook'` the runner POSTs the result JSON to `url`; on
   * delivery failure falls back to file output.
   *
   * URL secrets in path/query are NEVER logged on failure — only
   * `<scheme>://<host>` is recorded.
   */
  output?: ScheduledScanOutput

  /**
   * Idempotency cache window in minutes. A re-run within this window
   * returns the cached `auditId` + `reportPath` without re-invoking
   * `runInventoryAudit`. Default: 5 minutes (configurable via env
   * `SKILLSMITH_SCHEDULED_AUDIT_CACHE_MIN`, clamped `[1, 1440]`).
   *
   * The cache key is the most-recent `~/.skillsmith/audits/<auditId>/`
   * mtime under the resolved `homeDir`, so each environment has its
   * own cache — no global racing.
   */
  cacheMinutes?: number

  /**
   * Force a re-run even if the cache window says we're current. Useful
   * for manual `--force` re-runs by Enterprise admins.
   */
  force?: boolean
}

export interface ScheduledScanResult {
  /** Audit ID (cached or freshly generated). */
  auditId: string

  /** Absolute path to the rendered `report.md`. */
  reportPath: string

  /**
   * `true` if the result came from the idempotency cache (i.e. a recent
   * audit dir was found and re-used). `false` if a fresh audit was run.
   */
  cached: boolean

  /** Counts surfaced for the runner caller (e.g. CI workflow summary). */
  counts: {
    exact: number
    generic: number
    semantic: number
  }

  /**
   * Output disposition. `'file'` means the audit dir is the only output.
   * `'webhook'` means the webhook delivery succeeded. `'webhook_fallback'`
   * means the webhook failed and the file output was used; the failure
   * was logged to `~/.skillsmith/scheduled-scan-webhook-failures.log`.
   */
  outputDisposition: 'file' | 'webhook' | 'webhook_fallback'

  /** Total wall-clock duration in milliseconds. */
  durationMs: number
}

/**
 * Typed error codes the runner may surface. Surfaced via thrown
 * `ScheduledScanError` (see `scheduled-scan.ts`).
 */
export type ScheduledScanErrorCode =
  | 'scheduled_scan.audit_failed'
  | 'scheduled_scan.invalid_cache_minutes'
  | 'scheduled_scan.invalid_output'
