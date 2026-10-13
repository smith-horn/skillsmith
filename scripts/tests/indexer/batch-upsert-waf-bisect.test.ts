/**
 * SMI-7113: a Cloudflare block page that refuses ONE row must fail that row alone.
 * @module scripts/tests/indexer/batch-upsert-waf-bisect
 *
 * Before: the WAF refused a payload (403 + an HTML block page), `flushUpsertAccumulator`
 * failed the whole chunk, and every run that held the offending row lost the chunk.
 * Now: the block is bisected to the single row, that row is logged by identity (never
 * content) and given one `indexer_upsert_blocked` audit row, and the row is held back
 * for 24h so the next runs neither re-send nor re-alert it.
 *
 * Every case runs against BOTH twins (scripts/ is what production runs; the Deno twin
 * must behave identically). Each mock answers synchronously, so even the all-blocked case
 * finishes in milliseconds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as nodeMod from '../../indexer/indexer-runners.batch.ts'
import * as denoMod from '../../../supabase/functions/indexer/indexer-runners.batch.ts'
import {
  T0,
  HOUR,
  RAY_ID,
  CF_HTML,
  ONLY_BLOCKED_HTML,
  ONLY_RAY_HTML,
  blocked403,
  okFor,
  urlOf,
  makeItems,
  blockingRows,
  makeDb,
  sentUrls,
  type Row,
} from './batch-upsert-waf.test-helpers.ts'

type Mod = typeof nodeMod
const flush = (m: Mod, db: ReturnType<typeof makeDb>, n: number, waf = {}, chunk = 2000) =>
  m.flushUpsertAccumulator(db.db, makeItems(n), new Set(), chunk, { nowMs: T0, ...waf })

describe.each([
  ['scripts twin', nodeMod],
  ['Deno twin', denoMod],
] as [string, Mod][])('flushUpsertAccumulator upstream-WAF handling (%s)', (_label, m) => {
  // The identity log is expected output; keep the run quiet (individual tests re-spy to read it).
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('isolates the one blocked row: 52 land, 1 fails, 1 audit row, identity only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const t = makeDb({ respond: blockingRows([urlOf(17)]) })
    const r = await flush(m, t, 53)

    expect(r.failed).toBe(1)
    expect(r.indexed).toBe(52)
    expect(r.blocked.map((b) => b.repoUrl)).toEqual([urlOf(17)])
    expect(r.blocked[0]).toMatchObject({ fullName: 'acme/skill-17', rayId: RAY_ID })
    expect(r.newlyBlocked.map((b) => b.repoUrl)).toEqual([urlOf(17)])
    expect(r.blockBudgetExhausted).toBe(false)
    // O(log n): 53 rows, one bad row = 1 + 2 per halving over 6 halvings.
    expect(t.upserts).toHaveLength(13)
    expect(t.blockAudits()).toHaveLength(1)
    expect(t.blockAudits()[0]).toMatchObject({ resource: 'acme/skill-17' })
    expect(t.blockAudits()[0].metadata).toMatchObject({ repo_url: urlOf(17), ray_id: RAY_ID })
    // The error list names the row but never carries the HTML page.
    expect(r.errors.join('\n')).toContain('blocked by upstream WAF')
    expect(r.errors.join('\n')).not.toContain('<html')
    // Never content: not in the audit row, not in anything logged.
    const logged = JSON.stringify([t.audits, warn.mock.calls])
    expect(logged).not.toContain('SECRET-CONTENT')
    expect(logged).toContain('payloadBytes')
  })

  it('does not bisect a 503 (ambiguous: the statement may have run)', async () => {
    const t = makeDb({ respond: () => ({ ...blocked403, status: 503 }) })
    const r = await flush(m, t, 53)
    expect(t.upserts).toHaveLength(1)
    expect(r.failed).toBe(53)
    expect(r.blocked).toEqual([])
    expect(t.blockAudits()).toEqual([])
  })

  it.each([
    ['a block page with only "Ray ID"', ONLY_RAY_HTML, 403],
    ['a block page with only "you have been blocked"', ONLY_BLOCKED_HTML, 403],
    ['a FetchError (status 0)', 'TypeError: fetch failed', 0],
  ])('does not bisect %s', async (_name, message, status) => {
    const t = makeDb({ respond: () => ({ data: null, error: { message }, status }) })
    const r = await flush(m, t, 53)
    expect(t.upserts).toHaveLength(1)
    expect(r.failed).toBe(53)
    expect(r.blocked).toEqual([])
  })

  it('23502 (not-null) fails the whole chunk in exactly one request', async () => {
    const t = makeDb({
      respond: () => ({
        data: null,
        error: { message: 'null value in column "name"', code: '23502' },
        status: 400,
      }),
    })
    const r = await flush(m, t, 53)
    expect(t.upserts).toHaveLength(1)
    expect(r.failed).toBe(53)
  })

  it('a JSON 403 with a code (42501) is not a WAF block', async () => {
    const t = makeDb({
      respond: () => ({ data: null, error: { message: CF_HTML, code: '42501' }, status: 403 }),
    })
    const r = await flush(m, t, 53)
    expect(t.upserts).toHaveLength(1)
    expect(r.failed).toBe(53)
    expect(r.blocked).toEqual([])
  })

  it('all 2000 rows blocked: exactly 64 requests, budget exhausted, no unbounded fan-out', async () => {
    const t = makeDb({ respond: () => blocked403 })
    const r = await flush(m, t, 2000)
    expect(t.upserts).toHaveLength(64)
    expect(r.blockBudgetExhausted).toBe(true)
    expect(r.failed).toBe(2000)
    expect(r.blocked.length).toBeGreaterThan(0)
  })

  it('stops bisecting at the depth cap instead of walking an oversized chunk to single rows', async () => {
    const t = makeDb({ respond: () => blocked403 })
    // 5000 rows in one chunk reach 3 rows per request at depth 11; the cap fails that subtree unisolated.
    const r = await flush(m, t, 5000, { budget: 1_000_000 }, 5000)
    expect(t.upserts).toHaveLength(2 ** 12 - 1) // every node down to depth 11, none below
    expect(r.blocked).toEqual([])
    expect(r.failed).toBe(5000)
    expect(r.errors.join('\n')).toContain('bisect depth cap')
    expect(r.blockBudgetExhausted).toBe(false)
  })

  it('the budget is configurable per flush', async () => {
    const t = makeDb({ respond: () => blocked403 })
    await flush(m, t, 2000, { budget: 10 })
    expect(t.upserts).toHaveLength(10)
  })

  it('holds back a row blocked 2h ago: not sent, not failed, not re-alerted, no new audit row', async () => {
    const t = makeDb({
      respond: blockingRows([urlOf(17)]),
      recent: [
        { created_at: new Date(T0 - 2 * HOUR).toISOString(), metadata: { repo_url: urlOf(17) } },
      ],
    })
    const r = await flush(m, t, 53)
    expect(sentUrls(t.upserts)).not.toContain(urlOf(17))
    expect(r.deferredCount).toBe(1)
    expect(r.newlyBlocked).toEqual([])
    expect(r.failed).toBe(0)
    expect(r.indexed).toBe(52)
    expect(t.blockAudits()).toEqual([])
  })

  it('probes a row whose newest block is 25h old; it is known, so it does not re-alert', async () => {
    const t = makeDb({
      respond: blockingRows([urlOf(17)]),
      recent: [
        { created_at: new Date(T0 - 25 * HOUR).toISOString(), metadata: { repo_url: urlOf(17) } },
      ],
    })
    const r = await flush(m, t, 53)
    expect(sentUrls(t.upserts)).toContain(urlOf(17))
    expect(r.deferredCount).toBe(0)
    expect(r.blocked.map((b) => b.repoUrl)).toEqual([urlOf(17)])
    expect(r.newlyBlocked).toEqual([])
    expect(t.blockAudits()).toHaveLength(1)
  })

  it('a deferred row never refreshes its own block time: it ages out and is probed at 24h', async () => {
    const clock = { now: T0 }
    const t = makeDb({ respond: blockingRows([urlOf(17)]), clock })
    const run = (offsetMs: number) => {
      clock.now = T0 + offsetMs
      t.upserts.length = 0
      return m.flushUpsertAccumulator(t.db, makeItems(53), new Set(), 2000, { nowMs: clock.now })
    }
    const first = await run(0)
    expect(first.newlyBlocked).toHaveLength(1)
    const auditsAfterFirst = t.blockAudits().length

    const second = await run(2 * HOUR)
    expect(second.deferredCount).toBe(1)
    expect(sentUrls(t.upserts)).not.toContain(urlOf(17))
    expect(t.blockAudits()).toHaveLength(auditsAfterFirst) // the deferral wrote nothing

    const third = await run(25 * HOUR)
    expect(sentUrls(t.upserts)).toContain(urlOf(17)) // aged from T0, not from the deferral
    expect(third.deferredCount).toBe(0)
  })

  it('the kill switch restores whole-chunk failure and says so', async () => {
    const t = makeDb({ respond: blockingRows([urlOf(17)]) })
    const off = await flush(m, t, 53, { bisectDisabled: true })
    expect(t.upserts).toHaveLength(1)
    expect(off.failed).toBe(53)
    expect(off.bisectDisabled).toBe(true)
    expect(off.blocked).toEqual([])
    const on = await flush(m, makeDb({ respond: blockingRows([urlOf(17)]) }), 53)
    expect(on.bisectDisabled).toBe(false)
  })

  it('fails open when the audit lookup throws: every row is sent, nothing is deferred', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const t = makeDb({ respond: blockingRows([urlOf(17)]), selectThrows: true })
    const r = await flush(m, t, 53)
    expect(r.deferredCount).toBe(0)
    expect(sentUrls(t.upserts)).toContain(urlOf(17))
    expect(r.newlyBlocked).toHaveLength(1)
    expect(warn.mock.calls.flat().join(' ')).toContain('backoff lookup failed')
  })

  it('a clean flush reports zero blocks and an untouched budget', async () => {
    const t = makeDb({ respond: okFor })
    const r = await flush(m, t, 5)
    expect(r).toMatchObject({
      blocked: [],
      newlyBlocked: [],
      deferredCount: 0,
      bisectDisabled: false,
    })
    expect(r.blockBudgetExhausted).toBe(false)
    expect(t.blockAudits()).toEqual([])
  })

  it('still halves a timeout (57014) exactly as before', async () => {
    const t = makeDb({
      respond: (p: Row[]) =>
        p.length > 1
          ? {
              data: null,
              error: { message: 'canceling statement due to statement timeout', code: '57014' },
              status: 500,
            }
          : okFor(p),
    })
    const r = await flush(m, t, 4, {}, 4)
    expect(t.upserts.map((p) => p.length)).toEqual([4, 2, 1, 1, 2, 1, 1])
    expect(r.indexed).toBe(4)
  })
})
