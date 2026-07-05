/**
 * Continuous-audit email digest state (SMI-5541 Wave 2C Stage 2).
 *
 * Persists two fields under the `audit` namespace of `~/.skillsmith/config.json`
 * to make the background auto-notify (MCP-startup) throttled and non-spammy:
 *
 *   - `lastNotifyAt`   — an ISO timestamp gating how often the background scan +
 *     push runs (reuses the 24h `shouldAutoPush` throttle from `device-identity`).
 *   - `lastDigestHash` — the sha256 of the findings we last EMAILED, so an
 *     identical security picture is not re-emailed the next day (client-side
 *     dedup, independent of the server's own consent/nothing-to-report gates).
 *
 * The SERVER remains the source of truth for consent (`audit_email_enabled`);
 * these fields are purely local rate-limiting + dedup and never gate whether an
 * explicit `sklx audit security --email` push is attempted.
 *
 * @module @skillsmith/core/config/audit-notify-state
 */

import { loadConfig, saveConfig } from './index.js'

/** The persisted background auto-notify state. */
export interface AuditNotifyState {
  /** ISO timestamp of the last background digest attempt, or `undefined`. */
  lastNotifyAt?: string
  /** sha256 of the last-emailed findings, or `undefined` if never emailed. */
  lastDigestHash?: string
}

/**
 * Return the persisted auto-notify state (both fields may be `undefined`).
 *
 * Pure read — no side effects.
 */
export function getAuditNotifyState(): AuditNotifyState {
  const audit = loadConfig().audit
  return {
    lastNotifyAt: audit?.lastNotifyAt,
    lastDigestHash: audit?.lastDigestHash,
  }
}

/**
 * Advance the auto-notify throttle timestamp, and optionally record the hash of
 * the just-emailed findings.
 *
 * `lastNotifyAt` is ALWAYS updated (so the background run backs off for the
 * throttle window regardless of outcome). `lastDigestHash` is updated only when
 * `hash` is supplied — a caller records it after a successful send, and omits it
 * on a not-consented / not-verified outcome so a later opt-in still re-pushes
 * the same findings. Any existing `deviceId`/`lastPushAt` etc. are preserved.
 *
 * @param timestampIso - ISO 8601 timestamp (e.g. `new Date().toISOString()`).
 * @param hash - sha256 of the emailed findings; omit to leave the stored hash.
 */
export function recordAuditNotify(timestampIso: string, hash?: string): void {
  const existing = loadConfig().audit
  saveConfig({
    audit: {
      ...existing,
      lastNotifyAt: timestampIso,
      ...(hash !== undefined ? { lastDigestHash: hash } : {}),
    },
  })
}
