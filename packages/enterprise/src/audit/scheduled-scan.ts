// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * @fileoverview Enterprise scheduled-scan governance runner.
 * @module @skillsmith/enterprise/audit/scheduled-scan
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §7
 * (Wave 4 PR 6/6, SMI-4590).
 *
 * Composes `runInventoryAudit({ deep: true, applyExclusions: false })`
 * with:
 *   - Idempotency cache (default 5 min, env-overridable)
 *   - Output dispatch (file default OR webhook fallback-to-file)
 *   - Webhook URL secret stripping on failure logging
 *
 * Why `applyExclusions: false`: the governance pass MUST see un-filtered
 * findings so policy enforcement doesn't get blindfolded by a user-curated
 * exclusions file. The exclusions file remains useful for the per-session
 * Team-tier hook (PR 6's session-start helper) — that's where users opt
 * into "this collision is fine".
 *
 * Privacy: URL path/query is stripped before logging. Webhook URLs of the
 * form `https://hooks.slack.com/services/T123/B456/SECRETKEY` only have
 * `https://hooks.slack.com` recorded on delivery failure.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ScheduledScanErrorCode,
  ScheduledScanOptions,
  ScheduledScanResult,
} from './scheduled-scan.types.js'

/**
 * Resolve `runInventoryAudit` via dynamic import. Avoids a hard package
 * cycle: `@skillsmith/mcp-server` already declares
 * `@skillsmith/enterprise` as an optional peer dep, so a static
 * `import { runInventoryAudit } from '@skillsmith/mcp-server/audit'`
 * here would close the cycle. Dynamic import keeps the cycle lazy and
 * lets the type system see the function shape via the `import type` of
 * the helper's options/result while runtime resolution stays deferred.
 */
type RunInventoryAuditFn = (opts: {
  deep?: boolean
  applyExclusions?: boolean
  tier?: 'community' | 'individual' | 'team' | 'enterprise'
  homeDir?: string
  projectDir?: string
}) => Promise<{
  auditId: string
  reportPath: string
  exactCollisions: unknown[]
  genericFlags: unknown[]
  semanticCollisions: unknown[]
}>

async function loadRunInventoryAudit(): Promise<RunInventoryAuditFn> {
  // Module path is a static string so bundlers can analyze it; the
  // dynamic-import wrapping is only what defers cycle resolution.
  const mod = (await import('@skillsmith/mcp-server/audit')) as {
    runInventoryAudit: RunInventoryAuditFn
  }
  return mod.runInventoryAudit
}

const DEFAULT_CACHE_MINUTES = 5
const MIN_CACHE_MINUTES = 1
const MAX_CACHE_MINUTES = 1440 // 24h
const WEBHOOK_TIMEOUT_MS = 10_000

/**
 * Typed error for runner failures. Carries a `code` field so callers (CI
 * workflows, Enterprise admin tooling) can branch without string-matching.
 */
export class ScheduledScanError extends Error {
  readonly code: ScheduledScanErrorCode

  constructor(code: ScheduledScanErrorCode, message: string) {
    super(message)
    this.name = 'ScheduledScanError'
    this.code = code
  }
}

/**
 * Run the Enterprise governance audit. Idempotent within the cache
 * window — returns the cached `auditId` + `reportPath` if a recent audit
 * dir is present.
 *
 * @throws {ScheduledScanError} On underlying audit failure or invalid
 *   options. Webhook delivery failures do NOT throw — they fall back to
 *   file output and surface via `outputDisposition: 'webhook_fallback'`.
 */
export async function runScheduledScan(
  opts: ScheduledScanOptions = {}
): Promise<ScheduledScanResult> {
  const startedAt = process.hrtime.bigint()
  const homeDir = opts.homeDir ?? os.homedir()
  const cacheMinutes = resolveCacheMinutes(opts.cacheMinutes)

  // Idempotency cache check — keyed on the resolved homeDir's audits dir.
  if (!opts.force) {
    const cached = await findRecentAudit(homeDir, cacheMinutes)
    if (cached !== null) {
      return {
        ...cached,
        cached: true,
        outputDisposition: 'file',
        durationMs: nsToMs(process.hrtime.bigint() - startedAt),
      }
    }
  }

  // Fresh audit. Governance mode: deep + un-filtered. The
  // `runInventoryAudit` import is dynamic to avoid a hard package
  // cycle (mcp-server lists enterprise as an optional peer dep).
  let auditResult
  try {
    const runInventoryAudit = await loadRunInventoryAudit()
    auditResult = await runInventoryAudit({
      deep: true,
      applyExclusions: false,
      tier: 'enterprise',
      homeDir,
      ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ScheduledScanError(
      'scheduled_scan.audit_failed',
      `Inventory audit failed during scheduled scan: ${message}`
    )
  }

  const counts = {
    exact: auditResult.exactCollisions.length,
    generic: auditResult.genericFlags.length,
    semantic: auditResult.semanticCollisions.length,
  }

  // Output dispatch.
  const output = opts.output ?? { kind: 'file' as const }
  let outputDisposition: ScheduledScanResult['outputDisposition'] = 'file'

  if (output.kind === 'webhook') {
    const webhookOk = await deliverWebhook(output.url, {
      auditId: auditResult.auditId,
      reportPath: auditResult.reportPath,
      counts,
    })
    if (webhookOk) {
      outputDisposition = 'webhook'
    } else {
      await logWebhookFailure(homeDir, output.url, auditResult.auditId)
      outputDisposition = 'webhook_fallback'
    }
  }

  return {
    auditId: auditResult.auditId,
    reportPath: auditResult.reportPath,
    cached: false,
    counts,
    outputDisposition,
    durationMs: nsToMs(process.hrtime.bigint() - startedAt),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCacheMinutes(explicit: number | undefined): number {
  const candidate = explicit ?? readEnvCacheMinutes() ?? DEFAULT_CACHE_MINUTES
  if (!Number.isFinite(candidate) || candidate < MIN_CACHE_MINUTES) {
    throw new ScheduledScanError(
      'scheduled_scan.invalid_cache_minutes',
      `cacheMinutes must be >= ${MIN_CACHE_MINUTES}, got ${candidate}`
    )
  }
  if (candidate > MAX_CACHE_MINUTES) {
    throw new ScheduledScanError(
      'scheduled_scan.invalid_cache_minutes',
      `cacheMinutes must be <= ${MAX_CACHE_MINUTES}, got ${candidate}`
    )
  }
  return candidate
}

function readEnvCacheMinutes(): number | null {
  const raw = process.env['SKILLSMITH_SCHEDULED_AUDIT_CACHE_MIN']
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Walk `~/.skillsmith/audits/` looking for the most-recent audit dir
 * whose `result.json` mtime is within `cacheMinutes`. Returns
 * `{ auditId, reportPath, counts }` or null.
 *
 * The cache key is implicitly per-`homeDir` because the audits dir is
 * rooted there — multiple environments (test, dev, prod) each have
 * their own cache.
 */
async function findRecentAudit(
  homeDir: string,
  cacheMinutes: number
): Promise<{
  auditId: string
  reportPath: string
  counts: { exact: number; generic: number; semantic: number }
} | null> {
  const auditsDir = path.join(homeDir, '.skillsmith', 'audits')
  let entries: string[]
  try {
    entries = await fs.readdir(auditsDir)
  } catch {
    return null
  }

  const now = Date.now()
  const cutoffMs = cacheMinutes * 60 * 1000
  let mostRecent: { auditId: string; mtimeMs: number; reportPath: string } | null = null

  for (const entry of entries) {
    const resultPath = path.join(auditsDir, entry, 'result.json')
    let stat
    try {
      stat = await fs.stat(resultPath)
    } catch {
      continue
    }
    const ageMs = now - stat.mtimeMs
    if (ageMs > cutoffMs) continue
    if (mostRecent === null || stat.mtimeMs > mostRecent.mtimeMs) {
      mostRecent = {
        auditId: entry,
        mtimeMs: stat.mtimeMs,
        reportPath: path.join(auditsDir, entry, 'report.md'),
      }
    }
  }

  if (mostRecent === null) return null

  // Derive counts from the cached result.json so callers don't have to
  // re-read it themselves.
  let counts = { exact: 0, generic: 0, semantic: 0 }
  try {
    const resultRaw = await fs.readFile(
      path.join(auditsDir, mostRecent.auditId, 'result.json'),
      'utf-8'
    )
    const parsed = JSON.parse(resultRaw) as {
      exactCollisions?: unknown[]
      genericFlags?: unknown[]
      semanticCollisions?: unknown[]
    }
    counts = {
      exact: Array.isArray(parsed.exactCollisions) ? parsed.exactCollisions.length : 0,
      generic: Array.isArray(parsed.genericFlags) ? parsed.genericFlags.length : 0,
      semantic: Array.isArray(parsed.semanticCollisions) ? parsed.semanticCollisions.length : 0,
    }
  } catch {
    // Counts are best-effort; cached path is the source of truth.
  }

  return {
    auditId: mostRecent.auditId,
    reportPath: mostRecent.reportPath,
    counts,
  }
}

interface WebhookPayload {
  auditId: string
  reportPath: string
  counts: { exact: number; generic: number; semantic: number }
}

async function deliverWebhook(url: string, payload: WebhookPayload): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Append a webhook failure record. Strips path + query from the URL —
 * scheme+host only — because webhook URLs commonly carry secrets in
 * path segments (e.g., Slack `/services/T../B../SECRET`).
 */
async function logWebhookFailure(homeDir: string, url: string, auditId: string): Promise<void> {
  const logPath = path.join(homeDir, '.skillsmith', 'scheduled-scan-webhook-failures.log')
  const entry = {
    timestamp: new Date().toISOString(),
    url: stripUrlSecrets(url),
    auditId,
  }
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 })
    await fs.appendFile(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 })
  } catch {
    // Best-effort: failure to log is not fatal.
  }
}

/**
 * Reduce a webhook URL to `<scheme>://<host>` so secrets in path or
 * query never reach the failure log. Falls back to `'<unparseable>'`
 * if URL parsing throws.
 */
export function stripUrlSecrets(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '<unparseable>'
  }
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000
}
