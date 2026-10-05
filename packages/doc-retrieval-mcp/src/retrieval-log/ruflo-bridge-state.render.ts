/**
 * SMI-6744 A5.5.2(b) delta — ruflo-bridge banner rendering, split out of
 * `ruflo-bridge-state.ts` to stay under this repo's <500-line-per-file
 * convention (CLAUDE.md § CI Health Requirements). One-way dependency only:
 * this file imports from `ruflo-bridge-state.ts`, never the reverse.
 *
 * Render shape, segment order matching `renderReindexBanner`:
 * `**[ruflo-bridge]** <state text> — <next action> — log: … — disable: …`.
 * `healthy` and fresh renders nothing; every other state renders
 * unconditionally (SMI-6985 removed the `expectedBy` grace window that used
 * to suppress a `missing` read for a time — see `renderBridgeVerdictLine`'s
 * own doc comment for the full history and why this does NOT copy
 * `renderReindexBanner`'s `if (!entry) return ''`).
 */

import { homedir } from 'node:os'

import {
  BRIDGE_VERDICT_DISABLE_VAR,
  DEFAULT_LIVENESS_DAYS,
  DEFAULT_STALE_HOURS,
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
 * (`reindex-state.ts:183`) — a `missing`/`malformed`/`unreadable` READ
 * renders unconditionally, the defect one layer up from D3's that this
 * delta's correction-of-record section names.
 *
 * SMI-6985: this used to gate the `missing` case behind an `expectedBy`
 * grace window, anchored to this checkout's own probe-script install date.
 * That anchor was fixed three times and was renewable every time it shipped
 * (working-tree mtime, then the commit's committer date, then its author
 * date — a shallow clone's grafted boundary moves the author date too, and
 * each subsequent `git fetch --depth=1` moves it again). The owner's
 * decision was removal, not a fourth anchor: a `missing` read now always
 * renders, including on a checkout that has never run the probe — the line
 * names the exact command to run, so a fresh-checkout "not evaluated" read
 * is actionable, not noise. See docs/internal/implementation/
 * smi-6744-bridge-verdict-consumer.md for the full history.
 */
export function renderBridgeVerdictLine(
  read: BridgeReadResult,
  opts: { now: Date; staleHours?: number }
): string {
  const { now } = opts
  const staleHours = opts.staleHours ?? DEFAULT_STALE_HOURS

  if (read.status !== 'ok') {
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

/**
 * The liveness-axis line, or '' when dormant, the threshold has not been
 * reached, or the read was not `ok`.
 *
 * SMI-6985 correction of record (owner-decided, superseding SMI-6967 H-1,
 * corrected in place rather than appended below per this repo's own rule
 * against two surfaces disagreeing): **gated on `entry.everLearned`, NOT
 * `entry.everProducerPresent`.** H-1's prior gate (`everProducerPresent` —
 * `bridge.status === 'connected'` and/or `agentdb.totalEntries > 0`) was
 * reasoned to fix a real conflation ("a producer exists" vs "learning has
 * happened"), but it re-gated on the wrong producer: measured live, nothing
 * in this repository calls the trajectory-capture hooks at all (zero
 * call-site files for `trajectory-start`/`trajectory-step`/`trajectory-end`
 * across `*.ts`/`*.mjs`/`*.sh`, `node_modules`/`dist`/`docs/internal/research`
 * excluded; `memory_bridge_status` itself has 9), and the only two
 * `hooks_intelligence_*` tools named anywhere in `.claude/settings.json`
 * (`pattern-store`, `pattern-search`) are both in its deny list. The thing
 * that must exist for this arm to be informative is a TRAJECTORY WRITER, not
 * a connected bridge — and a bridge with no writer is this checkout's
 * permanent, correct state, not a fault. Under the H-1 gate, with the bridge
 * genuinely connected and the store genuinely non-empty,
 * `everProducerPresent` latches immediately and the streak advances on every
 * probe, so this arm fired "connected but has never recorded a pattern or
 * trajectory" forever, on a condition nobody could act on — the same
 * unreportable-silent-stall SHAPE SMI-6744 exists to catch, one layer out:
 * H-1 fixed an unreportable `false`, and produced an un-actionable `true`.
 *
 * **The fix is `everLearned` — the counters' own persisted history** (`true`
 * once any probe has observed `patternsLearned`/`trajectoriesRecorded` above
 * zero; see `foldLiveness`), not a per-probe reading (H-9's own prior defect)
 * and not "a producer exists" (H-1's). Until something has actually been
 * recorded at least once, there is nothing to report a stall about, so the
 * arm stays silent — correctly, because there is nothing actionable to say.
 * Once `everLearned` latches, a SUBSEQUENT stall is exactly what this arm
 * exists to report. **Consequence: the "has never recorded a pattern or
 * trajectory" wording branch is now UNREACHABLE by construction** — reaching
 * the no-learning check below requires `everLearned === true`, so that
 * branch's own condition (`everLearned !== true`) can never hold there. It
 * is deleted along with its tests, rather than left as a branch no input can
 * reach (the same decorative-coverage shape this feature keeps finding one
 * layer in). `everProducerPresent` stays as a tracked, latched field (still
 * computed by the probe and folded by `foldLiveness`) but is no longer this
 * function's gate; nothing else currently reads it.
 *
 * `entry.everLearned` is read as `=== true` (not merely truthy) so an entry
 * written before the field existed — where it is `undefined` — is treated as
 * dormant, never as armed; a fresh checkout with no payload at all still
 * renders nothing.
 *
 * SMI-6967 M-5, corrected by SMI-6985 M-1 (reviewer-found, corrected in
 * place per this repo's own rule against two surfaces disagreeing):
 * `entry.countersRegressed` (a counter DECREASED since the last probe — the
 * store was likely wiped or reset) renders unconditionally, checked AHEAD
 * of the `everLearned` gate above (not merely "once something has ever been
 * learned") and independent from the no-learning threshold below — it is
 * the loudest possible signal for a feature about bridge integrity and must
 * never be mistaken for ordinary progress.
 *
 * The original text claimed gating this behind `everLearned` "loses no
 * reachable case," reasoning that a regression requires a positive prior
 * baseline, which would itself already have set `everLearned`. That is
 * false for a baseline seeded from a LEGACY entry: `seedBaseline` (in
 * `ruflo-bridge-state.liveness.ts`) falls back to the entry's own raw
 * `patternsLearned`/`trajectoriesRecorded` reading whenever
 * `lastObserved*` is `undefined` — i.e. an on-disk entry written before
 * those fields existed — and `readEntryResult` validates only
 * `verdict`/`evaluatedAt`/`reason`, so such an entry passes through intact.
 * `everLearned` is computed only from THIS probe's own counters
 * (`pNum > 0`/`tNum > 0`) plus the prior latch, never from that legacy
 * baseline, so a wipe to EXACTLY ZERO against a legacy `patternsLearned: 5`
 * (or `trajectoriesRecorded`) yields `{countersRegressed: true, everLearned:
 * false}` — precisely the condition this arm exists to report, and an
 * `everLearned` gate placed above this check would have suppressed it
 * silently. (A state entry produced entirely by the CURRENT fold cannot
 * reach this: `lastObserved* > 0` implies `everLearned === true` and the
 * flag never un-latches, so only a pre-existing on-disk entry predating
 * `everLearned` can trigger the gap — nothing in this repository produces
 * one today. Checking `countersRegressed` first removes the gap regardless,
 * at zero cost: it can only be `true` when the probe actually observed a
 * counter decrease, so moving it ahead of `everLearned` cannot resurrect
 * the H-1/H-9 noise `everLearned` itself exists to suppress.)
 *
 * **Follow-on, deliberately not built now (SMI-6985):** a probe that reaches
 * a learning-armed bridge but finds `intelligence.patternsLearned`/
 * `.trajectoriesRecorded` absent or invalid in an otherwise-valid payload
 * would still freeze `consecutiveNoLearning` silently (the fold's "nothing
 * observed" branch carries it forward unchanged) — the same silent-forever
 * shape this correction just removed one layer out. That scenario cannot
 * occur while this arm is permanently dormant (no trajectory writer exists
 * anywhere in this repo today), so a `consecutiveCountersUnreadable`-shaped
 * streak (fold a counter when the server answers but both counters are
 * unreadable; render it past the same threshold) is the right fix WHEN a
 * trajectory writer exists and this arm can actually arm — not before. Filed
 * here rather than built speculatively, per this repo's own standing lesson
 * about shipping mechanisms for states that cannot occur yet.
 */
export function renderBridgeLivenessLine(
  read: BridgeReadResult,
  opts: { now: Date; livenessDays?: number }
): string {
  if (read.status !== 'ok') return ''
  const { entry } = read
  // SMI-6985 M-1: checked BEFORE the `everLearned` gate below — see this
  // function's own doc comment for why an `everLearned` gate above this
  // check can suppress a real regression (a wipe-to-zero against a legacy
  // baseline).
  if (entry.countersRegressed === true) {
    return line(
      'learning counters regressed: patternsLearned/trajectoriesRecorded decreased since the last probe (the store was likely wiped or reset)',
      `run: ${PROBE_COMMAND} to re-check`,
      opts.now
    )
  }
  if (entry.everLearned !== true) return ''
  const days = opts.livenessDays ?? DEFAULT_LIVENESS_DAYS
  if (entry.consecutiveNoLearning < days) return ''
  // SMI-6967 M-13: the threshold counts consecutive PROBES, not days —
  // post-merge is the probe's only trigger, so `days` probes can span weeks
  // of wall-clock time. The rendered text must say so, not "days".
  return line(
    `no learning recorded in ${days} consecutive probes (patternsLearned/trajectoriesRecorded unmoved)`,
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
