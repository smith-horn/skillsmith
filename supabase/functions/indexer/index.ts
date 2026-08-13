/**
 * POST /v1/indexer - GitHub skill indexer
 * @module indexer
 *
 * SMI-1247: GitHub indexer Edge Function.
 * SMI-4376: Thin dispatcher (~194 LOC). Business logic lives in siblings:
 *   - `discovery-orchestrator.ts::runDiscovery` — Phases 1-7 (high-trust →
 *     topic search → code search → upsert → categorize → stale → audit).
 *   - `maintenance-helpers.ts::runMaintenanceReconciliation` — reconcile-only
 *     maintenance flow under 150s edge-function wall-clock.
 *   - `indexer-types.ts` — `IndexerRequest` / `IndexerResult` shared interfaces.
 *
 * This file owns: CORS preflight, method check, row-level lock (SMI-2569/2570),
 * request-body parse, topic resolution (`selectTopics` — SMI-4374), config
 * defaults, dispatch to the appropriate orchestrator, response assembly, and
 * lock release in `finally`.
 *
 * Request Body (optional):
 * - topics: Array of GitHub topics to search (default: 10 topics)
 * - maxPages: Max pages per topic (default: 5, max: 10)
 * - maxRepos: Max topic-search repos per invocation (default: 100)
 * - dryRun: If true, don't write to database (default: false)
 * - strictValidation: Require valid YAML frontmatter (default: true)
 * - minContentLength: Minimum SKILL.md content length (default: 100)
 * - staleThresholdDays: Days before stale quarantine (default: 7 for maintenance, 30 for discovery; see SMI-4203)
 * - runType: 'maintenance' | 'discovery' (default: 'discovery')
 * - codeSearchMaxPages: Max pages for code search (default: 3, max: 5)
 */

import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

import { createSupabaseAdminClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

import { DEFAULT_TOPICS } from './topic-search.ts'
import {
  type SkillMdValidation,
  DEFAULT_MIN_CONTENT_LENGTH,
} from './skill-processor.ts'
import { createTokenBucket } from '../_shared/rate-limit.ts'
// SMI-4241 + SMI-4376: Maintenance-branch orchestrator + helpers
import { runMaintenanceReconciliation } from './maintenance-helpers.ts'
// SMI-4374: Discovery topic rotation (extracted for testability — pure function)
import { selectTopics } from './topic-rotation.ts'
// SMI-4376: Shared interfaces + extracted discovery orchestrator
import type { IndexerRequest } from './indexer-types.ts'
import { runDiscovery } from './discovery-orchestrator.ts'
// SMI-5879 (design §8.3.2.5.3): Gate F — pre-writer freeze gate for W-11.
import { checkFreezeGate, recordFreezeGateRefusal } from './freeze-gate.ts'
// SMI-6020 (design §1.2-1.5): runtime validation of body.runType — closes
// the Gate F bypass where a gated-but-unimplemented run type (e.g. 'purge')
// sails past isRunTypePermitted's broader vocabulary check.
import {
  parseIndexerFunctionRunType,
  recordInvalidRunTypeRejection,
  INDEXER_FUNCTION_RUN_TYPES,
} from './freeze-gate.ts'
// SMI-6033 Wave 2 (Gap 8) fix: `skill-processor.security.tree.ts`'s Trees-API
// memoization/budget state is module-level, but on this Deno edge function
// (`Deno.serve`, a long-lived HTTP handler, NOT a fresh process per run —
// unlike the Node indexer script) a warm isolate can carry that state across
// invocations. Without a reset, invocation N+1 on a warm isolate can hit a
// STALE positive memo for a repo scanned in invocation N and silently persist
// `scan_coverage_incomplete: false` for a skill whose operational-code files
// were never actually re-enumerated this run — exactly the silent-gap failure
// mode this whole column exists to prevent. Reset at the top of every
// invocation so this function's "run-scoped" contract is actually true here,
// matching the isolate-reuse hazard already documented in
// supabase/functions/status-public/index.ts.
import { resetRepoTreeFetchState } from './skill-processor.security.tree.ts'

/**
 * SMI-4376: Merge CORS headers + X-Request-ID onto a `jsonResponse` result.
 * Both dispatch branches (maintenance + discovery) build the same envelope;
 * this helper is the single place that performs the merge.
 */
function buildFinalResponse(
  payload: { data: unknown; meta: Record<string, unknown> },
  origin: string | null,
  requestId: string,
): Response {
  const response = jsonResponse(payload)
  const headers = new Headers(response.headers)
  Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
    headers.set(key, value)
  })
  headers.set('X-Request-ID', requestId)
  return new Response(response.body, { status: response.status, headers })
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest(req.headers.get('origin'))
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return errorResponse('Method not allowed', 405)
  }

  const requestId = getRequestId(req.headers)
  const origin = req.headers.get('origin')
  logInvocation('indexer', requestId)
  // SMI-6033 Wave 2 (Gap 8): see the resetRepoTreeFetchState import comment
  // above — must run before any per-skill scan work this invocation does.
  resetRepoTreeFetchState()

  const supabase = createSupabaseAdminClient()

  // Parse request body BEFORE the lock/dispatch try-block below, so the
  // requested run type is known to Gate F ahead of any skills-table write.
  let body: IndexerRequest = {}
  if (req.method === 'POST') {
    try {
      const parsed: unknown = await req.json()
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as IndexerRequest
      }
      // A JSON scalar or array parses successfully but isn't a valid request
      // body — fall through with the empty-object default rather than
      // asserting a lie onto every downstream body.x read.
    } catch {
      // Empty / unparseable body is OK — defaults apply (documented behaviour).
    }
  }

  // SMI-6020 (design §1.2-1.4): validate body.runType against this
  // function's own two-token vocabulary BEFORE Gate F ever sees it.
  // checkFreezeGate's runType parameter is typed IndexerFunctionRunType at
  // compile time only — without this check, a gated-but-unimplemented token
  // (e.g. 'purge') can pass isRunTypePermitted's broader GATED_RUN_TYPES
  // check and fall through to a full discovery-class write.
  const runTypeParse = parseIndexerFunctionRunType(body.runType)
  if (!runTypeParse.ok) {
    if (runTypeParse.gatedButUnimplemented) {
      await recordInvalidRunTypeRejection(supabase, runTypeParse.received, requestId)
    } else {
      console.error(`[Indexer] invalid runType rejected: ${runTypeParse.received}`)
    }
    return errorResponse(
      'Invalid runType',
      400,
      {
        request_id: requestId,
        received: runTypeParse.received,
        allowed: [...INDEXER_FUNCTION_RUN_TYPES],
      },
      origin,
    )
  }
  const runType = runTypeParse.runType

  // SMI-5879 (design §8.3.2.5.3): Gate F — pre-writer freeze gate, evaluated
  // on EVERY invocation, before the row-level lock RPC and before any
  // dispatch to runDiscovery/runMaintenanceReconciliation.
  const freezeGate = await checkFreezeGate(supabase, runType)
  if (!freezeGate.permitted) {
    await recordFreezeGateRefusal(supabase, runType, freezeGate.reason ?? 'unknown', requestId)
    return errorResponse(
      'Indexer run refused: freeze gate engaged',
      503,
      { request_id: requestId, run_type: runType },
      origin,
    )
  }

  try {
    // Phase 1b: Row-level lock to prevent concurrent runs
    // SMI-2569/2570: Replaces advisory locks which don't survive PgBouncer pooling
    const { data: lockAcquired } = await supabase.rpc('try_indexer_lock', {
      run_id: requestId,
    })
    if (!lockAcquired) {
      return jsonResponse({
        data: { skipped: true, reason: 'concurrent run in progress' },
        meta: { request_id: requestId, timestamp: new Date().toISOString() },
      })
    }

    // Phase 2a + SMI-4374: topic resolution (body > env > cronSlot rotation > DEFAULT_TOPICS).
    // `selectTopics` is pure (topic-rotation.ts) — validation + fallback unit-tested there.
    const envRaw = Deno.env.get('SKILLSMITH_INDEX_TOPICS')
    const envTopics = envRaw
      ? envRaw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
      : undefined
    const { topics, source: rotationSource } = selectTopics({
      bodyTopics: body.topics,
      envTopics,
      cronSlot: body.cronSlot,
      defaultTopics: DEFAULT_TOPICS,
    })
    const cronSlot = typeof body.cronSlot === 'number' ? body.cronSlot : null
    const maxPages = Math.min(body.maxPages || 5, 10)
    const dryRun = body.dryRun ?? false
    const strictValidation = body.strictValidation ?? true
    const minContentLength = body.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH
    const maxTopicRepos = body.maxRepos ?? 100
    const codeSearchMaxPages = Math.min(body.codeSearchMaxPages ?? 3, 5)

    const validationOptions = { strictValidation, minContentLength }
    const validationCache = new Map<string, SkillMdValidation>()

    // SMI-4846: Token buckets pacing parallel callers against GitHub upstream
    // quotas. Singleton-by-construction — threaded as parameters into
    // runDiscovery so unit tests can substitute mocks.
    //   searchApiTokenBucket: GitHub Search API quota (30 rpm = 0.5 tps).
    //     Used by Phase 2 topic search (parallelized this PR).
    //   codeSearchTokenBucket: GitHub Code Search API quota (10 rpm ≈ 0.167 tps).
    //     RESERVED but unused in this PR — Phase 3a stays serial behind the
    //     existing 6s inter-page delay (see indexer-runners.ts:177). Wired up
    //     in the follow-up PR that parallelizes Phase 3a.
    const searchApiTokenBucket = createTokenBucket(0.5, 1)
    const codeSearchTokenBucket = createTokenBucket(1 / 6, 1)

    // SMI-4854: Prefetch repo_updated_at skip-gate map for upstream discovery
    // phases. SMI-4846 placed the skip-gate in runUpsertPhase only — but
    // validateSkillMd is called in Phase 2 (`checkSkillMdExists`) and Phase 3a
    // (`runCodeSearch`); skipping there is what saves the ~240s of HTTP fetches.
    // Single batched select; ~600 rows today, scales linearly with skill count.
    const existingRepoUpdatedAt = new Map<string, string | null>()
    if (runType !== 'maintenance') {
      const { data: existingRows, error: prefetchError } = await supabase
        .from('skills')
        .select('repo_url, repo_updated_at')
        .not('repo_url', 'is', null)
      if (prefetchError) {
        console.error('[Indexer] repo_updated_at prefetch failed:', prefetchError.message)
        // Non-fatal — empty map means no skip-gate hits this run; correctness preserved.
      } else {
        for (const row of (existingRows ?? []) as Array<{ repo_url: string; repo_updated_at: string | null }>) {
          if (row.repo_url) existingRepoUpdatedAt.set(row.repo_url, row.repo_updated_at ?? null)
        }
      }
      console.log(`[Indexer] Prefetched ${existingRepoUpdatedAt.size} existing repo_updated_at entries for skip-gate`)
    }

    // SMI-4241 + SMI-4376: Maintenance runs do reconcile-only work to stay
    // under the 150s edge function IDLE_TIMEOUT. Discovery (phases 1-5) runs
    // at 06/12/18 UTC; last_seen_at freshness is touched on every sighting
    // by skills-refresh-metadata (SMI-4201) so no data is lost.
    if (runType === 'maintenance') {
      const data = await runMaintenanceReconciliation({
        supabase,
        requestId,
        body,
        dryRun,
      })

      return buildFinalResponse(
        {
          data,
          meta: {
            run_type: 'maintenance',
            request_id: requestId,
            topics: [],
            cron_slot: null, // SMI-4374: maintenance is not a discovery slot.
            rotation_source: 'fallback',
            timestamp: new Date().toISOString(),
          },
        },
        origin,
        requestId,
      )
    }

    // SMI-4376: Discovery orchestration extracted to discovery-orchestrator.ts
    const result = await runDiscovery({
      supabase,
      requestId,
      body,
      topics,
      rotationSource,
      cronSlot,
      maxPages,
      maxTopicRepos,
      codeSearchMaxPages,
      dryRun,
      validationOptions,
      validationCache,
      searchApiTokenBucket,
      codeSearchTokenBucket,
      existingRepoUpdatedAt,
    })

    return buildFinalResponse(
      {
        data: result,
        meta: {
          topics,
          max_pages: maxPages,
          run_type: runType,
          request_id: requestId,
          cron_slot: cronSlot, // SMI-4374: slot + provenance of the topic list.
          rotation_source: rotationSource,
          timestamp: new Date().toISOString(),
        },
      },
      origin,
      requestId,
    )
  } catch (error) {
    console.error('Indexer error:', error)
    return errorResponse('Internal server error', 500, { request_id: requestId })
  } finally {
    // Release row-level lock so subsequent runs can proceed
    // SMI-2570: Lock auto-expires after 30 minutes as safety net
    try {
      await supabase.rpc('release_indexer_lock', { run_id: requestId })
    } catch {
      // Best-effort — lock has 30-min staleness guard in try_indexer_lock()
    }
  }
})
