/**
 * SMI-7112: recover() / env-selection coverage for the backfill autochain.
 *
 * Every outcome the plan names must be DISTINCT: positive (re-dispatch), `none`
 * (legitimate skip), and error / missing-credentials / incomplete-intent /
 * indeterminate (all THROW -- red job, never a silent skip).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  IncompleteIntent,
  MalformedDispatchInputs,
  MissingCredentials,
  parseSupabaseEnvFromTitle,
  recover,
} from '../../indexer/backfill-autochain-inputs.ts'

const dispatchInputs = {
  maxSkillsPerRepo: '50',
  pathPrefix: '.agents/skills',
  maxRanges: 10,
  minSizeBytes: 1024,
  maxSkillsPerDispatch: 5000,
  maxElapsedMinutes: 280,
  acceptTruncation: false,
  supabaseEnv: 'prod',
  tokenSource: 'backfill',
}

/** A checkpoint row shaped like the real prod run 38013586443's. */
const prodCheckpoint = {
  run_id: '38013586443',
  cursor: { path: '.agents/skills', facet: 'f3', last_page: 2 },
  facets_completed: 3,
  facets_total: 10,
  cap_saturated: false,
  truncated_repo_count: 0,
  incomplete_results_ranges: 0,
  dry_run: false,
  dispatch_inputs: dispatchInputs,
}

interface MockOpts {
  checkpointRow?: { metadata: unknown } | null
  auditRow?: { metadata: unknown } | null
  checkpointError?: { message: string } | null
  /** Result of the retry-cap count query (the audit_logs query limited to 50 rows). */
  count?: { data: unknown; error: { message: string } | null }
}

/** Discriminates the two audit_logs queries by their event_type filter. */
function makeClient(opts: MockOpts) {
  const created: Array<{ url: string; key: string }> = []
  const factory = (url: string, key: string) => {
    created.push({ url, key })
    return {
      from: vi.fn().mockImplementation(() => {
        let eventType: string | undefined
        const b = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation((col: string, val: string) => {
            if (col === 'event_type') eventType = val
            return b
          }),
          or: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi
            .fn()
            .mockImplementation((n: number) =>
              n === 50 && opts.count ? Promise.resolve(opts.count) : b
            ),
          maybeSingle: vi.fn().mockImplementation(() =>
            Promise.resolve(
              eventType === 'indexer:run'
                ? { data: opts.auditRow ?? null, error: null }
                : {
                    data: opts.checkpointRow ?? null,
                    error: opts.checkpointError ?? null,
                  }
            )
          ),
        }
        return b
      }),
    } as never
  }
  return { factory, created }
}

const PROD_ONLY = { SUPABASE_URL: 'https://prod.example', SUPABASE_SERVICE_ROLE_KEY: 'prod-key' }
const STAGING_ONLY = {
  SUPABASE_URL_STAGING: 'https://stg.example',
  SUPABASE_SERVICE_ROLE_KEY_STAGING: 'stg-key',
}

describe('recover -- controls (distinct outcomes)', () => {
  it('positive: a 38013586443-shaped prod checkpoint re-dispatches with supabase_env=prod', async () => {
    const { factory } = makeClient({ checkpointRow: { metadata: prodCheckpoint } })
    const out = await recover({
      completedRunId: '38013586443',
      supabaseEnv: 'prod',
      processEnv: PROD_ONLY,
      makeClient: factory,
    })
    expect(out.skip).toBe('false')
    expect(out.supabase_env).toBe('prod')
    expect(out.resume_from).toBe('38013586443')
  })

  it('none: zero rows (e.g. a coldstart-<prefix> id) is a legal skip with reason "No checkpoint"', async () => {
    const { factory } = makeClient({})
    const out = await recover({
      completedRunId: 'coldstart-x',
      supabaseEnv: 'prod',
      processEnv: PROD_ONLY,
      makeClient: factory,
    })
    expect(out.skip).toBe('true')
    expect(out.skip_reason).toMatch(/No checkpoint or skip-branch audit row/)
  })

  it('error: a checkpoint read error THROWS -- it is not a skip', async () => {
    const { factory } = makeClient({ checkpointError: { message: 'upstream 503' } })
    await expect(
      recover({
        completedRunId: 'r1',
        supabaseEnv: 'prod',
        processEnv: PROD_ONLY,
        makeClient: factory,
      })
    ).rejects.toThrow(/upstream 503/)
  })
})

describe('recover -- credential selection (only the selected project)', () => {
  it('env=prod with neither prod nor staging creds throws MissingCredentials(prod)', async () => {
    const { factory } = makeClient({})
    const p = recover({
      completedRunId: 'r1',
      supabaseEnv: 'prod',
      processEnv: {},
      makeClient: factory,
    })
    await expect(p).rejects.toThrow(/prod/)
    await expect(p).rejects.toBeInstanceOf(MissingCredentials)
  })

  it('env=prod resolves when ONLY prod creds exist (staging creds are not required)', async () => {
    const { factory, created } = makeClient({ checkpointRow: { metadata: prodCheckpoint } })
    const out = await recover({
      completedRunId: 'r1',
      supabaseEnv: 'prod',
      processEnv: PROD_ONLY,
      makeClient: factory,
    })
    expect(out.skip).toBe('false')
    expect(created).toEqual([{ url: 'https://prod.example', key: 'prod-key' }])
  })

  it('env=staging with only prod creds throws MissingCredentials(staging) and never uses prod', async () => {
    const { factory, created } = makeClient({ checkpointRow: { metadata: prodCheckpoint } })
    await expect(
      recover({
        completedRunId: 'r1',
        supabaseEnv: 'staging',
        processEnv: PROD_ONLY,
        makeClient: factory,
      })
    ).rejects.toThrow(/staging/)
    expect(created).toHaveLength(0)
  })

  it('env=staging uses ONLY staging creds, even when prod creds are also present', async () => {
    const { factory, created } = makeClient({ checkpointRow: { metadata: prodCheckpoint } })
    await recover({
      completedRunId: 'r1',
      supabaseEnv: 'staging',
      processEnv: { ...PROD_ONLY, ...STAGING_ONLY },
      makeClient: factory,
    })
    expect(created).toEqual([{ url: 'https://stg.example', key: 'stg-key' }])
  })
})

describe('recover -- incomplete intent', () => {
  it('an audit-fallback row without dispatch_inputs throws IncompleteIntent', async () => {
    const { factory } = makeClient({
      auditRow: { metadata: { dry_run: false, meta: { status: 'skipped_lock' } } },
    })
    await expect(
      recover({
        completedRunId: 'r1',
        supabaseEnv: 'prod',
        processEnv: PROD_ONLY,
        makeClient: factory,
      })
    ).rejects.toBeInstanceOf(IncompleteIntent)
  })
})

const retryAudit = (dispatch_inputs: unknown, over: Record<string, unknown> = {}) => ({
  metadata: {
    dry_run: false,
    meta: { status: 'skipped_lock', resumed_from: 'latest', dispatch_inputs, ...over },
  },
})
const recoverWith = (opts: MockOpts) =>
  recover({
    completedRunId: 'r1',
    supabaseEnv: 'prod',
    processEnv: PROD_ONLY,
    makeClient: makeClient(opts).factory,
  })

describe('recover -- dispatch_inputs are validated against the workflow_dispatch schema', () => {
  it('CONTROL: a well-formed audit row on the retry path re-dispatches', async () => {
    const out = await recoverWith({
      auditRow: retryAudit(dispatchInputs),
      count: { data: [], error: null },
    })
    expect(out.skip).toBe('false')
    expect(out.max_ranges).toBe('10')
  })

  it.each([
    ['an empty object', {}, /missing required key/],
    ['a wrong type (maxRanges as a string)', { ...dispatchInputs, maxRanges: '10' }, /maxRanges/],
    ['a negative number', { ...dispatchInputs, minSizeBytes: -1 }, /minSizeBytes/],
    ['an out-of-enum supabaseEnv', { ...dispatchInputs, supabaseEnv: 'dev' }, /supabaseEnv/],
    ['an out-of-enum tokenSource', { ...dispatchInputs, tokenSource: 'x' }, /tokenSource/],
    [
      'a non-numeric maxSkillsPerRepo',
      { ...dispatchInputs, maxSkillsPerRepo: 'lots' },
      /maxSkillsPerRepo/,
    ],
    ['a multi-line pathPrefix', { ...dispatchInputs, pathPrefix: 'a\nb' }, /pathPrefix/],
    [
      'a non-boolean acceptTruncation',
      { ...dispatchInputs, acceptTruncation: 'false' },
      /acceptTruncation/,
    ],
    ['an array', [], /not an object/],
  ])(
    'an audit row whose dispatch_inputs is %s THROWS MalformedDispatchInputs',
    async (_l, bad, re) => {
      const p = recoverWith({ auditRow: retryAudit(bad), count: { data: [], error: null } })
      await expect(p).rejects.toBeInstanceOf(MalformedDispatchInputs)
      await expect(p).rejects.toThrow(re)
    }
  )

  it('a missing required key (tokenSource deleted) THROWS', async () => {
    const rest: Record<string, unknown> = { ...dispatchInputs }
    delete rest.tokenSource
    await expect(recoverWith({ auditRow: retryAudit(rest) })).rejects.toThrow(
      /missing required key 'tokenSource'/
    )
  })

  it('a malformed CHECKPOINT dispatch_inputs THROWS too (not only the audit path)', async () => {
    await expect(
      recoverWith({ checkpointRow: { metadata: { ...prodCheckpoint, dispatch_inputs: {} } } })
    ).rejects.toBeInstanceOf(MalformedDispatchInputs)
  })

  it('a non-boolean checkpoint dry_run THROWS', async () => {
    await expect(
      recoverWith({ checkpointRow: { metadata: { ...prodCheckpoint, dry_run: 'false' } } })
    ).rejects.toBeInstanceOf(MalformedDispatchInputs)
  })

  it('a non-string audit resumed_from THROWS', async () => {
    await expect(
      recoverWith({ auditRow: retryAudit(dispatchInputs, { resumed_from: 7 }) })
    ).rejects.toBeInstanceOf(MalformedDispatchInputs)
  })
})

describe('recover -- the retry-cap count fails CLOSED', () => {
  it('a count query ERROR makes recovery THROW (job red, alert runs), never a dispatch', async () => {
    await expect(
      recoverWith({
        auditRow: retryAudit(dispatchInputs),
        count: { data: null, error: { message: 'pooler down' } },
      })
    ).rejects.toThrow(/Retry-cap count unavailable \(pooler down\)/)
  })

  it('absent count data makes recovery THROW', async () => {
    await expect(
      recoverWith({ auditRow: retryAudit(dispatchInputs), count: { data: null, error: null } })
    ).rejects.toThrow(/Retry-cap count unavailable/)
  })

  it('five consecutive lock-skips still trip the cap (the cap itself is not lost)', async () => {
    const rows = Array.from({ length: 5 }, () => ({
      metadata: { meta: { status: 'skipped_lock', resumed_from: 'latest' } },
    }))
    const out = await recoverWith({
      auditRow: retryAudit(dispatchInputs),
      count: { data: rows, error: null },
    })
    expect(out.retry_cap_exceeded).toBe('true')
  })
})

describe('parseSupabaseEnvFromTitle', () => {
  it.each([
    ['Skill Indexer Backfill (env=prod)', 'prod'],
    ['Skill Indexer Backfill (env=staging)', 'staging'],
    ['Skill Indexer Backfill (env=prod) [tok=ac-38013586443]', 'prod'],
    ['Skill Indexer Backfill (env=staging) [tok=drv-1791847399-ab12cd34]', 'staging'],
    ['Skill Indexer Backfill (env=prod) [tok=]', 'prod'],
  ])('%s -> %s', (title, expected) => {
    expect(parseSupabaseEnvFromTitle(title)).toBe(expected)
  })

  it.each([
    ['the pre-change title (run 38013586443)', 'Skill Indexer Backfill'],
    ['an unknown env', 'Skill Indexer Backfill (env=dev)'],
    ['trailing text', 'Skill Indexer Backfill (env=prod) extra'],
    ['a bad token charset', 'Skill Indexer Backfill (env=prod) [tok=a b]'],
    ['a different workflow', 'Skill Indexer (env=prod)'],
    ['undefined', undefined],
    ['empty', ''],
  ])('%s -> indeterminate (never defaulted to prod)', (_label, title) => {
    expect(parseSupabaseEnvFromTitle(title as string | undefined)).toBe('indeterminate')
  })
})
