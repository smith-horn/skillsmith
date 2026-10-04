/**
 * SMI-6744 A5.5.2(b) delta — ruflo-bridge banner rendering, split out of
 * `ruflo-bridge-state.ts` to stay under this repo's <500-line-per-file
 * convention (CLAUDE.md § CI Health Requirements). One-way dependency only:
 * this file imports from `ruflo-bridge-state.ts`, never the reverse.
 *
 * Render shape, segment order matching `renderReindexBanner`:
 * `**[ruflo-bridge]** <state text> — <next action> — log: … — disable: …`.
 * `healthy` and fresh renders nothing; every other state renders, including
 * a reader-axis failure past {@link hasExpectedByPassed} — see
 * `renderBridgeVerdictLine`'s own doc comment for why this does NOT copy
 * `renderReindexBanner`'s `if (!entry) return ''`.
 */

import { homedir } from 'node:os'

import {
  BRIDGE_VERDICT_DISABLE_VAR,
  DEFAULT_LIVENESS_DAYS,
  DEFAULT_STALE_HOURS,
  hasExpectedByPassed,
  resolveBridgeLogPath,
  resolveBridgePayloadPath,
  resolveBridgeStatePath,
  type BridgeEntry,
  type BridgeReadResult,
} from './ruflo-bridge-state.js'

function displayPath(p: string): string {
  const home = homedir()
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}

function ageHours(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 3_600_000
}

function footer(now: Date): string {
  return `log: ${displayPath(resolveBridgeLogPath(now))} — disable: ${BRIDGE_VERDICT_DISABLE_VAR}=1`
}

function line(stateText: string, nextAction: string, now: Date): string {
  return `**[ruflo-bridge]** ${stateText} — ${nextAction} — ${footer(now)}`
}

const RECONNECT_HINT = '/mcp > ruflo > Reconnect'
const START_COMMAND = './scripts/ruflo-service-up.sh'
const PROBE_COMMAND = 'node scripts/ruflo-bridge-probe.mjs'

/** The not-evaluated text for a verdict that is not-evaluated/unrecognized/malformed(detector)/unknown-token. */
function detectorNotEvaluatedText(entry: BridgeEntry): { state: string; action: string } {
  const action = `re-run: node scripts/lib/ruflo-bridge-verdict.mjs ${resolveBridgePayloadPath()}`
  if (entry.verdict === 'malformed') {
    return {
      state: `verdict not evaluated: payload malformed at ${displayPath(resolveBridgePayloadPath())}`,
      action,
    }
  }
  const ver = entry.derivedFromVersion ?? 'unknown'
  const backend = entry.observedBackend ?? 'unknown'
  return {
    state: `verdict not evaluated: embeddingBackend '${backend}' is outside the table pinned at DERIVED_FROM ${ver} — treat as FAIL`,
    action,
  }
}

/**
 * The verdict-axis line, or '' when nothing should render (healthy and
 * fresh). Does NOT copy `renderReindexBanner`'s `if (!entry) return ''`
 * (`reindex-state.ts:183`) — a `missing`/`malformed`/`unreadable` READ past
 * {@link hasExpectedByPassed} is exactly when this must render loudly, the
 * defect one layer up from D3's that this delta's correction-of-record
 * section names.
 */
export function renderBridgeVerdictLine(
  read: BridgeReadResult,
  opts: { now: Date; staleHours?: number }
): string {
  const { now } = opts
  const staleHours = opts.staleHours ?? DEFAULT_STALE_HOURS

  if (read.status !== 'ok') {
    if (read.status === 'missing' && !hasExpectedByPassed(now)) return ''
    const stateWord =
      read.status === 'missing'
        ? 'missing'
        : read.status === 'malformed'
          ? `malformed at ${displayPath(resolveBridgeStatePath())}`
          : `unreadable (${read.detail})`
    return line(
      `verdict not evaluated: state ${stateWord}`,
      `run: ${PROBE_COMMAND} — then ${RECONNECT_HINT}`,
      now
    )
  }

  const { entry } = read
  const hours = ageHours(entry.evaluatedAt, now)
  const ageSuffix = `${Math.round(hours)}h ago`

  if (entry.verdict === 'healthy') {
    if (hours < staleHours) return ''
    return line(`verdict stale (${Math.round(hours)}h)`, `run: ${PROBE_COMMAND} to refresh`, now)
  }
  if (entry.verdict === 'unreadable') {
    return line(
      `probe could not reach the served server: ${entry.reason}`,
      `run: ${START_COMMAND}, then ${RECONNECT_HINT}`,
      now
    )
  }
  if (entry.verdict === 'unverified') {
    // Deliberately NOT routed through detectorNotEvaluatedText: that text
    // sends the reader to the payload detector, which is the wrong remedy for
    // an identity failure and was the code gate's Medium finding. The reason
    // string carries which of identity or freshness was not established.
    return line(
      `bridge UNVERIFIED: ${entry.reason ?? 'identity or freshness could not be corroborated'}`,
      `inspect the store and authority file, then re-run: ${PROBE_COMMAND}`,
      now
    )
  }
  if (entry.verdict === 'degraded') {
    return line(
      `bridge degraded: embeddingBackend '${entry.observedBackend ?? 'mock'}' (${ageSuffix})`,
      `run: ${PROBE_COMMAND}, then ${RECONNECT_HINT}`,
      now
    )
  }
  // not-evaluated / unrecognized / malformed(detector) / any token outside the six
  const { state, action } = detectorNotEvaluatedText(entry)
  return line(`${state} (${ageSuffix})`, action, now)
}

/** The liveness-axis line, or '' when the threshold has not been reached, or the read was not `ok`. */
export function renderBridgeLivenessLine(
  read: BridgeReadResult,
  opts: { now: Date; livenessDays?: number }
): string {
  if (read.status !== 'ok') return ''
  const days = opts.livenessDays ?? DEFAULT_LIVENESS_DAYS
  if (read.entry.consecutiveNoLearning < days) return ''
  return line(
    `no learning recorded in ${days} days (patternsLearned/trajectoriesRecorded unmoved)`,
    `run: ${PROBE_COMMAND} to re-check`,
    opts.now
  )
}

/** Both lines joined (verdict first, then liveness), filtering empties — the fixed segment order this module owns. */
export function renderBridgeBanner(
  read: BridgeReadResult,
  opts: { now: Date; staleHours?: number; livenessDays?: number }
): string {
  return [renderBridgeVerdictLine(read, opts), renderBridgeLivenessLine(read, opts)]
    .filter(Boolean)
    .join('\n')
}
