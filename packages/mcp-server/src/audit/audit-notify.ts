/**
 * @fileoverview Continuous-audit email digest — client-side push orchestrator
 *               (SMI-5541 Wave 2C Stage 2, Option 1).
 * @module @skillsmith/mcp-server/audit/audit-notify
 *
 * Bridges the local audit engine (`runSecurityAudit`, which lives here because
 * the scan runs where the content is — ADR-124) to the `@skillsmith/core`
 * push client (`sendAuditDigest`). Two entry points:
 *
 *   - `buildAuditDigestPayload` — pure map from a `RunSecurityAuditResult` into
 *     the compact `AuditDigestPushPayload` the edge function accepts (counts
 *     from the summary; the findings list sorted strongest-first and capped).
 *   - `maybeAutoNotifyAudit` — the throttled, deduped, non-throwing background
 *     run wired into MCP-server startup. Consent is enforced SERVER-side; this
 *     only rate-limits (≤ 1×/day) and suppresses re-emailing an identical
 *     security picture (client-side dedup on the findings hash).
 */

import * as crypto from 'node:crypto'

import {
  sendAuditDigest,
  getAuditNotifyState,
  recordAuditNotify,
  shouldAutoPush,
  loadCredentials,
  type AuditDigestPushPayload,
  type AuditDigestPushFinding,
  type AuditDigestVerdict,
} from '@skillsmith/core'

import { runSecurityAudit } from './security-audit.js'
import type {
  RunSecurityAuditResult,
  SecurityAuditFinding,
  SecurityVerdict,
} from './security-audit.types.js'

/**
 * Hard cap on findings listed in a pushed digest. Matches the edge function's
 * `MAX_FINDINGS` — the counts in the payload still reflect the FULL set, so a
 * user with 60 issues sees "60 issues" with the 50 strongest listed.
 */
export const MAX_DIGEST_FINDINGS = 50

/** Sort key — strongest verdict first (hostile > malicious > suspicious). */
function verdictRank(verdict: SecurityVerdict): number {
  switch (verdict) {
    case 'hostile':
      return 0
    case 'malicious':
      return 1
    case 'suspicious':
      return 2
    default: {
      const exhaustive: never = verdict
      return exhaustive
    }
  }
}

/**
 * Synthesize a CONTENT-FREE reason for the pushed digest from structured
 * signals only (verdict + counts + risk score). The audit finding's own
 * `reason`/`message` embed a literal excerpt of the scanned skill's content
 * (`"${match[0]}"`, see SecurityScanner), which must NEVER leave the device
 * (ADR-124) or land in an email body — so it is deliberately NOT copied here.
 * The rich, excerpt-bearing reason stays local to `sklx audit security`.
 */
function digestReason(f: SecurityAuditFinding): string {
  const risk = `risk ${f.riskScore}`
  const delta = f.riskDelta != null && f.riskDelta > 0 ? ` (up ${f.riskDelta})` : ''
  switch (f.verdict) {
    case 'hostile':
      return `A previously-trusted skill turned hostile: ${f.newFindingCount} new high-risk finding(s), ${risk}${delta}. Run \`sklx audit security\` for details.`
    case 'suspicious':
      return `An update raised this skill's risk: ${f.newFindingCount} new finding(s), ${risk}${delta}. Run \`sklx audit security\` for details.`
    case 'malicious':
      return `This skill fails the security scan (${risk}). Run \`sklx audit security\` for details.`
    default: {
      const exhaustive: never = f.verdict
      return exhaustive
    }
  }
}

/**
 * Strip C0 control chars + DEL so a hostile skill name can't inject newlines /
 * fake "sections" into the rendered digest email (defense-in-depth; the server
 * `coerceFinding` is the authoritative sanitizer, but the payload leaving the
 * device should be clean too).
 */
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ')
}

/**
 * Map a full audit result into the compact push payload. Pure: no I/O.
 *
 * Counts come from the run summary (the true totals); the findings list is
 * sorted strongest-first and capped at {@link MAX_DIGEST_FINDINGS}. Only the
 * identifier / kind / verdict travel (control-sanitized), plus a CONTENT-FREE
 * synthesized reason ({@link digestReason}) — never the audit's excerpt-bearing
 * reason, never `source_path`, never raw skill content.
 */
export function buildAuditDigestPayload(result: RunSecurityAuditResult): AuditDigestPushPayload {
  const findings: AuditDigestPushFinding[] = [...result.findings]
    .sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict))
    .slice(0, MAX_DIGEST_FINDINGS)
    .map((f) => ({
      identifier: stripControl(f.entry.identifier),
      kind: stripControl(f.entry.kind),
      verdict: f.verdict as AuditDigestVerdict,
      reason: digestReason(f),
    }))

  return {
    scanned: result.summary.scanned,
    hostile: result.summary.hostile,
    malicious: result.summary.malicious,
    suspicious: result.summary.suspicious,
    findings,
  }
}

/**
 * Stable dedup hash of a digest. Folds in the summary COUNTS as well as the
 * (top-50) findings, so a change confined below the findings cap — e.g. a
 * sub-50 skill escalating suspicious→malicious — still changes the hash and
 * re-alerts. Exported so the CLI (`--email`) records the SAME hash the
 * background auto-run uses, keeping the two channels from re-emailing an
 * identical digest.
 */
export function hashDigest(
  payload: Pick<AuditDigestPushPayload, 'hostile' | 'malicious' | 'suspicious' | 'findings'>
): string {
  const canonical = JSON.stringify([
    payload.hostile,
    payload.malicious,
    payload.suspicious,
    payload.findings.map((f) => [f.verdict, f.identifier, f.reason]),
  ])
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

/** Outcome of a background auto-notify attempt (for logging/tests). */
export interface MaybeAutoNotifyResult {
  /** Did we actually POST to `audit-notify`? (false = skipped before the network.) */
  attempted: boolean
  /** Did the server report an email was dispatched? */
  sent: boolean
  /**
   * Why we stopped, when informative: `nothing_to_report` | `deduped` | a
   * server reason (`not_consented` | `email_not_verified` | ...).
   */
  reason?: string
}

/** Options for {@link maybeAutoNotifyAudit} (injectable clock for tests). */
export interface MaybeAutoNotifyOptions {
  /** Current epoch ms; defaults to `Date.now()`. */
  now?: number
}

/**
 * Background continuous-audit digest push for MCP-server startup.
 *
 * Fire-and-forget contract: NEVER throws (all errors swallowed → logged →
 * `null`), so it is safe to call un-awaited from the startup path. Returns
 * `null` when it does nothing (disabled / throttled / not logged in / errored);
 * otherwise a {@link MaybeAutoNotifyResult}.
 *
 * Guards, in order:
 *   1. `SKILLSMITH_AUDIT_EMAIL_DISABLE=1` opts out entirely.
 *   2. 24h throttle (reuses `shouldAutoPush`) — bounds the scan to ≤ 1×/day.
 *   3. No stored session → skip WITHOUT advancing the throttle, so the first
 *      startup after `skillsmith login` tries promptly (rather than backing off
 *      a full day from a pointless logged-out attempt).
 *   4. Nothing to report → record a clean state, no network.
 *   5. Identical findings to the last email → back off, no re-email (dedup).
 *
 * Consent + verified-email are enforced SERVER-side; a `not_consented` response
 * advances only the throttle (not the dedup hash), so a later opt-in re-pushes.
 *
 * @see SMI-5541
 */
export async function maybeAutoNotifyAudit(
  opts?: MaybeAutoNotifyOptions
): Promise<MaybeAutoNotifyResult | null> {
  if (process.env.SKILLSMITH_AUDIT_EMAIL_DISABLE === '1') return null

  const now = opts?.now ?? Date.now()
  // Guard against a malformed injected `now` (NaN/Infinity/out-of-range, all of
  // which make `toISOString()` throw RangeError) so the never-throws contract
  // holds for all inputs, not just the production no-arg call.
  let nowIso: string
  try {
    nowIso = new Date(now).toISOString()
  } catch {
    nowIso = new Date().toISOString()
  }

  // Whole body wrapped so the never-throws contract holds even if a guard
  // helper (getAuditNotifyState / shouldAutoPush / loadCredentials) throws.
  try {
    const state = getAuditNotifyState()
    if (!shouldAutoPush(now, state.lastNotifyAt)) return null

    // Not logged in: skip WITHOUT recording, so login → next startup tries promptly.
    if (!(await loadCredentials())) return null

    const result = await runSecurityAudit({})
    const payload = buildAuditDigestPayload(result)
    const hash = hashDigest(payload)

    if (payload.findings.length === 0) {
      // Clean run: remember it (no network) so a later single finding differs.
      recordAuditNotify(nowIso, hash)
      return { attempted: false, sent: false, reason: 'nothing_to_report' }
    }

    if (state.lastDigestHash && hash === state.lastDigestHash) {
      // Same picture we already emailed — back off, don't re-send.
      recordAuditNotify(nowIso)
      return { attempted: false, sent: false, reason: 'deduped' }
    }

    const res = await sendAuditDigest(payload)
    // Record the hash only when actually emailed, so a later opt-in re-pushes
    // the same findings rather than silently deduping them away.
    recordAuditNotify(nowIso, res.sent ? hash : undefined)
    return { attempted: true, sent: res.sent, ...(res.reason ? { reason: res.reason } : {}) }
  } catch (error) {
    // Never throw into startup. Advance the throttle (best-effort — the record
    // itself is defensive) so a hard failure doesn't re-scan every launch.
    try {
      recordAuditNotify(nowIso)
    } catch {
      /* ignore — see audit-notify-state fail-safe contract */
    }
    console.error(
      '[skillsmith] audit auto-notify failed:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}
