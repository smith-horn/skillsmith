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
 * filed separately as SMI-6021).
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
import { sanitizeForLog } from '../_shared/validation.ts'

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
 * SMI-6020 (design §1.3): result of validating an attacker-controlled
 * `body.runType` against this function's own two-token vocabulary
 * (`INDEXER_FUNCTION_RUN_TYPES`), BEFORE it ever reaches `checkFreezeGate`.
 * `checkFreezeGate`'s `runType` parameter is typed `IndexerFunctionRunType`
 * at compile time only — without this check that type is a lie at runtime,
 * and a token from the broader `GATED_RUN_TYPES` vocabulary (e.g. 'purge')
 * can sail past `isRunTypePermitted` and fall through to a full write.
 */
export type RunTypeParseResult =
  | { ok: true; runType: IndexerFunctionRunType }
  | { ok: false; received: string; gatedButUnimplemented: boolean }

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
 * SMI-6020 (design §1.2-1.3): validates `body.runType` against this
 * function's own vocabulary BEFORE `checkFreezeGate` is ever called. This is
 * deliberately separate from Gate F itself: "is this token in this
 * function's vocabulary" is a pure, no-DB check; "does the freeze marker
 * permit it" is Gate F's own DB-backed concern. Keeping them apart makes the
 * four extra `GATED_RUN_TYPES` tokens ('recheck' | 'dequarantine' | 'purge'
 * | 'revalidate' — Node-CLI run types only, never valid over HTTP)
 * structurally unreachable from this function, rather than merely refused
 * downstream.
 *
 * No trimming, no lowercasing: this is a machine-to-machine contract with a
 * small, fixed set of in-repo callers that all send exact lowercase tokens.
 * Silent normalization is how a typo becomes an unnoticed discovery run.
 */
export function parseIndexerFunctionRunType(raw: unknown): RunTypeParseResult {
  if (raw === undefined || raw === null) {
    // Preserves the documented default (index.ts, indexer-types.ts) — an
    // absent runType (bodyless GET, empty POST) must keep working.
    return { ok: true, runType: 'discovery' }
  }

  if (typeof raw !== 'string') {
    return { ok: false, received: sanitizeForLog(raw), gatedButUnimplemented: false }
  }

  if ((INDEXER_FUNCTION_RUN_TYPES as readonly string[]).includes(raw)) {
    return { ok: true, runType: raw as IndexerFunctionRunType }
  }

  return {
    ok: false,
    received: sanitizeForLog(raw),
    // The exploit signature: a token this function never implements but
    // that IS in Gate F's broader vocabulary (GATED_RUN_TYPES) — e.g.
    // 'purge' — would otherwise pass isRunTypePermitted and fall through to
    // a full discovery-class write.
    gatedButUnimplemented: isGatedRunType(raw),
  }
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
 * SMI-6020 (design §3.3): best-effort audit insert shared by every recorder
 * in this file. supabase-js RESOLVES `{ data, error }` on a DB-level failure
 * (RLS denial, constraint violation, schema mismatch) rather than rejecting
 * — a bare try/catch around the insert call observes only transport-layer
 * throws and silently drops those resolved errors, so the resolved `error`
 * must be inspected explicitly. Kept module-private: the two exported
 * recorders below are the tested surface, not this helper.
 */
async function insertAuditRowBestEffort(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
  logTag: string
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_logs').insert(row)
    if (error) {
      console.error(`${logTag} failed to record audit row:`, error.message)
    }
  } catch (err) {
    console.error(`${logTag} failed to record audit row:`, err)
  }
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
  await insertAuditRowBestEffort(
    supabase,
    {
      event_type: 'indexer:freeze_refused',
      resource: 'skills',
      metadata: { runType, reason, requestId },
    },
    '[Gate F]'
  )
}

/**
 * SMI-6020 (design §1.5): record an invalid-`runType` rejection for the
 * audit trail. Deliberately a THIRD distinct event_type
 * ('indexer:invalid_run_type') — never 'indexer:freeze' (the marker-
 * collision permanent-DoS hazard documented above) and never
 * 'indexer:freeze_refused' (would pollute freeze-refusal counts with what
 * are actually client errors, not freeze engagements).
 *
 * Call this ONLY when `RunTypeParseResult.gatedButUnimplemented` is true
 * (the four-token closed set: 'recheck' | 'dequarantine' | 'purge' |
 * 'revalidate' — the exploit signature). For every other malformed value,
 * the caller should `console.error` and skip the DB write: the indexer has
 * no `verify_jwt = false` override in supabase/config.toml, so it is
 * reachable by any holder of the public anon key, and an unconditional
 * audit insert per rejected request would be a new unauthenticated
 * write-amplification path into `audit_logs` that does not exist today.
 * Best-effort: a failure to write the audit row must not itself throw.
 */
export async function recordInvalidRunTypeRejection(
  supabase: SupabaseClient,
  received: string,
  requestId: string
): Promise<void> {
  await insertAuditRowBestEffort(
    supabase,
    {
      event_type: 'indexer:invalid_run_type',
      resource: 'skills',
      metadata: { received, requestId },
    },
    '[Gate F runtype]'
  )
}
