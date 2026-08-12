/**
 * SMI-5879 (8.3.2/8.3.3): Shared execution-gate module for the indexer family.
 * @module scripts/indexer/run-gate
 *
 * Node-side only. MUST NOT be mirrored into supabase/functions/: one file
 * there converts the gate-infrastructure PR into a 31-function `mode=all`
 * fanout (`classify-deploy-mode.sh:23-29`). The Deno equivalent (Gate F) ships
 * separately, inside `supabase/functions/indexer/`, in the PR that deploys
 * the ported scanner.
 *
 * Two independent layers:
 *  - {@link assertRunAllowed} -- env-sourced (`INDEXER_RUN_ALLOWLIST`), reads
 *    `process.env` directly (never `parseEnv()`: the three direct tools build
 *    no `IndexerEnv`, and `parseEnv()` hard-fails on a missing SUPABASE_* pair).
 *  - {@link assertFreezeMarkerClear} -- DB-sourced (`audit_logs`), raises the
 *    host-side bar for tools whose `INDEXER_RUN_ALLOWLIST` read the operator
 *    themselves could rewrite. Not called from `run.ts` (CI-only path; see
 *    the call-site contract in the design doc 8.3.3.2).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The seven run-type identifiers the gate understands. Five (`discovery`,
 * `maintenance`, `recheck`, `dequarantine`, `purge`) mirror `parse-env.ts`'s
 * `RUN_TYPE` union exactly; `revalidate` and `repair` exist only in the
 * gate's own vocabulary, for host-only writers
 * (`revalidate-stale-quarantines.ts`, `repair-latched-name-rows.ts`),
 * deliberately kept out of `parse-env.ts`'s union so the workflow-facing
 * surface is unchanged.
 *
 * SMI-5930 (code-review finding): `repair` was added because
 * `repair-latched-name-rows.ts` is a genuine one-time WRITER against the
 * same `skills` table the freeze window protects (it nulls `content_hash`
 * for a targeted row set), the same class of operation as `dequarantine`/
 * `purge`/`revalidate` above — not a reader like `smi5879-census.ts` et al.
 * (run-gate-callsites.test.ts's Shape 4), which are deliberately exempt
 * because they ARE the freeze window's own verification tooling. Using a
 * psql/session-pooler connection instead of PostgREST doesn't change
 * whether a script needs this gate — what matters is read vs. write to
 * `skills`, not the connection mechanism.
 */
export const GATED_RUN_TYPES = [
  'discovery',
  'maintenance',
  'recheck',
  'dequarantine',
  'purge',
  'revalidate',
  'repair',
] as const

export type GatedRunType = (typeof GATED_RUN_TYPES)[number]

/** Documented bypass for {@link assertFreezeMarkerClear} (Guards & Opt-Outs registry). */
const FREEZE_MARKER_BYPASS_VAR = 'SKILLSMITH_INDEXER_FREEZE_MARKER_BYPASS'

function isGatedRunType(value: string): value is GatedRunType {
  return (GATED_RUN_TYPES as readonly string[]).includes(value)
}

/**
 * Parse an allow-list string (either `INDEXER_RUN_ALLOWLIST` or a freeze
 * marker's `metadata.allowlist`) into an allow/deny decision for `runType`.
 *
 * Semantics: unset/empty/'all' => permit; 'none' => refuse; a comma-separated
 * subset of {@link GATED_RUN_TYPES} => permit iff `runType` is listed; ANY
 * OTHER value (including a comma list containing an unrecognised token) =>
 * refuse (fail closed), so a typo such as "nonw" can never read as "all".
 * Values are trimmed and lower-cased before comparison.
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

/**
 * Refuse (throw; never return) when `INDEXER_RUN_ALLOWLIST` forbids `runType`.
 * Reads `process.env` DIRECTLY and never calls `parseEnv()`: the three direct
 * tools construct no `IndexerEnv`, `parseEnv()` hard-fails on a missing
 * SUPABASE_* pair, and `parse-env.ts`'s `RUN_TYPE` validation covers the five
 * WORKFLOW values only -- `revalidate` is deliberately outside that union.
 *
 * In CI this is enforced: `INDEXER_RUN_ALLOWLIST` arrives as a repo variable
 * plumbed through the workflow's `env:` block, which the job cannot rewrite.
 * On the host it is a tripwire, not a gate: the person it is meant to stop is
 * the person who can unset the variable in their own shell (SMI-5879 8.3.3.3).
 */
export function assertRunAllowed(runType: GatedRunType): void {
  const raw = process.env.INDEXER_RUN_ALLOWLIST ?? ''

  if (isRunTypePermitted(raw, runType)) return

  const normalized = raw.trim().toLowerCase()
  throw new Error(
    normalized === 'none'
      ? `[run-gate] INDEXER_RUN_ALLOWLIST=none — the indexer run-type allow-list is engaged. Refusing run_type=${runType}.`
      : `[run-gate] INDEXER_RUN_ALLOWLIST="${raw}" does not permit run_type=${runType} (expected unset/'all', 'none', or a comma-separated subset of ${GATED_RUN_TYPES.join(',')}). Refusing (fail closed).`
  )
}

/**
 * Second, DB-side layer. Reads the most recent `audit_logs` row with
 * `event_type='indexer:freeze'`, `resource='skills'`; applies
 * {@link assertRunAllowed}'s exact vocabulary (via {@link isRunTypePermitted})
 * to that row's `metadata.allowlist`. Zero migrations: `audit_logs` is an
 * existing table and this is an ordinary audit row.
 *
 * Fail-closed rules:
 *  - a query ERROR (or a thrown exception) means the freeze state cannot be
 *    confirmed -- refuse. A tool that cannot confirm the freeze is clear must
 *    not proceed.
 *  - a marker row that exists but carries no string `metadata.allowlist` is
 *    malformed -- refuse.
 *  - NO marker row at all (the steady-state default before any freeze has
 *    ever been engaged, or after 8.3.2.5.6's final "pin unset last" step)
 *    is treated the same as an empty `INDEXER_RUN_ALLOWLIST`: permit. The
 *    tool must be inert outside a change window, exactly like Gates A/B/D/E.
 *
 * Documented bypass: `SKILLSMITH_INDEXER_FREEZE_MARKER_BYPASS=1` (registered
 * in `docs/internal/process/guards-and-opt-outs.md` per the Guards & Opt-Outs
 * rule).
 */
export async function assertFreezeMarkerClear(
  supabase: SupabaseClient,
  runType: GatedRunType
): Promise<void> {
  if (process.env[FREEZE_MARKER_BYPASS_VAR] === '1') return

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

    if (error) throw new Error(error.message)

    if (data == null) {
      // No marker row has ever been written — steady state. Permit.
      return
    }

    allowlistRaw = (data.metadata as Record<string, unknown> | null | undefined)?.allowlist
  } catch (err) {
    throw new Error(
      `[run-gate] could not confirm freeze-marker state for run_type=${runType} — refusing (fail closed): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }

  if (typeof allowlistRaw !== 'string') {
    throw new Error(
      `[run-gate] freeze marker row exists but carries no valid metadata.allowlist — refusing run_type=${runType} (fail closed).`
    )
  }

  if (!isRunTypePermitted(allowlistRaw, runType)) {
    throw new Error(
      `[run-gate] freeze marker allowlist="${allowlistRaw}" does not permit run_type=${runType}. Refusing (fail closed).`
    )
  }
}
