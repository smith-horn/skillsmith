#!/usr/bin/env tsx
/**
 * SMI-4451 Wave 1 Step 7 — SessionStart priming query builder.
 *
 * Invoked by `scripts/session-start-priming.sh` after gate checks pass. Builds
 * a 3-signal query (branch+files / Linear issue body / memory bullets), runs
 * `search()` against the doc-retrieval index, logs a `retrieval_events` row
 * via the Step 3 writer, and emits markdown for the SessionStart hook to
 * inject as `additionalContext`.
 *
 * Spec: docs/internal/implementation/smi-4450-sparc-research.md §P2 +
 * smi-4450-step7-session-start-hook.md §S4. Per addendum:
 *   - linear-api.mjs has no `get-issue` command (surface gap caught at impl
 *     time). Inlines a minimal Linear GraphQL fetch instead of touching
 *     linear-api.mjs. ~25 LOC scoped to this feature.
 *   - `disabled` outcome already in RetrievalHookOutcome union (schema.ts:30)
 *     — no schema migration needed, just emit the value.
 *   - Encoded-cwd resolution delegates to the shared resolver in
 *     `packages/doc-retrieval-mcp/src/retrieval-log/project-dir.ts` (SMI-5419):
 *     MEMORY.md via the main-repo `resolveSharedProjectDir`, sessions via the
 *     per-cwd `resolveClaudeProjectDir`. Drift caught by audit:standards §34.
 *
 * SMI-5793: the signal builders and small formatting utilities live in
 * `session-priming-query.helpers.ts` (split out to stay under this repo's
 * <500-line-per-file convention) — this file keeps the orchestrator
 * (`runQuery`), the banner renderers that consume sibling `retrieval-log/*`
 * state, and the CLI entry point.
 */

import {
  readEntry,
  renderAutohealBanner,
  resolveAutohealLogPath,
  resolveMainRepoKey,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/autoheal-state.js'
import {
  assessInstrumentationHealth,
  type ProbeResult,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/probe.js'
import {
  readEntry as readLivenessEntry,
  renderLivenessBanner,
  resolveLivenessLogPath,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/liveness-state.js'
import {
  readEntry as readReindexEntry,
  renderReindexBanner,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/reindex-state.js'
import {
  readAndAck,
  renderDisconnectBanner,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/mcp-disconnect-state.js'
import {
  logRetrievalEvent,
  resolveRetrievalLogPaths,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/writer.js'
import type { SearchHit } from '../packages/doc-retrieval-mcp/src/types.js'
import {
  buildSignal1,
  buildSignal2,
  buildSignal3,
  type CliArgs,
  countRecentJsonlSessions,
  extractRecentBullets,
  formatRelativeAge,
  getCurrentHeadSha,
  loadSearch,
  parseCliArgs,
  truncateBytes,
} from './session-priming-query.helpers.js'

const QUERY_CAP_BYTES = 4096
const RENDER_CAP_BYTES = 2048
const SEARCH_K = 8
const MIN_SCORE = 0.35
const PROBE_DEFAULT_STALE_HOURS = 24

export interface PrimingResult {
  additionalContext: string
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
  const markerTs = probe.outageMarker?.ts ?? 'absent'
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

export function renderPrimingMarkdown(query: string, hits: SearchHit[]): string {
  const head = '<!-- session-priming v1 — SMI-4451 Wave 1 Step 7 -->'
  const queryLine = `**Priming query** (truncated; full text in retrieval-logs.db):\n\n> ${truncateBytes(
    query.replace(/\n/g, ' '),
    300
  )}`
  const hitLines = hits.map(
    (h, i) =>
      `${i + 1}. \`${h.filePath}\` (${h.similarity.toFixed(2)})${
        h.headingChain.length > 0 ? ` — ${h.headingChain.join(' › ')}` : ''
      }`
  )
  let out = `${head}\n${queryLine}\n\n**Top ${hits.length} retrievals** (cosine ≥ ${MIN_SCORE}):\n\n${hitLines.join('\n')}\n`
  while (Buffer.byteLength(out, 'utf8') > RENDER_CAP_BYTES && hitLines.length > 1) {
    hitLines.pop()
    out = `${head}\n${queryLine}\n\n**Top ${hitLines.length} retrievals** (cosine ≥ ${MIN_SCORE}):\n\n${hitLines.join('\n')}\n`
  }
  return out
}

export async function runQuery(args: CliArgs): Promise<PrimingResult> {
  // SMI-4549 Wave 2: probe instrumentation health BEFORE the disabled
  // short-circuit. A user who has explicitly disabled priming for a
  // session still benefits from a banner if their writer is broken —
  // the probe never writes to the DB, so it's safe to run regardless.
  const now = new Date()
  const staleHoursEnv = Number(process.env.SKILLSMITH_RETRIEVAL_PROBE_STALE_HOURS)
  const staleHours =
    Number.isFinite(staleHoursEnv) && staleHoursEnv > 0 ? staleHoursEnv : PROBE_DEFAULT_STALE_HOURS
  const { dbPath, outageMarkerPath } = resolveRetrievalLogPaths()

  // D5 (SMI-5426 W0.1): if the host auto-heal has a FAILED entry for this
  // repo, surface its banner in place of the generic repair hint so the
  // developer sees the cooldown state and copy-paste escape hatch. Only shows
  // when the binding is already broken (probe.stale is the gating condition),
  // and only when there is a real FAILED entry — no noise on a healthy host.
  let autohealLine = ''
  try {
    const key = resolveMainRepoKey(args.cwd)
    if (key) {
      const e = readEntry(key)
      if (e && e.lastVerdict === 'fail') {
        autohealLine = renderAutohealBanner(e, { now, logPath: resolveAutohealLogPath(now) })
      }
    }
  } catch {
    /* fail-soft — must never crash the priming hook */
  }

  let probeBanner = ''
  try {
    const probe = await assessInstrumentationHealth({
      outageMarkerPath,
      dbPath,
      now,
      staleHours,
      jsonlSessionCount24h: countRecentJsonlSessions(args.cwd, now, staleHours),
    })
    if (probe.stale) probeBanner = renderInstrumentationBanner(probe, now, autohealLine)
  } catch {
    // Probe must never crash the priming hook. Silent degrade.
  }

  // SMI-5432 W0.2 — scheduled liveness backstop banner (M2).
  // When the feed is stale AND the host auto-heal also failed, renderLivenessBanner
  // appends the M2 causal phrase "likely the host auto-heal failure above" so both
  // surfaces point at the same root cause instead of producing two separate alerts.
  let livenessLine = ''
  try {
    const livenessKey = resolveMainRepoKey(args.cwd)
    if (livenessKey) {
      const le = readLivenessEntry(livenessKey)
      if (le && le.lastVerdict === 'stale') {
        livenessLine = renderLivenessBanner(le, {
          now,
          logPath: resolveLivenessLogPath(now),
          autohealFailed: autohealLine.length > 0,
        })
      }
    }
  } catch {
    /* fail-soft — must never crash the priming hook */
  }

  // SMI-5793 — reindex staleness/failure/anomaly banner (session-priming
  // state-consumer, mirrors the autoheal/liveness banners above). Computed
  // BEFORE the disabled short-circuit, same rationale as the probe/liveness
  // banners: a silently-broken or stalled `.husky/post-commit` reindex
  // should surface even when priming itself is disabled for this session.
  // SKILLSMITH_REINDEX_STALENESS_DISABLE=1 silences this banner only — the
  // structured JSONL log (written by cli.ts, independent of this hook) keeps
  // writing regardless.
  let reindexLine = ''
  if (process.env.SKILLSMITH_REINDEX_STALENESS_DISABLE !== '1') {
    try {
      const reindexKey = resolveMainRepoKey(args.cwd)
      if (reindexKey) {
        const re = readReindexEntry(reindexKey)
        if (re) {
          const currentHeadSha = await getCurrentHeadSha(args.cwd)
          const staleHoursEnv = Number(process.env.SKILLSMITH_REINDEX_STALE_HOURS)
          const staleHours =
            Number.isFinite(staleHoursEnv) && staleHoursEnv > 0 ? staleHoursEnv : undefined
          reindexLine = renderReindexBanner(re, { now, currentHeadSha, staleHours })
        }
      }
    } catch {
      /* fail-soft — must never crash the priming hook */
    }
  }

  // SMI-5941 — MCP live-disconnect banner (session-priming state-consumer,
  // mirrors the autoheal/liveness/reindex banners above). Computed BEFORE the
  // disabled short-circuit for the same reason as the others: a disconnect a
  // user hasn't seen yet should surface even when priming itself is disabled
  // for this session. Checks both MCP servers this feature covers.
  let disconnectLine = ''
  if (process.env.SKILLSMITH_MCP_DISCONNECT_DISABLE !== '1') {
    try {
      const disconnectKey = resolveMainRepoKey(args.cwd)
      if (disconnectKey) {
        const lines: string[] = []
        for (const server of ['skillsmith', 'skillsmith-doc-retrieval'] as const) {
          const entry = readAndAck(disconnectKey, server)
          if (entry) lines.push(renderDisconnectBanner(server, entry))
        }
        disconnectLine = lines.join('\n')
      }
    } catch {
      /* fail-soft — must never crash the priming hook */
    }
  }

  // Combined banner: stale-probe section first, liveness one-liner, reindex one-liner, disconnect one-liner below.
  const contextBanner = [probeBanner, livenessLine, reindexLine, disconnectLine]
    .filter(Boolean)
    .join('\n')

  if (process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING === '1') {
    logRetrievalEvent({
      sessionId: args.sessionId,
      ts: now.toISOString(),
      trigger: 'session_start_priming',
      query: '',
      topKResults: '[]',
      hookOutcome: 'disabled',
    })
    // Even when priming is disabled, surface the stale-instrumentation
    // banner so a long-running outage doesn't go silent.
    return { additionalContext: contextBanner }
  }

  const [signal1, signal2, signal3] = await Promise.all([
    buildSignal1(args),
    buildSignal2(args),
    buildSignal3(args),
  ])

  const query = truncateBytes(
    [signal1, signal2, signal3].filter(Boolean).join('\n\n'),
    QUERY_CAP_BYTES
  )

  const search = await loadSearch()
  if (!search) {
    // @ruvector/core native binding unavailable on this host — log and
    // gracefully degrade. Common cause: optional platform dep not installed
    // (e.g. `ruvector-core-darwin-arm64` missing on macOS hosts).
    logRetrievalEvent({
      sessionId: args.sessionId,
      ts: new Date().toISOString(),
      trigger: 'session_start_priming',
      query,
      topKResults: '[]',
      hookOutcome: 'partial_failure',
    })
    return { additionalContext: contextBanner }
  }

  let hits: SearchHit[]
  try {
    hits = await search({ query, k: SEARCH_K, minScore: MIN_SCORE })
  } catch {
    logRetrievalEvent({
      sessionId: args.sessionId,
      ts: new Date().toISOString(),
      trigger: 'session_start_priming',
      query,
      topKResults: '[]',
      hookOutcome: 'partial_failure',
    })
    return { additionalContext: contextBanner }
  }

  if (hits.length === 0) {
    logRetrievalEvent({
      sessionId: args.sessionId,
      ts: new Date().toISOString(),
      trigger: 'session_start_priming',
      query,
      topKResults: '[]',
      hookOutcome: 'partial_failure',
    })
    return { additionalContext: contextBanner }
  }

  logRetrievalEvent({
    sessionId: args.sessionId,
    ts: new Date().toISOString(),
    trigger: 'session_start_priming',
    query,
    topKResults: JSON.stringify(
      hits.map((h) => ({
        chunk_id: h.id,
        file_path: h.filePath,
        line_range: [h.lineStart, h.lineEnd],
        score: h.similarity,
      }))
    ),
    hookOutcome: 'primed',
  })

  return { additionalContext: contextBanner + renderPrimingMarkdown(query, hits) }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))
  if (!args) {
    process.stdout.write(JSON.stringify({ additionalContext: '' }))
    process.exit(0)
  }
  const result = await runQuery(args)
  process.stdout.write(JSON.stringify(result))
}

if (process.argv[1]?.endsWith('session-priming-query.ts')) {
  void main()
}

// Re-exported for `scripts/tests/session-priming-query.test.ts` — these now
// live in `session-priming-query.helpers.ts` (SMI-5793 file-length split),
// re-exported here so the test's existing import path stays valid.
export { countRecentJsonlSessions, extractRecentBullets, parseCliArgs, truncateBytes }
