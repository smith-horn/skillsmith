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
          limit: vi.fn().mockReturnThis(),
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
