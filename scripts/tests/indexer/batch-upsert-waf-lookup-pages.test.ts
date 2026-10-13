/**
 * SMI-7113: the 48h block-history lookup must see the WHOLE window, not its newest 1,000 rows.
 * @module scripts/tests/indexer/batch-upsert-waf-lookup-pages
 *
 * The defer guard and the "newly blocked" alert both read that lookup. A lookup that stops
 * at one PostgREST page lets an older, still-recent repo fall off the end: it is re-sent
 * inside its 24h window and re-alerted as new. Both twins run every case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as nodeMod from '../../indexer/indexer-runners.batch.ts'
import * as denoMod from '../../../supabase/functions/indexer/indexer-runners.batch.ts'
import {
  T0,
  HOUR,
  blockingRows,
  fillerBlocks,
  makeDb,
  makeItems,
  sentUrls,
  urlOf,
} from './batch-upsert-waf.test-helpers.ts'

type Mod = typeof nodeMod
const TARGET = urlOf(17)
const targetRow = (ageMs: number) => ({
  created_at: new Date(T0 - ageMs).toISOString(),
  metadata: { repo_url: TARGET },
})
const flush = (m: Mod, db: ReturnType<typeof makeDb>) =>
  m.flushUpsertAccumulator(db.db, makeItems(53), new Set(), 2000, { nowMs: T0 })

describe.each([
  ['scripts twin', nodeMod],
  ['Deno twin', denoMod],
] as [string, Mod][])('block-history lookup completeness (%s)', (_label, m) => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('defers a repo that is only on page two behind 1,100 newer rows', async () => {
    const t = makeDb({
      respond: blockingRows([TARGET]),
      recent: [...fillerBlocks(1100, 10 * 60 * 1000), targetRow(2 * HOUR)],
    })
    const r = await flush(m, t)

    expect(t.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    expect(sentUrls(t.upserts)).not.toContain(TARGET)
    expect(r.deferredCount).toBe(1)
    expect(r.failed).toBe(0)
    expect(r.blocked).toEqual([])
    expect(r.newlyBlocked).toEqual([])
    expect(t.blockAudits()).toEqual([])
    expect(r.lookupTruncated).toBe(false)
  })

  it('keeps asking until a short page: 2,500 rows take three pages and are not truncated', async () => {
    const t = makeDb({
      respond: blockingRows([TARGET]),
      recent: [...fillerBlocks(2400, 10 * 60 * 1000), targetRow(2 * HOUR)],
    })
    const r = await flush(m, t)
    expect(t.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
    expect(r.deferredCount).toBe(1)
    expect(r.lookupTruncated).toBe(false)
  })

  it('a 25h-old block beyond page one is probed, and is known (not newly blocked)', async () => {
    const t = makeDb({
      respond: blockingRows([TARGET]),
      recent: [...fillerBlocks(1100, 10 * 60 * 1000), targetRow(25 * HOUR)],
    })
    const r = await flush(m, t)
    expect(sentUrls(t.upserts)).toContain(TARGET)
    expect(r.blocked.map((b) => b.repoUrl)).toEqual([TARGET])
    expect(r.newlyBlocked).toEqual([])
  })

  it('at the page bound it defers every repo it saw, treats none as new, and says so', async () => {
    // 19,999 newer rows, then the target (25h old: normally probed), then 100 older rows.
    const t = makeDb({
      respond: blockingRows([TARGET]),
      recent: [
        ...fillerBlocks(19_999, 10 * 60 * 1000),
        targetRow(25 * HOUR),
        ...fillerBlocks(100, 30 * HOUR),
      ],
    })
    const r = await flush(m, t)

    expect(t.ranges).toHaveLength(20)
    expect(r.lookupTruncated).toBe(true)
    expect(sentUrls(t.upserts)).not.toContain(TARGET)
    expect(r.deferredCount).toBe(1)
    expect(r.newlyBlocked).toEqual([])
    expect(t.blockAudits()).toEqual([])
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('page bound')
    expect(m.toBlockReport(r).upsert_block_lookup_truncated).toBe(true)
  })

  it('a page read that fails mid-lookup fails open: page one is discarded, nothing deferred, not truncated', async () => {
    // The target is on page ONE (read before page two fails): a lookup that kept the partial
    // map would defer it; fail-open must forget it.
    const t = makeDb({
      respond: blockingRows([TARGET]),
      recent: [targetRow(5 * 60 * 1000), ...fillerBlocks(1100, 10 * 60 * 1000)],
      errorFromOffset: 1000,
    })
    const r = await flush(m, t)
    expect(sentUrls(t.upserts)).toContain(TARGET)
    expect(r.deferredCount).toBe(0)
    expect(r.lookupTruncated).toBe(false)
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('lookup failed')
  })

  it('reports an untouched lookup as not truncated in the run report', () => {
    expect(m.emptyBlockReport().upsert_block_lookup_truncated).toBe(false)
  })
})
