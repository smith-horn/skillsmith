/**
 * SMI-7113: shared doubles for the upstream-WAF upsert tests.
 * @module scripts/tests/indexer/batch-upsert-waf.test-helpers
 *
 * `makeDb` plays PostgREST for `flushUpsertAccumulator`: the `skills` upsert answers
 * whatever `respond` says for that payload (synchronously, so a bisect runs in
 * milliseconds), and `audit_logs` is a small stateful store so a test can watch what a
 * flush writes and what a later flush reads back.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const T0 = Date.parse('2026-10-12T12:00:00.000Z')
export const HOUR = 60 * 60 * 1000
export const RAY_ID = '9a1b2c3d4e5f6789'

/** Shaped like the real Cloudflare page: DOCTYPE, the block sentence, and a Ray ID. */
export const CF_HTML =
  '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>' +
  `<h1>Sorry, you have been blocked</h1><p>Cloudflare Ray ID: <strong>${RAY_ID}</strong></p></body></html>`
export const ONLY_BLOCKED_HTML =
  '<!DOCTYPE html><html><body><h1>Sorry, you have been blocked</h1></body></html>'
export const ONLY_RAY_HTML = `<!DOCTYPE html><html><body><p>Cloudflare Ray ID: ${RAY_ID}</p></body></html>`

export type Row = Record<string, unknown>
export interface Resp {
  data: { repo_url: unknown }[] | null
  error: { message: string; code?: string } | null
  status?: number
}

export const blocked403: Resp = { data: null, error: { message: CF_HTML }, status: 403 }
export const okFor = (payload: Row[]): Resp => ({
  data: payload.map((p) => ({ repo_url: p.repo_url })),
  error: null,
  status: 201,
})

export const urlOf = (i: number) => `https://github.com/acme/skill-${i}`

/** `n` accumulator items. The description is a content marker no log or audit row may carry. */
export function makeItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    repo: { fullName: `acme/skill-${i}`, owner: 'acme', name: `skill-${i}` },
    skillData: {
      repo_url: urlOf(i),
      name: `skill-${i}`,
      description: `SECRET-CONTENT-${i}`,
      quarantined: false,
    } as Row,
  }))
}

/** Answer `bad` for any payload holding one of `urls`, else a clean echo. */
export const blockingRows =
  (urls: string[], bad: Resp = blocked403) =>
  (payload: Row[]): Resp =>
    payload.some((p) => urls.includes(p.repo_url as string)) ? bad : okFor(payload)

export interface DbCfg {
  respond: (payload: Row[]) => Resp
  /** Pre-existing `indexer_upsert_blocked` audit rows the lookup returns. */
  recent?: { created_at: string; metadata: { repo_url: string } }[]
  /** The audit lookup throws (a mock with no `.select`, or a network fault). */
  selectThrows?: boolean
  /** The audit lookup answers with an error for any page starting at or after this row offset. */
  errorFromOffset?: number
  /** Stamp for new block rows; shared so a test can advance time between flushes. */
  clock?: { now: number }
}

export function makeDb(cfg: DbCfg) {
  const upserts: Row[][] = []
  const audits: Row[] = []
  const store = [...(cfg.recent ?? [])]
  /** Every `.range(from, to)` the lookup issued, in order. */
  const ranges: [number, number][] = []
  const clock = cfg.clock ?? { now: T0 }
  const audit = {
    insert(row: Row) {
      audits.push(row)
      if (row.event_type === 'indexer_upsert_blocked') {
        const meta = row.metadata as { repo_url: string }
        store.unshift({
          created_at: new Date(clock.now).toISOString(),
          metadata: { repo_url: meta.repo_url },
        })
      }
      return Promise.resolve({ error: null })
    },
    select() {
      if (cfg.selectThrows) throw new TypeError('select is not a function')
      const q = {
        eq: () => q,
        gte: () => q,
        order: () => q,
        // The lookup must page: a bare `.limit(n)` answers the first n rows only.
        limit: (n: number) => Promise.resolve({ data: store.slice(0, n), error: null }),
        range: (from: number, to: number) => {
          ranges.push([from, to])
          if (cfg.errorFromOffset !== undefined && from >= cfg.errorFromOffset) {
            return Promise.resolve({ data: null, error: { message: 'page read failed' } })
          }
          return Promise.resolve({ data: store.slice(from, to + 1), error: null })
        },
      }
      return q
    },
  }
  const skills = {
    upsert(payload: Row[]) {
      upserts.push(payload)
      return { select: () => Promise.resolve(cfg.respond(payload)) }
    },
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  }
  const db = { from: (table: string) => (table === 'audit_logs' ? audit : skills) }
  const blockAudits = () => audits.filter((a) => a.event_type === 'indexer_upsert_blocked')
  return { db: db as unknown as SupabaseClient, upserts, audits, blockAudits, clock, ranges }
}

export const sentUrls = (upserts: Row[][]) => upserts.flat().map((p) => p.repo_url as string)

/** `n` audit rows for distinct repos, newest first, `ageMs` old at the newest and one second apart. */
export function fillerBlocks(n: number, ageMs: number, now = T0) {
  return Array.from({ length: n }, (_, i) => ({
    created_at: new Date(now - ageMs - i * 1000).toISOString(),
    metadata: { repo_url: `https://github.com/filler/repo-${ageMs}-${i}` },
  }))
}
