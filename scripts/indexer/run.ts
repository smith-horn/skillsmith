#!/usr/bin/env node
/**
 * Skillsmith indexer entrypoint (Node port — SMI-4852 Tier 2)
 * @module scripts/indexer/run
 *
 * Invoked from `.github/workflows/indexer.yml` as:
 *   npx tsx scripts/indexer/run.ts
 *
 * Reads env vars (see `parse-env.ts`), acquires the advisory lock,
 * dispatches to discovery or maintenance, writes a single audit_logs row
 * with rate-limit telemetry, releases the lock.
 *
 * **STATUS (Wave 1 PR)**: The shared modules, env parsing, and orchestration
 * scaffolding land here. The discovery + maintenance entry points
 * (`runDiscoveryNode`, `runMaintenanceReconciliationNode`) are imported from
 * `./discovery-orchestrator-node.ts` and `./maintenance-helpers-node.ts` —
 * those mechanical ports of the 18 Deno indexer files are tracked as the
 * Wave 1.5 follow-up (see PR description). The entrypoint is wired against
 * those signatures today so the surface around the lock + telemetry is
 * frozen and reviewable in isolation.
 */

import { createSupabaseAdminClient, getRequestId } from './_shared/supabase.ts'
import {
  newRateLimitTelemetry,
  summarizeRateLimitTelemetry,
  type RateLimitTelemetry,
} from './_shared/rate-limit.ts'
import { parseEnv, type IndexerEnv } from './parse-env.ts'

interface RunSummary {
  data: unknown
  meta: {
    request_id: string
    run_type: 'discovery' | 'maintenance'
    rate_limit_remaining_min: number
    secondary_rate_limit_hits: number
    retry_after_max_seconds: number
    concurrency: number
    kill_switch_engaged: boolean
  }
}

/**
 * Phase wrapper called from `main` once the lock is held. Splits into the
 * discovery / maintenance branches; both branches must return an
 * audit-log-shape object the entrypoint can flush.
 *
 * The actual discovery/maintenance implementations are imported from the
 * ported Deno modules (Wave 1.5 follow-up — see file header).
 */
async function runWithLock(
  env: IndexerEnv,
  requestId: string,
  telemetry: RateLimitTelemetry
): Promise<unknown> {
  // Phase B (mechanical port follow-up):
  //   import { runDiscoveryNode } from './discovery-orchestrator-node.ts'
  //   import { runMaintenanceReconciliationNode } from './maintenance-helpers-node.ts'
  //   const supabase = createSupabaseAdminClient()
  //   return env.RUN_TYPE === 'maintenance'
  //     ? await runMaintenanceReconciliationNode({ supabase, requestId, env, telemetry })
  //     : await runDiscoveryNode({ supabase, requestId, env, telemetry })

  // Until the ports land, refuse to run rather than silently no-op against prod.
  // The workflow validates this surface via `dry_run=true` before the first
  // real run (see Wave 1 Step 11 staging gate).
  if (!env.DRY_RUN) {
    throw new Error(
      'scripts/indexer/run.ts: discovery/maintenance modules not yet ported (Wave 1.5 follow-up). ' +
        'Set DRY_RUN=true to exercise the scaffolding without writes.'
    )
  }

  // Touch telemetry so its shape is verifiable in dry-run mode.
  telemetry.rate_limit_remaining_min = Math.min(telemetry.rate_limit_remaining_min, 5000)
  void requestId

  return {
    dry_run: true,
    found: 0,
    indexed: 0,
    updated: 0,
    failed: 0,
    stale: 0,
    note: 'scaffolding-only — full port pending in Wave 1.5',
  }
}

async function main(): Promise<void> {
  const env = parseEnv()
  const requestId = getRequestId()
  const supabase = createSupabaseAdminClient()
  const telemetry = newRateLimitTelemetry()

  // Issue #16: check error BEFORE data on the RPC result.
  // - lockResult.error  -> hard failure, exit 1
  // - lockResult.data=false -> benign skip, exit 0
  // Note: `run_id` is the literal RPC parameter name in try_indexer_lock(run_id text).
  // Everywhere else we use `request_id` terminology.
  const lockResult = await supabase.rpc('try_indexer_lock', { run_id: requestId })

  if (lockResult.error) {
    console.error(
      JSON.stringify({
        event: 'lock_rpc_error',
        error: lockResult.error.message,
        request_id: requestId,
      })
    )
    process.exit(1)
  }

  if (!lockResult.data) {
    console.log(
      JSON.stringify({
        event: 'lock_held_by_other_run',
        request_id: requestId,
      })
    )
    process.exit(0)
  }

  let result: unknown = null
  let runError: unknown = null

  try {
    result = await runWithLock(env, requestId, telemetry)
  } catch (err) {
    runError = err
  } finally {
    const releaseResult = await supabase.rpc('release_indexer_lock', { run_id: requestId })
    if (releaseResult.error) {
      console.error(
        JSON.stringify({
          event: 'lock_release_error',
          error: releaseResult.error.message,
          request_id: requestId,
        })
      )
    }
  }

  const summary: RunSummary = {
    data: result,
    meta: {
      request_id: requestId,
      run_type: env.RUN_TYPE,
      concurrency: env.concurrency,
      kill_switch_engaged: env.kill_switch_engaged,
      ...summarizeRateLimitTelemetry(telemetry),
    },
  }

  if (runError) {
    console.error(JSON.stringify({ event: 'run_error', error: String(runError), ...summary }))
    process.exit(1)
  }

  console.log(JSON.stringify(summary))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'unhandled_error', error: String(err) }))
  process.exit(1)
})
