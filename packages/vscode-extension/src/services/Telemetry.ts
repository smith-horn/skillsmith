import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'

export type TelemetryEvent =
  | 'vscode_create_start'
  | 'vscode_create_complete'
  | 'vscode_create_failed'
  | 'vscode_create_cancelled'
  | 'vscode_uninstall_start'
  | 'vscode_uninstall_complete'
  | 'vscode_uninstall_failed'
  | 'vscode_uninstall_cancelled'
  | 'vscode_tier_denied'

// No hardcoded endpoint — telemetry is disabled by default at runtime
// unless `skillsmith.telemetryEndpoint` is set or the production endpoint
// ships in a future release. This avoids the 2026-04-13 MEMORY lesson
// where a hardcoded staging ref would leak into production builds.
const DEFAULT_ENDPOINT = ''
const COHORT_STATE_KEY = 'skillsmith.cohortId'
const POST_TIMEOUT_MS = 2000

let extensionVersion: string | undefined
let cohortId: string | undefined

/**
 * Initialize telemetry service (SMI-4194). Call from `activate()`.
 * Generates and persists an anonymous cohort UUID on first run; never
 * associates with user accounts. No telemetry is emitted unless:
 *   - `vscode.env.isTelemetryEnabled` is true (respects VS Code global), AND
 *   - `skillsmith.telemetry.enabled` setting is true (default true)
 * Both gates are checked at every `track()` call, not cached.
 */
export function initializeTelemetry(context: vscode.ExtensionContext, version: string): void {
  extensionVersion = version

  let existing = context.globalState.get<string>(COHORT_STATE_KEY)
  if (!existing) {
    existing = randomUUID()
    void context.globalState.update(COHORT_STATE_KEY, existing)
  }
  cohortId = existing
}

export function isTelemetryEnabled(): boolean {
  if (!vscode.env.isTelemetryEnabled) return false
  const config = vscode.workspace.getConfiguration('skillsmith')
  return config.get<boolean>('telemetry.enabled', true)
}

/**
 * Fire-and-forget telemetry emit. Never throws. Enforces a 2s timeout so
 * a slow/offline endpoint cannot delay a command response.
 */
export function track(event: TelemetryEvent, metadata: Record<string, unknown> = {}): void {
  if (!isTelemetryEnabled()) return
  if (!cohortId) return // initializeTelemetry not called — no-op
  void postEvent(event, metadata).catch((err) => {
    console.warn('[Skillsmith] telemetry post failed:', err)
  })
}

async function postEvent(event: TelemetryEvent, metadata: Record<string, unknown>): Promise<void> {
  const endpoint =
    vscode.workspace.getConfiguration('skillsmith').get<string>('telemetryEndpoint') ||
    DEFAULT_ENDPOINT
  if (!endpoint) return // no endpoint configured — telemetry is a no-op

  const body = {
    event,
    anonymous_id: cohortId,
    metadata: {
      ...metadata,
      extension_version: extensionVersion,
      vscode_version: vscode.version,
    },
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

// Exposed for tests
export function __resetForTests(): void {
  extensionVersion = undefined
  cohortId = undefined
}
