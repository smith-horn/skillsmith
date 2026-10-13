/**
 * SMI-7112: loadResumeCheckpoint is the run.ts backfill resume read. A failed
 * read must abort the dispatch (throw) -- falling through restarts the prefix.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadResumeCheckpoint } from '../../indexer/backfill-resume.ts'

const goodPayload = {
  run_id: 'run-1',
  cursor: { path: '', facet: 'f1', last_page: 1 },
  facets_completed: 1,
  facets_total: 5,
  cap_saturated: false,
  truncated_repo_count: 0,
  incomplete_results_ranges: 0,
  dry_run: false,
}

function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const eqCalls: Array<[string, string]> = []
  const chain = {
    eq: (k: string, v: string) => {
      eqCalls.push([k, v])
      return chain
    },
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve(result),
  }
  return { client: { from: () => ({ select: () => chain }) } as unknown as SupabaseClient, eqCalls }
}

describe('loadResumeCheckpoint', () => {
  it('REJECTS on a read error, after exactly one read scoped to RESUME_FROM', async () => {
    const { client, eqCalls } = makeClient({ data: null, error: { message: 'timeout' } })
    const settled = await loadResumeCheckpoint(client, 'run-77', false).then(
      (value) => ({ value }),
      (err: Error) => ({ err })
    )
    // First prove the read branch ran (exactly one query, scoped to RESUME_FROM)...
    expect(eqCalls.filter(([k]) => k === 'metadata->>run_id')).toEqual([
      ['metadata->>run_id', 'run-77'],
    ])
    // ...then that it aborted rather than falling through to a cold start.
    expect('err' in settled, 'a failed read must reject, not resolve').toBe(true)
    expect((settled as { err: Error }).err.message).toMatch(/aborting/)
  })

  it('REJECTS on a malformed row (never a cold start)', async () => {
    const { client } = makeClient({ data: { metadata: {} }, error: null })
    await expect(loadResumeCheckpoint(client, 'latest', false)).rejects.toThrow(/malformed/)
  })

  it('returns null for none (a coldstart-<prefix> id matches no row => fresh crawl)', async () => {
    const { client } = makeClient({ data: null, error: null })
    expect(await loadResumeCheckpoint(client, 'coldstart-x', false)).toBeNull()
  })

  it('returns the payload when found', async () => {
    const { client } = makeClient({ data: { metadata: goodPayload }, error: null })
    expect(await loadResumeCheckpoint(client, 'run-1', false)).toEqual(goodPayload)
  })
})

describe('run.ts wiring', () => {
  const runSrc = readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'indexer'), 'run.ts'),
    'utf8'
  )
  it('reads the resume checkpoint only through loadResumeCheckpoint (never a swallowing reader)', () => {
    expect(runSrc).toMatch(/await loadResumeCheckpoint\(supabase, resumeFrom, env\.DRY_RUN\)/)
    expect(runSrc).not.toMatch(/readLatestCheckpoint/)
    expect(runSrc).not.toMatch(/\breadCheckpoint\(/)
  })
})
