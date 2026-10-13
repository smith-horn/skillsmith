/**
 * Upstream-WAF helpers for the batch upsert (Node port)
 * @module scripts/indexer/indexer-runners.waf
 *
 * SMI-7113: the Cloudflare block page that refuses a single row used to fail the
 * whole upsert chunk (and, once the WAF started blocking per-payload, every chunk
 * containing that row, every run). Split out of `indexer-runners.batch.ts` to keep
 * that file under the 500-line gate. Byte-identical body to the Deno twin
 * `supabase/functions/indexer/indexer-runners.waf.ts` modulo the header and the
 * SupabaseClient import. No env reads here: the caller passes `resolveWafOptions` a reader.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** SMI-7113: bisecting a WAF block must reach a single row (2000 rows -> 11 halvings). */
export const MAX_WAF_SPLIT_DEPTH = 11
/** SMI-7113: default cap on upsert requests per flush once a WAF block is being bisected. */
export const DEFAULT_BLOCK_BISECT_BUDGET = 64
/** SMI-7113: a row blocked within this window is not re-sent; it is probed again after it. */
export const BLOCK_DEFER_MS = 24 * 60 * 60 * 1000
/** SMI-7113: how far back the defer lookup reads (a row keeps counting as known for 48h). */
const BLOCK_LOOKBACK_MS = 48 * 60 * 60 * 1000
const BLOCK_REPORT_CAP = 20
/** SMI-7113: PostgREST caps one response (default 1,000 rows), so the lookup pages. */
export const BLOCK_LOOKUP_PAGE_SIZE = 1000
/** SMI-7113: bound on lookup pages; hitting it is reported, never silently treated as complete. */
export const MAX_BLOCK_LOOKUP_PAGES = 20

/** SMI-7113: one row the upstream WAF refused, identified without its content. */
export interface BlockedRow {
  repoUrl: string
  fullName: string
  payloadBytes: number
  fieldLengths: Record<string, number>
  rayId: string | null
}

/** SMI-7113: knobs the caller reads from its own environment (this file stays env-free). */
export interface WafOptions {
  bisectDisabled?: boolean
  budget?: number
  nowMs?: number
}

/** SMI-7113: the block fields `flushUpsertAccumulator` adds to its result. */
export interface BlockOutcome {
  /** Rows sent and refused by the upstream WAF this flush (identity only). */
  blocked: BlockedRow[]
  /** The subset of `blocked` with no `indexer_upsert_blocked` row in the last 48h. */
  newlyBlocked: BlockedRow[]
  /** Rows held back because they were blocked less than 24h ago (not sent, not failed). */
  deferredCount: number
  blockBudgetExhausted: boolean
  bisectDisabled: boolean
  /** The 48h lookup hit its page bound: every repo it saw was deferred, none treated as new. */
  lookupTruncated: boolean
}

/** SMI-7113: run-level report; every producer sets all fields, consumers treat absent as 0. */
export interface UpsertBlockReport {
  upsert_blocked_count: number
  upsert_blocked: BlockedRow[]
  upsert_newly_blocked: BlockedRow[]
  upsert_deferred_count: number
  upsert_block_budget_exhausted: boolean
  upsert_bisect_disabled: boolean
  upsert_block_lookup_truncated: boolean
}

export function emptyBlockReport(): UpsertBlockReport {
  return {
    upsert_blocked_count: 0,
    upsert_blocked: [],
    upsert_newly_blocked: [],
    upsert_deferred_count: 0,
    upsert_block_budget_exhausted: false,
    upsert_bisect_disabled: false,
    upsert_block_lookup_truncated: false,
  }
}

export function toBlockReport(flush: BlockOutcome): UpsertBlockReport {
  return {
    upsert_blocked_count: flush.blocked.length,
    upsert_blocked: flush.blocked.slice(0, BLOCK_REPORT_CAP),
    upsert_newly_blocked: flush.newlyBlocked.slice(0, BLOCK_REPORT_CAP),
    upsert_deferred_count: flush.deferredCount,
    upsert_block_budget_exhausted: flush.blockBudgetExhausted,
    upsert_bisect_disabled: flush.bisectDisabled,
    upsert_block_lookup_truncated: flush.lookupTruncated,
  }
}

/** SMI-7113: parse the two env knobs; `read` is `Deno.env.get` or `process.env[k]`. */
export function resolveWafOptions(read: (name: string) => string | undefined): WafOptions {
  const sw = (read('SKILLSMITH_INDEXER_UPSERT_BISECT_DISABLE') ?? '').trim().toLowerCase()
  const raw = (read('INDEXER_UPSERT_BLOCK_BISECT_BUDGET') ?? '').trim()
  const n = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : 0
  return {
    bisectDisabled: sw === '1' || sw === 'true',
    budget: n >= 1 ? n : DEFAULT_BLOCK_BISECT_BUDGET,
  }
}

/**
 * SMI-7113: true only for the Cloudflare block page. postgrest-js hands back a non-JSON
 * body as `error = { message: <body> }` with no `code`, so the shape is: no code, HTTP
 * 403, an HTML document, and BOTH the block sentence and a Ray ID. A 5xx, status 0, a
 * JSON 403 (e.g. 42501) or an HTML body missing either marker is NOT a WAF block.
 */
export function isUpstreamBlock(
  error: { message?: unknown; code?: unknown } | null | undefined,
  status: number | undefined
): boolean {
  if (!error || error.code || status !== 403) return false
  const msg = typeof error.message === 'string' ? error.message : ''
  return (
    /^\s*<(!doctype|html)/i.test(msg) && /you have been blocked/i.test(msg) && /ray id/i.test(msg)
  )
}

function extractRayId(message: string): string | null {
  const m = message.match(/ray id:?\s*(?:<[^>]*>\s*)*([0-9a-f]{6,})/i)
  return m ? m[1] : null
}

/** Lengths only -- the identity log and audit row must never carry row content. */
function fieldLengthsOf(skillData: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(skillData)) {
    if (typeof v === 'string' || Array.isArray(v)) out[k] = v.length
    else if (v !== null && typeof v === 'object') out[k] = JSON.stringify(v).length
  }
  return out
}

/** SMI-7113: the lookup result; `truncated` means the page bound was hit before the window was exhausted. */
export interface RecentBlocks {
  recent: Map<string, number>
  truncated: boolean
}

/**
 * SMI-7113: repo_url -> newest `indexer_upsert_blocked` audit time (ms) in the lookback window.
 * Pages through the WHOLE window (newest first, deduplicating by repo_url as it goes). If
 * `MAX_BLOCK_LOOKUP_PAGES` full pages are still not enough, `truncated` is true: the map is
 * partial, so the caller defers the WHOLE flush (nothing sent, nothing newly blocked).
 */
export async function loadRecentBlocks(
  supabase: SupabaseClient,
  nowMs: number
): Promise<RecentBlocks> {
  const recent = new Map<string, number>()
  let truncated = false
  const since = new Date(nowMs - BLOCK_LOOKBACK_MS).toISOString()
  try {
    for (let page = 0; ; page++) {
      const from = page * BLOCK_LOOKUP_PAGE_SIZE
      const { data, error } = await supabase
        .from('audit_logs')
        .select('created_at, metadata')
        .eq('event_type', 'indexer_upsert_blocked')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + BLOCK_LOOKUP_PAGE_SIZE - 1)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as { created_at: string; metadata: { repo_url?: string } }[]
      for (const row of rows) {
        const url = row.metadata?.repo_url
        const at = Date.parse(row.created_at)
        if (url && Number.isFinite(at) && !recent.has(url)) recent.set(url, at)
      }
      if (rows.length < BLOCK_LOOKUP_PAGE_SIZE) break
      if (page + 1 >= MAX_BLOCK_LOOKUP_PAGES) {
        truncated = true
        console.warn(
          `[upsert-block] backoff lookup hit its ${MAX_BLOCK_LOOKUP_PAGES}-page bound; deferring the whole flush and treating none as newly blocked`
        )
        break
      }
    }
  } catch (lookupError) {
    // Fail open: with no history every blocked row is re-probed (and re-alerted), never hidden.
    const why = lookupError instanceof Error ? lookupError.message : String(lookupError)
    console.warn(`[upsert-block] backoff lookup failed, treating all rows as unblocked: ${why}`)
    recent.clear()
    truncated = false
  }
  return { recent, truncated }
}

/** SMI-7113: log the identity (never the content) and write ONE audit row for a sent-and-blocked row. */
export async function recordBlocked(
  supabase: SupabaseClient,
  item: { repo: { fullName: string }; skillData: Record<string, unknown> },
  message: string
): Promise<BlockedRow> {
  const { repo, skillData } = item
  const blocked: BlockedRow = {
    repoUrl: skillData.repo_url as string,
    fullName: repo.fullName,
    payloadBytes: new TextEncoder().encode(JSON.stringify(skillData)).length,
    fieldLengths: fieldLengthsOf(skillData),
    rayId: extractRayId(message),
  }
  console.warn('[upsert-block] row refused by upstream WAF', JSON.stringify(blocked))
  try {
    const { error } = await supabase.from('audit_logs').insert({
      event_type: 'indexer_upsert_blocked',
      actor: 'indexer',
      resource: repo.fullName,
      action: 'upsert_blocked',
      result: 'waf_blocked',
      metadata: {
        repo_url: blocked.repoUrl,
        full_name: blocked.fullName,
        payload_bytes: blocked.payloadBytes,
        field_lengths: blocked.fieldLengths,
        ray_id: blocked.rayId,
      },
    })
    if (error) console.error('[upsert-block] audit insert failed:', error.message)
  } catch (auditError) {
    console.error('[upsert-block] audit insert threw:', auditError)
  }
  return blocked
}
