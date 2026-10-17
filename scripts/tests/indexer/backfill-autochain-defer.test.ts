/**
 * SMI-7121 (Wave 2b-ii): the autochain's deferral markers. A fake Supabase project keeps
 * marker rows in memory and implements backfill_autochain_marker_transition's contract
 * (allowed pairs, conditional on the current state, patch merged with state last), so a
 * claim race and every reconcile outcome are observable without a database.
 */
import { describe, it, expect } from 'vitest'
import {
  MARKER_EVENT,
  MARKER_READ_LIMIT,
  MissingCredentials,
  MultipleOpenMarkers,
  RECONCILE_GRACE_MS,
  claim,
  clientsFromEnv,
  formatOutputs,
  insertDeferred,
  listLiveMarkers,
  reconcileConsumed,
  runCommand,
  scheduleTarget,
  transition,
} from '../../indexer/backfill-autochain-defer.ts'
import { listBackfillRunsCreatedSince } from '../../indexer/backfill-autochain-defer.github.ts'
import {
  NOW,
  fakeProject,
  marker,
  minutesAgo,
  projects,
  type Row,
} from './backfill-autochain-defer.fake.ts'

describe('insertDeferred', () => {
  it('writes exactly one marker row with the plan D5 shape and state open', async () => {
    const { client, calls } = fakeProject([])
    const m = {
      completed_run_id: '123',
      completed_run_attempt: 2,
      supabase_env: 'staging' as const,
      path_prefix: '.claude/skills',
      dry_run: false,
      deferred_at: NOW.toISOString(),
      next_window_utc: '2026-10-16T15:00:00.000Z',
      deferred_by_autochain_run: '777',
    }
    const id = await insertDeferred(client, m)
    expect(id).toBe('m1')
    expect(calls.inserts).toEqual([
      {
        event_type: 'indexer_backfill_autochain_deferred',
        actor: 'system',
        action: 'backfill_autochain_deferred',
        resource: '123',
        metadata: { ...m, state: 'open' },
      },
    ])
  })

  it('a failed insert throws', async () => {
    const { client } = fakeProject([], { insert: 'permission denied' })
    await expect(
      insertDeferred(client, {
        completed_run_id: '1',
        completed_run_attempt: 1,
        supabase_env: 'prod',
        path_prefix: '',
        dry_run: false,
        deferred_at: NOW.toISOString(),
        next_window_utc: NOW.toISOString(),
        deferred_by_autochain_run: '2',
      })
    ).rejects.toThrow(/insert failed: permission denied/)
  })
})

describe('listLiveMarkers and live-check', () => {
  const prod = () => [
    marker('a', { state: 'open' }),
    marker('b', { state: 'consumed' }),
    marker('c', { state: 'consumed', dispatched_run_id: '' }),
    marker('d', { state: 'consumed', dispatched_run_id: '555' }),
    marker('e', { state: 'dispatched', dispatched_run_id: '556' }),
    marker('f', { state: 'needs_intervention' }),
    { ...marker('g', { state: 'open' }), event_type: 'indexer_backfill_checkpoint' },
  ]

  it('counts open, and consumed without (or with an empty) dispatched_run_id, across BOTH projects', async () => {
    const { clients, p, s } = projects(prod(), [
      marker('s1', { state: 'open', supabase_env: 'staging' }),
    ])
    const live = await listLiveMarkers(clients)
    expect(live.map((m) => `${m.env}:${m.id}:${m.state}`)).toEqual([
      'prod:a:open',
      'prod:b:consumed',
      'prod:c:consumed',
      'staging:s1:open',
    ])
    // each project is queried on the marker event type, server-side narrowed to open/consumed
    for (const proj of [p, s]) {
      expect(proj.calls.filters[0]).toContainEqual(['eq', 'event_type', MARKER_EVENT])
      expect(proj.calls.filters[0]).toContainEqual(['in', 'metadata->>state', ['open', 'consumed']])
    }
  })

  describe('the read limit and its truncation guard are coupled (G3)', () => {
    const open = (n: number) =>
      Array.from({ length: n }, (_, i) => marker(`m${i}`, { state: 'open' }))

    it('the query asks for exactly MARKER_READ_LIMIT rows', async () => {
      const { clients, p } = projects([])
      await listLiveMarkers(clients)
      expect(p.calls.filters[0]).toContainEqual(['limit', MARKER_READ_LIMIT])
    })

    it('exactly MARKER_READ_LIMIT rows throws (the set may have been cut off)', async () => {
      await expect(listLiveMarkers(projects(open(MARKER_READ_LIMIT)).clients)).rejects.toThrow(
        /hit its \d+-row limit/
      )
    })

    it('more rows than the limit throws (the database returns only the limit)', async () => {
      await expect(listLiveMarkers(projects(open(MARKER_READ_LIMIT + 5)).clients)).rejects.toThrow(
        /hit its \d+-row limit/
      )
    })

    it('CONTROL: one row fewer than the limit is read in full', async () => {
      const live = await listLiveMarkers(projects(open(MARKER_READ_LIMIT - 1)).clients)
      expect(live).toHaveLength(MARKER_READ_LIMIT - 1)
    })
  })

  it('a read error in either project throws (never a zero count)', async () => {
    const ok = fakeProject([marker('a', { state: 'open' })])
    const bad = fakeProject([], { read: 'timeout' })
    await expect(listLiveMarkers({ prod: ok.client, staging: bad.client })).rejects.toThrow(
      /env=staging: timeout/
    )
    await expect(listLiveMarkers({ prod: bad.client, staging: ok.client })).rejects.toThrow(
      /env=prod: timeout/
    )
  })

  it('a missing credential for either project throws MissingCredentials', () => {
    const full = {
      SUPABASE_URL: 'u',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      SUPABASE_URL_STAGING: 'us',
      SUPABASE_SERVICE_ROLE_KEY_STAGING: 'ks',
    }
    const make = () => fakeProject([]).client
    expect(() => clientsFromEnv(full, make)).not.toThrow()
    expect(() => clientsFromEnv({ ...full, SUPABASE_SERVICE_ROLE_KEY_STAGING: '' }, make)).toThrow(
      MissingCredentials
    )
    expect(() => clientsFromEnv({ ...full, SUPABASE_URL: undefined }, make)).toThrow(
      MissingCredentials
    )
  })

  it('the live-check CLI reports the cross-project count', async () => {
    const p = fakeProject(prod())
    const s = fakeProject([marker('s1', { state: 'open', supabase_env: 'staging' })])
    const out = await runCommand('live-check', {
      penv: {
        SUPABASE_URL: 'p',
        SUPABASE_SERVICE_ROLE_KEY: 'k',
        SUPABASE_URL_STAGING: 's',
        SUPABASE_SERVICE_ROLE_KEY_STAGING: 'k',
      },
      makeClient: (url) => (url === 'p' ? p.client : s.client),
    })
    expect(out.live_count).toBe('4')
    expect(out.live).toContain('staging:s1')
  })

  it('CONTROL: no live marker anywhere reports 0', async () => {
    const { clients } = projects([marker('d', { state: 'dispatched' })])
    expect(await listLiveMarkers(clients)).toEqual([])
  })
})

describe('scheduleTarget', () => {
  it('zero open markers: resume=false with a reason (a consumed marker is not resumable)', async () => {
    const { clients } = projects([marker('b', { state: 'consumed' })])
    const t = await scheduleTarget(clients)
    expect(t).toEqual({ resume: false, reason: expect.stringMatching(/No open deferral marker/) })
  })

  it('exactly one open marker: resume=true with its run, attempt and env', async () => {
    const { clients } = projects(
      [],
      [
        marker('s1', {
          state: 'open',
          supabase_env: 'staging',
          completed_run_id: 4242,
          completed_run_attempt: 2,
        }),
      ]
    )
    expect(await scheduleTarget(clients)).toEqual({
      resume: true,
      markerId: 's1',
      completedRunId: '4242',
      completedRunAttempt: '2',
      supabaseEnv: 'staging',
      acknowledgedHalts: '',
    })
  })

  it.each([
    ['an undispatched consumed marker', { state: 'consumed' }],
    [
      'a consumed marker with an empty dispatched_run_id',
      { state: 'consumed', dispatched_run_id: '' },
    ],
  ])('%s next to an open one: throws (V4, matching live-check)', async (_l, meta) => {
    const { clients } = projects(
      [marker('a', { state: 'open' })],
      [marker('c', { ...meta, supabase_env: 'staging' })]
    )
    const err = await scheduleTarget(clients).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MultipleOpenMarkers)
    expect((err as MultipleOpenMarkers).markers.map((m) => `${m.id}:${m.state}`)).toEqual([
      'a:open',
      'c:consumed',
    ])
  })

  it('CONTROL: a DISPATCHED consumed marker next to an open one does not refuse', async () => {
    const { clients } = projects([
      marker('a', { state: 'open' }),
      marker('d', { state: 'consumed', dispatched_run_id: '9' }),
    ])
    expect(await scheduleTarget(clients)).toMatchObject({ resume: true, markerId: 'a' })
  })

  it('more than one open marker (even across projects): throws, never picks one', async () => {
    const { clients } = projects(
      [marker('a', { state: 'open' })],
      [marker('s1', { state: 'open', supabase_env: 'staging' })]
    )
    const err = await scheduleTarget(clients).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MultipleOpenMarkers)
    expect((err as MultipleOpenMarkers).markers.map((m) => m.id)).toEqual(['a', 's1'])
  })

  it('the CLI turns several open markers into a thrown MultipleOpenMarkers (the exit-2 path)', async () => {
    const p = fakeProject([marker('a', { state: 'open' }), marker('b', { state: 'open' })])
    const s = fakeProject([])
    await expect(
      runCommand('schedule-target', {
        penv: {
          SUPABASE_URL: 'p',
          SUPABASE_SERVICE_ROLE_KEY: 'k',
          SUPABASE_URL_STAGING: 's',
          SUPABASE_SERVICE_ROLE_KEY_STAGING: 'k',
        },
        makeClient: (url) => (url === 'p' ? p.client : s.client),
      })
    ).rejects.toBeInstanceOf(MultipleOpenMarkers)
  })

  it('a marker whose recorded env differs from its project, or with a malformed run id, throws', async () => {
    await expect(
      scheduleTarget(projects([marker('a', { state: 'open', supabase_env: 'staging' })]).clients)
    ).rejects.toThrow(/records supabase_env/)
    await expect(
      scheduleTarget(projects([marker('a', { state: 'open', completed_run_id: '12;x' })]).clients)
    ).rejects.toThrow(/malformed/)
  })

  it('a read error throws', async () => {
    const bad = fakeProject([], { read: 'boom' })
    await expect(
      scheduleTarget({ prod: bad.client, staging: fakeProject([]).client })
    ).rejects.toThrow(/boom/)
  })
})

describe('transition and claim', () => {
  it('passes the four RPC arguments and returns its boolean', async () => {
    const { client, calls } = fakeProject([marker('a', { state: 'open' })])
    expect(await transition(client, 'a', 'open', 'needs_intervention', { reason: 'r' })).toBe(true)
    expect(calls.rpc).toEqual([
      {
        name: 'backfill_autochain_marker_transition',
        args: { p_id: 'a', p_from: 'open', p_to: 'needs_intervention', p_patch: { reason: 'r' } },
      },
    ])
  })

  it('an RPC error throws, and a non-boolean result throws', async () => {
    await expect(
      transition(fakeProject([], { rpc: 'not allowed' }).client, 'a', 'open', 'consumed', {})
    ).rejects.toThrow(/not allowed/)
    await expect(
      transition(fakeProject([], { rpcData: null }).client, 'a', 'open', 'consumed', {})
    ).rejects.toThrow(/not a boolean/)
  })

  it('claim: the first claim wins (true), a second claim on the same marker is false', async () => {
    const { client, rows } = fakeProject([marker('a', { state: 'open' })])
    expect(await claim(client, 'a', '111', NOW)).toBe(true)
    expect(rows[0].metadata).toMatchObject({
      state: 'consumed',
      consumed_by_autochain_run: '111',
      consumed_at: NOW.toISOString(),
    })
    expect(await claim(client, 'a', '222', NOW)).toBe(false)
    expect(rows[0].metadata.consumed_by_autochain_run).toBe('111')
  })

  it('the claim CLI emits claimed=true|false', async () => {
    const p = fakeProject([marker('a', { state: 'open' })])
    const penv = {
      SUPABASE_URL: 'p',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      MARKER_ID: 'a',
      MARKER_ENV: 'prod',
      GITHUB_RUN_ID: '9',
    }
    expect(await runCommand('claim', { penv, makeClient: () => p.client, now: NOW })).toEqual({
      claimed: 'true',
    })
    expect(await runCommand('claim', { penv, makeClient: () => p.client, now: NOW })).toEqual({
      claimed: 'false',
    })
  })
})

describe('reconcileConsumed', () => {
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

  async function reconcile(rows: Row[], runs: Array<{ id: number; display_title: string }>) {
    const { clients, p } = projects(rows)
    const sinces: string[] = []
    const r = await reconcileConsumed({
      clientsByEnv: clients,
      listRuns: async (since) => (sinces.push(since), runs),
      autochainRunId: '5000',
      now: NOW,
    })
    return { r, rows: p.rows, sinces }
  }

  it('exactly one run carries the token: consumed -> dispatched with its run id', async () => {
    const { r, rows, sinces } = await reconcile(
      [consumed('a', '111', 3)],
      [run(7001, 'ac-111'), run(7002, 'drv-x')]
    )
    expect(r.dispatched).toEqual([{ env: 'prod', id: 'a', dispatched_run_id: '7001' }])
    expect(rows[0].metadata).toMatchObject({ state: 'dispatched', dispatched_run_id: '7001' })
    // the scan starts 5 minutes before consumed_at
    expect(sinces).toEqual([minutesAgo(8)])
  })

  it('no run, and consumed_at older than 15 minutes: consumed -> needs_intervention, reported', async () => {
    const { r, rows } = await reconcile([consumed('a', '111', RECONCILE_GRACE_MS / 60000 + 1)], [])
    expect(r.needsIntervention).toEqual([
      {
        env: 'prod',
        id: 'a',
        completed_run_id: '900',
        reason: expect.stringMatching(/no indexer-backfill run carries \[tok=ac-111\]/),
      },
    ])
    expect(rows[0].metadata.state).toBe('needs_intervention')
  })

  it('no run, and still fresh: left consumed', async () => {
    const { r, rows } = await reconcile([consumed('a', '111', 5)], [])
    expect(r.left).toEqual([{ env: 'prod', id: 'a' }])
    expect(r.needsIntervention).toEqual([])
    expect(rows[0].metadata.state).toBe('consumed')
  })

  it('two runs carry the token: consumed -> needs_intervention', async () => {
    const { r, rows } = await reconcile(
      [consumed('a', '111', 3)],
      [run(7001, 'ac-111'), run(7003, 'ac-111')]
    )
    expect(r.needsIntervention[0].reason).toMatch(/2 indexer-backfill runs carry/)
    expect(rows[0].metadata.state).toBe('needs_intervention')
  })

  it('the token match is exact: ac-1111 does not satisfy a claim by run 111', async () => {
    const { r } = await reconcile([consumed('a', '111', 3)], [run(7001, 'ac-1111')])
    expect(r.left).toEqual([{ env: 'prod', id: 'a' }])
  })

  it('a dispatched or already-recorded marker is not touched; open markers are ignored', async () => {
    const { r } = await reconcile(
      [marker('o', { state: 'open' }), marker('d', { state: 'consumed', dispatched_run_id: '1' })],
      []
    )
    expect(r).toEqual({ dispatched: [], needsIntervention: [], left: [] })
  })

  it('a run-list failure throws (an unread list is never "no match")', async () => {
    const { clients } = projects([consumed('a', '111', 30)])
    await expect(
      reconcileConsumed({
        clientsByEnv: clients,
        listRuns: async () => {
          throw new Error('HTTP 502')
        },
        autochainRunId: '1',
        now: NOW,
      })
    ).rejects.toThrow(/HTTP 502/)
  })

  it('the reconcile CLI emits the moved markers as JSON', async () => {
    const p = fakeProject([consumed('a', '111', 30)])
    const s = fakeProject([])
    const out = await runCommand('reconcile', {
      penv: {
        SUPABASE_URL: 'p',
        SUPABASE_SERVICE_ROLE_KEY: 'k',
        SUPABASE_URL_STAGING: 's',
        SUPABASE_SERVICE_ROLE_KEY_STAGING: 'k',
        GITHUB_RUN_ID: '9',
      },
      makeClient: (url) => (url === 'p' ? p.client : s.client),
      listRuns: async () => [],
      now: NOW,
    })
    expect(out.moved_count).toBe('1')
    expect(JSON.parse(out.moved)).toEqual([expect.objectContaining({ env: 'prod', id: 'a' })])
  })
})

describe('listBackfillRunsCreatedSince', () => {
  const page = (n: number, from: number) => ({
    workflow_runs: Array.from({ length: n }, (_, i) => ({
      id: from + i,
      display_title: `t${from + i}`,
    })),
  })
  const fetchOf = (pages: unknown[], status = 200) => {
    const urls: string[] = []
    const f = async (url: string) => {
      urls.push(url)
      const body = pages[urls.length - 1]
      return { ok: status === 200, status, json: async () => body }
    }
    return { f, urls }
  }

  it('reads every page until a short one, filtered on created>= the given time', async () => {
    const { f, urls } = fetchOf([page(100, 1), page(3, 101)])
    const runs = await listBackfillRunsCreatedSince({
      repo: 'o/r',
      token: 't',
      createdSinceIso: NOW.toISOString(),
      fetchImpl: f,
    })
    expect(runs).toHaveLength(103)
    expect(urls).toHaveLength(2)
    expect(decodeURIComponent(urls[0])).toContain(`created=>=${NOW.toISOString()}`)
    expect(urls[1]).toContain('page=2')
  })

  it('a non-2xx, a malformed entry or too many pages throws', async () => {
    const base = { repo: 'o/r', token: 't', createdSinceIso: NOW.toISOString() }
    await expect(
      listBackfillRunsCreatedSince({ ...base, fetchImpl: fetchOf([page(1, 1)], 502).f })
    ).rejects.toThrow(/HTTP 502/)
    await expect(
      listBackfillRunsCreatedSince({
        ...base,
        fetchImpl: fetchOf([{ workflow_runs: [{ id: 1 }] }]).f,
      })
    ).rejects.toThrow(/incomplete entry/)
    await expect(
      listBackfillRunsCreatedSince({
        ...base,
        fetchImpl: fetchOf(Array.from({ length: 11 }, (_, i) => page(100, i * 100))).f,
      })
    ).rejects.toThrow(/More than 10 pages/)
  })
})

describe('formatOutputs', () => {
  it('a value containing a newline and a would-be key cannot inject another output', () => {
    const text = formatOutputs({ reason: 'a\nclaimed=true' })
    const [first] = text.split('\n')
    const delim = first.replace('reason<<', '')
    expect(delim).toMatch(/^ghadelim_[0-9a-f]{24}$/)
    expect(text).toBe(`reason<<${delim}\na\nclaimed=true\n${delim}\n`)
    // two calls use different delimiters (unpredictable, so a value cannot close it)
    expect(formatOutputs({ x: '1' })).not.toBe(formatOutputs({ x: '1' }))
  })
})
