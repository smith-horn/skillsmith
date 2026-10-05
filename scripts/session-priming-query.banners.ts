/**
 * SMI-6995 — session-priming banner rendering for the instrumentation probe,
 * split out of `session-priming-query.ts` to stay under this repo's
 * <500-line-per-file convention (CLAUDE.md § CI Health Requirements). The
 * pre-commit gate caught the overflow; this is the split it asked for.
 *
 * One-way dependency: this file imports from the probe module and the shared
 * helpers, never from `session-priming-query.ts`. That file re-exports
 * `renderInstrumentationBanner` so existing importers do not move.
 */

import type { ProbeResult } from '../packages/doc-retrieval-mcp/src/retrieval-log/probe.js'
import { formatRelativeAge } from './session-priming-query.helpers.js'

/**
 * SMI-6995: how the instrumentation banner names the outage marker.
 *
 * The old form was `probe.outageMarker?.ts ?? 'absent'`, which printed the
 * literal word "absent" for a marker file that was PRESENT on disk and could
 * not be parsed. That is not silence -- it is a positive claim, and the
 * opposite of the truth. Absence is the HEALTHY state for this marker, so
 * collapsing corruption into it does not merely hide a warning, it asserts
 * health. And this banner only renders at all once `probe.stale` is true, so
 * the false line appeared exactly when a developer was diagnosing broken
 * instrumentation and would believe it.
 *
 * `expired` is named rather than hidden, but note it still does not CAUSE a
 * banner: the TTL exists so an aged-out marker stops triggering on its own
 * (probe.ts's own "binding broken forever" guard). Naming it inside a banner
 * that is already rendering is accuracy, not a new trigger.
 */
function describeOutageMarker(read: ProbeResult['outageMarkerRead']): string {
  switch (read.status) {
    case 'present':
      return read.marker.ts
    case 'expired':
      return `${read.marker.ts} (expired — aged out past its TTL, so it no longer triggers on its own)`
    case 'malformed':
      return `PRESENT BUT MALFORMED (${read.detail}) — the file exists and cannot be parsed; this is not "absent"`
    case 'unreadable':
      return `PRESENT BUT UNREADABLE (${read.detail}) — the file exists and could not be read; this is not "absent"`
    case 'absent':
      return 'absent'
  }
}

/**
 * SMI-4549 Wave 2 — render the stale-instrumentation banner. Prepended to
 * the priming markdown when `assessInstrumentationHealth` returns
 * `stale: true`. Uses the same `**bold**` style as `renderPrimingMarkdown`
 * because GitHub `[!WARNING]` callouts render as literal text inside the
 * SessionStart `additionalContext` payload.
 */
export function renderInstrumentationBanner(
  probe: ProbeResult,
  now: Date,
  autohealLine?: string
): string {
  const lastReal =
    probe.lastRealSessionTs !== null
      ? `${probe.lastRealSessionTs} (${formatRelativeAge(probe.lastRealSessionTs, now)})`
      : 'never'
  const markerTs = describeOutageMarker(probe.outageMarkerRead)
  const dockerLine = probe.isDockerOnHost ? 'set' : 'unset'
  // D5: when the host auto-heal has a FAILED entry, surface its one-liner in
  // place of the generic repair hint so the developer knows healing has been
  // attempted and gets the copy-paste escape hatch. Otherwise keep the static
  // repair hint for backward compatibility.
  const repairLine =
    autohealLine && autohealLine.length > 0
      ? `- ${autohealLine}`
      : '- Repair: `./scripts/repair-host-native-deps.sh`'
  return [
    '**Warning — SessionStart instrumentation appears stale.**',
    '',
    `- Last real-session retrieval_events row: ${lastReal}.`,
    `- Outage marker: ${markerTs}. Reason: ${probe.reason}.`,
    `- IS_DOCKER on host: ${dockerLine}.`,
    repairLine,
    '',
  ].join('\n')
}
