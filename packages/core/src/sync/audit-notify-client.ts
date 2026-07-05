/**
 * Audit-digest push client (SMI-5541 Wave 2C Stage 2, Option 1).
 *
 * The security audit runs CLIENT-side (the inventory data plane is
 * metadata-only, ADR-124), so the digest's email channel is a thin push: this
 * client authenticates with the stored device-login session and POSTs a
 * COMPACT findings summary — never raw skill content — to the gateway-verified
 * `audit-notify` edge function, which gates on consent + a verified email
 * server-side and sends the email via Resend.
 *
 * The payload contract here is the client-side twin of the edge function's
 * `parseDigest`: `{ scanned, hostile, malicious, suspicious, findings }`, each
 * finding `{ identifier, kind, verdict, reason }`. Defined independently in
 * `@skillsmith/core` (which must not depend on `@skillsmith/mcp-server`); the
 * mapping from a `RunSecurityAuditResult` into this shape lives in
 * `@skillsmith/mcp-server/audit` (`buildAuditDigestPayload`), which can see
 * both types.
 *
 * @module @skillsmith/core/sync/audit-notify-client
 */

import { resolveAccessToken as resolveSessionToken } from './access-token.js'
import { DEFAULT_BASE_URL, PRODUCTION_ANON_KEY } from '../api/utils.js'

/** The three security verdicts the digest carries (mirrors the edge fn). */
export type AuditDigestVerdict = 'hostile' | 'malicious' | 'suspicious'

/** One compact finding in a pushed digest. Carries NO raw skill content. */
export interface AuditDigestPushFinding {
  /** Skill/command/agent identifier (e.g. `author/name`). */
  identifier: string
  /** Inventory kind (`skill` | `command` | `agent`). */
  kind: string
  verdict: AuditDigestVerdict
  /** One human-readable sentence citing the deciding signal. */
  reason: string
}

/** The compact digest pushed to `audit-notify`. Mirrors the edge fn's parser. */
export interface AuditDigestPushPayload {
  scanned: number
  hostile: number
  malicious: number
  suspicious: number
  findings: AuditDigestPushFinding[]
}

/**
 * Outcome of a push. `ok`/`sent`/`reason` mirror the edge function's 200-body
 * shapes so callers can render a precise message without re-deriving:
 *   - `{ ok: true,  sent: true }`                         — email dispatched.
 *   - `{ ok: true,  sent: false, reason: 'nothing_to_report' }`
 *   - `{ ok: false, reason: 'not_consented' | 'email_not_verified' | 'no_email' }`
 *   - `{ ok: false, sent: false, reason: 'email_send_failed' }`
 */
export interface AuditDigestPushResult {
  ok: boolean
  sent: boolean
  reason?: string
}

/**
 * No usable device session. The message hints at the recovery action so the
 * CLI/MCP surface can relay it.
 */
export class AuditNotifyAuthError extends Error {
  constructor(message = 'Not authenticated. Run `skillsmith login` and try again.') {
    super(message)
    this.name = 'AuditNotifyAuthError'
  }
}

/**
 * Catch-all for transport failures and unexpected server responses (HTTP 5xx,
 * 400 `invalid_payload`, network errors, unparseable bodies).
 */
export class AuditNotifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditNotifyError'
  }
}

/**
 * Best-effort extraction of the server's `{ error }` / `{ reason }` body so a
 * typed error can carry the precise server message. Returns `null` when the
 * body is absent or not JSON.
 */
async function readServerMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown; reason?: unknown }
    if (typeof body.error === 'string') return body.error
    if (typeof body.reason === 'string') return body.reason
    return null
  } catch {
    return null
  }
}

/**
 * Push a compact audit digest to the `audit-notify` edge function.
 *
 * A `200` response is returned verbatim as an {@link AuditDigestPushResult} —
 * this INCLUDES the consent-off `{ ok: false, reason: 'not_consented' }` and
 * the `{ ok: true, sent: false, reason: 'nothing_to_report' }` no-ops, which
 * are successful round-trips, not errors.
 *
 * @param payload - The compact digest (never raw content).
 * @returns The edge function's outcome.
 * @throws {AuditNotifyAuthError} HTTP 401, or no/expired session.
 * @throws {AuditNotifyError} HTTP 400/5xx, network failure, or unparseable 200 body.
 * @see SMI-5541
 */
export async function sendAuditDigest(
  payload: AuditDigestPushPayload
): Promise<AuditDigestPushResult> {
  const accessToken = await resolveSessionToken(() => new AuditNotifyAuthError())

  let res: Response
  try {
    res = await fetch(`${DEFAULT_BASE_URL}/audit-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: PRODUCTION_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AuditNotifyError(`Audit digest request failed: ${detail}`)
  }

  if (res.ok) {
    let body: { ok?: unknown; sent?: unknown; reason?: unknown; error?: unknown }
    try {
      body = (await res.json()) as {
        ok?: unknown
        sent?: unknown
        reason?: unknown
        error?: unknown
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new AuditNotifyError(`Audit digest returned an unreadable body: ${detail}`)
    }
    // Most 200 outcomes carry `reason`; the Resend-failure body uses `error`
    // (`email_send_failed`) — surface either so the caller can render it.
    const reason =
      typeof body.reason === 'string'
        ? body.reason
        : typeof body.error === 'string'
          ? body.error
          : undefined
    return {
      ok: body.ok === true,
      sent: body.sent === true,
      ...(reason !== undefined ? { reason } : {}),
    }
  }

  const serverMessage = await readServerMessage(res)
  if (res.status === 401) {
    throw new AuditNotifyAuthError()
  }
  throw new AuditNotifyError(
    `Audit digest push failed (HTTP ${res.status})${serverMessage ? `: ${serverMessage}` : ''}`
  )
}
