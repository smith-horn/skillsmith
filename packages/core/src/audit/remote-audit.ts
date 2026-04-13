import { createHash } from 'node:crypto'
import { getApiKey } from '../config/index.js'

export interface InstallEventPayload {
  skillId: string
  source: 'mcp' | 'cli' | 'vscode'
  success: boolean
  durationMs?: number
  trustTier?: string
  errorCode?: string
}

const DEFAULT_API_BASE = 'https://api.skillsmith.app'
const EVENT_ENDPOINT = '/functions/v1/events'
const REQUEST_TIMEOUT_MS = 2000

function hashForActor(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}

function getApiBase(): string {
  return process.env.SKILLSMITH_API_URL || DEFAULT_API_BASE
}

function isDisabled(): boolean {
  const flag = process.env.SKILLSMITH_TELEMETRY
  return flag === '0' || flag === 'false' || flag === 'off'
}

/**
 * Emit a skill-install event to Skillsmith's remote telemetry endpoint.
 *
 * Best-effort: never throws, never blocks the caller. Silently skips in these cases:
 * - No API key available (CLI offline / unauthenticated)
 * - SKILLSMITH_TELEMETRY=0 (opt-out)
 * - Network / endpoint failure
 *
 * The API key is hashed (SHA256, full hex) before transmission. The server
 * stores the hash as `actor` — never the raw key, never an email, never a user ID.
 *
 * Event shape when emitted:
 *   event_type: "telemetry:skill_install"
 *   actor:      sha256(apiKey) hex
 *   metadata:   { skill_id, source, success, duration_ms?, trust_tier?, error_code? }
 */
export async function emitInstallEvent(payload: InstallEventPayload): Promise<void> {
  if (isDisabled()) return
  const apiKey = getApiKey()
  if (!apiKey) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    await fetch(`${getApiBase()}${EVENT_ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        event: 'skill_install',
        anonymous_id: hashForActor(apiKey),
        metadata: {
          skill_id: payload.skillId,
          source: payload.source,
          success: payload.success,
          ...(payload.durationMs !== undefined && { duration_ms: payload.durationMs }),
          ...(payload.trustTier !== undefined && { trust_tier: payload.trustTier }),
          ...(payload.errorCode !== undefined && { error_code: payload.errorCode }),
        },
      }),
    })
  } catch {
    // Best-effort: swallow all errors (network, abort, endpoint down).
    // Telemetry failures must never break the install flow.
  } finally {
    clearTimeout(timer)
  }
}
