/**
 * SMI-7142: the scoped reconcile (`reconcile-marker`) evaluates and transitions ONLY the
 * marker the post-dispatch step claimed, and the reconcile CLI reports the ids it moved.
 */
import { describe, it, expect } from 'vitest'
import { reconcileConsumed, runCommand } from '../../indexer/backfill-autochain-defer.ts'
import { NOW, fakeProject, marker, minutesAgo, projects } from './backfill-autochain-defer.fake.ts'

const consumed = (id: string, by: string, consumedMinutesAgo: number) =>
  marker(id, {
    state: 'consumed',
    consumed_by_autochain_run: by,
    consumed_at: minutesAgo(consumedMinutesAgo),
  })
const run = (id: number, tok: string) => ({
  id,
  display_title: `Skill Indexer Backfill (env=prod) [tok=${tok}]`,
})
const mine = { env: 'prod' as const, id: 'a' }

async function scoped(rows: ReturnType<typeof consumed>[], runs: ReturnType<typeof run>[]) {
  const { clients, p } = projects(rows)
  const r = await reconcileConsumed({
    clientsByEnv: clients,
    listRuns: async () => runs,
    autochainRunId: '5000',
    now: NOW,
    only: mine,
  })
  return { r, rows: p.rows }
}
const stateOf = (rows: { id: string; metadata: Record<string, unknown> }[], id: string) =>
  rows.find((x) => x.id === id)!.metadata.state

describe('reconcileConsumed scoped to one marker', () => {
  it('only the OTHER marker has a matching run: ours is not reported dispatched, the other is untouched', async () => {
    const { r, rows } = await scoped(
      [consumed('a', '111', 3), consumed('b', '222', 3)],
      [run(7002, 'ac-222')]
    )
    expect(r.dispatched).toEqual([])
    expect(r.left).toEqual([{ env: 'prod', id: 'a' }])
    expect(stateOf(rows, 'a')).toBe('consumed')
    expect(stateOf(rows, 'b')).toBe('consumed')
  })

  it('the OTHER marker has several matching runs: it stays untouched by the scoped call', async () => {
    const { r, rows } = await scoped(
      [consumed('a', '111', 3), consumed('b', '222', 3)],
      [run(7002, 'ac-222'), run(7003, 'ac-222')]
    )
    expect(r.needsIntervention).toEqual([])
    expect(stateOf(rows, 'b')).toBe('consumed')
    expect(stateOf(rows, 'a')).toBe('consumed')
  })

  it('a stale OTHER marker past the grace is untouched too', async () => {
    const { r, rows } = await scoped([consumed('a', '111', 3), consumed('b', '222', 60)], [])
    expect(r.needsIntervention).toEqual([])
    expect(stateOf(rows, 'b')).toBe('consumed')
  })

  it('our own marker with its run is dispatched while the other stays untouched', async () => {
    const { r, rows } = await scoped(
      [consumed('a', '111', 3), consumed('b', '222', 3)],
      [run(7001, 'ac-111'), run(7002, 'ac-222')]
    )
    expect(r.dispatched).toEqual([{ env: 'prod', id: 'a', dispatched_run_id: '7001' }])
    expect(stateOf(rows, 'a')).toBe('dispatched')
    expect(stateOf(rows, 'b')).toBe('consumed')
  })

  it('a marker with the same id in the OTHER project is not ours', async () => {
    const { clients, s } = projects([], [consumed('a', '111', 3)])
    const r = await reconcileConsumed({
      clientsByEnv: clients,
      listRuns: async () => [run(7001, 'ac-111')],
      autochainRunId: '5000',
      now: NOW,
      only: mine,
    })
    expect(r.dispatched).toEqual([])
    expect(stateOf(s.rows, 'a')).toBe('consumed')
  })
})

describe('the reconcile CLI', () => {
  const penv = {
    SUPABASE_URL: 'p',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    SUPABASE_URL_STAGING: 's',
    SUPABASE_SERVICE_ROLE_KEY_STAGING: 'k',
    GITHUB_RUN_ID: '9',
  }
  const deps = (p: ReturnType<typeof fakeProject>, runs: ReturnType<typeof run>[]) => ({
    makeClient: (url: string) => (url === 'p' ? p.client : fakeProject([]).client),
    listRuns: async () => runs,
    now: NOW,
  })

  it('reconcile reports dispatched_ids and needs_intervention_ids, keeping the old keys', async () => {
    const p = fakeProject([
      consumed('a', '111', 3),
      consumed('b', '222', 30),
      consumed('c', '333', 3),
    ])
    const out = await runCommand('reconcile', { penv, ...deps(p, [run(7001, 'ac-111')]) })
    expect(out.dispatched_ids).toBe('a')
    expect(out.needs_intervention_ids).toBe('b')
    expect(out).toMatchObject({ moved_count: '1', dispatched_count: '1', left_count: '1' })
  })

  it('reconcile-marker touches only MARKER_ID in MARKER_ENV and reports it', async () => {
    const p = fakeProject([consumed('a', '111', 3), consumed('b', '222', 30)])
    const out = await runCommand('reconcile-marker', {
      penv: { ...penv, MARKER_ID: 'a', MARKER_ENV: 'prod' },
      ...deps(p, [run(7001, 'ac-111')]),
    })
    expect(out.dispatched_ids).toBe('a')
    expect(out.needs_intervention_ids).toBe('')
    expect(out.moved_count).toBe('0')
    expect(stateOf(p.rows, 'b')).toBe('consumed')
  })

  it('reconcile-marker requires MARKER_ID and a valid MARKER_ENV', async () => {
    const p = fakeProject([])
    await expect(
      runCommand('reconcile-marker', { penv: { ...penv, MARKER_ENV: 'prod' }, ...deps(p, []) })
    ).rejects.toThrow(/MARKER_ID/)
    await expect(
      runCommand('reconcile-marker', {
        penv: { ...penv, MARKER_ID: 'a', MARKER_ENV: 'dev' },
        ...deps(p, []),
      })
    ).rejects.toThrow(/MARKER_ENV/)
  })
})
