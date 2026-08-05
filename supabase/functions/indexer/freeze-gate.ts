/**
 * SMI-5879 (design §8.3.2.5.3): Gate F — the pre-writer freeze gate for the
 * deployed indexer edge function (writer class W-11).
 * @module indexer/freeze-gate
 *
 * Deno-side counterpart to scripts/indexer/run-gate.ts's
 * assertFreezeMarkerClear — NOT a byte-identical twin. run-gate.ts is
 * explicitly Node-only and must never be mirrored under supabase/functions/:
 * one file there converts the gate-infrastructure PR into a 31-function
 * `mode=all` deploy fanout (classify-deploy-mode.sh:23-29). This module
 * reimplements the same vocabulary/fail-closed semantics for the one writer
 * no GitHub-side mechanism can gate — W-11 is invoked over HTTPS from outside
 * GitHub (scripts/trigger-indexer.ts, or any holder of the public anon key;
 * indexer performs no caller authorization beyond the gateway's JWT check,
 * filed separately as SMI-N).
 *
 * Reads the most recent `audit_logs` row with `event_type='indexer:freeze'`,
 * `resource='skills'`, and applies the same allow-list vocabulary as
 * `assertRunAllowed` (unset/'all' permit; 'none' refuse; a comma-separated
 * subset of GATED_RUN_TYPES permits iff the run type is listed; any other
 * value refuses, fail-closed) against `metadata.allowlist`. Fails CLOSED on
 * query error or a malformed marker row. Evaluated on EVERY invocation, not
 * at checkpoints — this is what makes it a real pre-writer gate.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'

/**
 * The deployed indexer function's own run-type union (IndexerRequest.runType,
 * indexer-types.ts — 'discovery' | 'maintenance', default 'discovery').
 * gate-f-runtype-containment.test.ts asserts this is a strict subset of
 * scripts/indexer/run-gate.ts's GATED_RUN_TYPES so the two vocabularies
 * cannot drift.
 */
export const INDEXER_FUNCTION_RUN_TYPES = ['discovery', 'maintenance'] as const
export type IndexerFunctionRunType = (typeof INDEXER_FUNCTION_RUN_TYPES)[number]

/**
 * Mirrors scripts/indexer/run-gate.ts's GATED_RUN_TYPES exactly (not
 * imported — that module is Node-only and must not be referenced from
 * supabase/functions/). gate-f-runtype-containment.test.ts guards drift.
 */
const GATED_RUN_TYPES = [
  'discovery',
  'maintenance',
  'recheck',
  'dequarantine',
  'purge',
  'revalidate',
] as const
type GatedRunType = (typeof GATED_RUN_TYPES)[number]

function isGatedRunType(value: string): value is GatedRunType {
  return (GATED_RUN_TYPES as readonly string[]).includes(value)
}

/**
 * Ported verbatim from scripts/indexer/run-gate.ts's isRunTypePermitted —
 * keep the two in sync if the allow-list vocabulary ever changes.
 */
function isRunTypePermitted(rawAllowlist: string, runType: GatedRunType): boolean {
  const raw = rawAllowlist.trim().toLowerCase()

  if (raw === '' || raw === 'all') return true
  if (raw === 'none') return false

  const tokens = raw.split(',').map((t) => t.trim())
  const allRecognised = tokens.length > 0 && tokens.every((t) => isGatedRunType(t))
  if (!allRecognised) return false // fail closed on any unrecognised token/value

  return tokens.includes(runType)
}

export interface FreezeGateResult {
  permitted: boolean
  /** Present only when `permitted` is false — the fail-closed reason. */
  reason?: string
}

/**
 * Gate F. Never throws — returns a result the caller uses to refuse (HTTP
 * 503, no dispatch) before any `skills` write. Fails CLOSED: a query error,
 * a thrown exception, or a marker row with no valid string
 * `metadata.allowlist` all resolve to `permitted: false`. No marker row at
 * all (steady state — no freeze has ever been engaged, or the pin was
 * cleared at the end of a change window) resolves to `permitted: true`,
 * matching `assertFreezeMarkerClear`'s steady-state default.
 */
export async function checkFreezeGate(
  supabase: SupabaseClient,
  runType: IndexerFunctionRunType
): Promise<FreezeGateResult> {
  let allowlistRaw: unknown
  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('metadata')
      .eq('event_type', 'indexer:freeze')
      .eq('resource', 'skills')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      return { permitted: false, reason: `freeze-marker query failed: ${error.message}` }
    }

    if (data == null) {
      // No marker row has ever been written — steady state. Permit.
      return { permitted: true }
    }

    allowlistRaw = (data.metadata as Record<string, unknown> | null | undefined)?.allowlist
  } catch (err) {
    return {
      permitted: false,
      reason: `freeze-marker query threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (typeof allowlistRaw !== 'string') {
    return {
      permitted: false,
      reason: 'freeze marker row exists but carries no valid metadata.allowlist',
    }
  }

  if (!isRunTypePermitted(allowlistRaw, runType)) {
    return {
      permitted: false,
      reason: `freeze marker allowlist="${allowlistRaw}" does not permit run_type=${runType}`,
    }
  }

  return { permitted: true }
}

/**
 * Record a Gate F refusal for the audit trail. Deliberately a DIFFERENT
 * event_type ('indexer:freeze_refused') than the freeze marker itself
 * ('indexer:freeze') — if this row shared the marker's event_type/resource,
 * checkFreezeGate's "most recent row" query would pick up this refusal row
 * as the new marker on the NEXT invocation. That row carries no
 * metadata.allowlist, so the fail-closed "malformed marker" rule would
 * refuse every subsequent invocation — a self-inflicted, permanent denial of
 * service the moment the freeze gate ever refuses once. Best-effort: a
 * failure to write the audit row must not itself throw (the 503 response is
 * already decided).
 */
export async function recordFreezeGateRefusal(
  supabase: SupabaseClient,
  runType: IndexerFunctionRunType,
  reason: string,
  requestId: string
): Promise<void> {
  try {
    await supabase.from('audit_logs').insert({
      event_type: 'indexer:freeze_refused',
      resource: 'skills',
      metadata: { runType, reason, requestId },
    })
  } catch (err) {
    console.error('[Gate F] failed to record refusal audit row:', err)
  }
}
