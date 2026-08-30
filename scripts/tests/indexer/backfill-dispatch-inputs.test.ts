/**
 * SMI-6246: unit coverage for the campaign-defining dispatch-inputs echo.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { buildBackfillDispatchInputs } from '../../indexer/backfill-dispatch-inputs.ts'
import type { IndexerEnv } from '../../indexer/parse-env.ts'

function baseEnv(overrides: Partial<IndexerEnv> = {}): IndexerEnv {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'key',
    CRON_SLOT: null,
    MAX_PAGES: 10,
    MAX_REPOS: 500,
    CODE_SEARCH_MAX_PAGES: 10,
    DRY_RUN: false,
    RUN_TYPE: 'discovery',
    STALE_DAYS: 30,
    RECHECK_THRESHOLD_DAYS: 5,
    RECHECK_MAX_CANDIDATES: 2000,
    RECHECK_BATCH: 5,
    RECHECK_DRY_RUN: true,
    DEQUARANTINE_DRY_RUN: true,
    PURGE_DRY_RUN: true,
    PURGE_LIMIT: undefined,
    concurrency: 2,
    kill_switch_engaged: false,
    DISCOVERY_PHASE: 3,
    BACKFILL_MODE: true,
    BACKFILL_PATH_PREFIX: '.agents/skills',
    BACKFILL_MAX_RANGES: 50,
    BACKFILL_MIN_SIZE_BYTES: 1024,
    BACKFILL_MAX_SKILLS_PER_DISPATCH: 200,
    BACKFILL_MAX_ELAPSED_MINUTES: 120,
    BACKFILL_ACCEPT_TRUNCATION: true,
    BACKFILL_LOCK_YIELD_MINUTES: 10,
    ...overrides,
  }
}

describe('SMI-6246: buildBackfillDispatchInputs', () => {
  afterEach(() => {
    delete process.env.BACKFILL_MAX_SKILLS_PER_REPO
    delete process.env.SUPABASE_ENV
    delete process.env.TOKEN_SOURCE
  })

  it('echoes every IndexerEnv-backed field verbatim', () => {
    const inputs = buildBackfillDispatchInputs(baseEnv())
    expect(inputs.pathPrefix).toBe('.agents/skills')
    expect(inputs.maxRanges).toBe(50)
    expect(inputs.minSizeBytes).toBe(1024)
    expect(inputs.maxSkillsPerDispatch).toBe(200)
    expect(inputs.maxElapsedMinutes).toBe(120)
    expect(inputs.acceptTruncation).toBe(true)
  })

  it('defaults pathPrefix to an empty string when unset (broad query)', () => {
    const inputs = buildBackfillDispatchInputs(baseEnv({ BACKFILL_PATH_PREFIX: undefined }))
    expect(inputs.pathPrefix).toBe('')
  })

  it('reads maxSkillsPerRepo/supabaseEnv/tokenSource from process.env, not IndexerEnv, with their documented defaults', () => {
    const inputs = buildBackfillDispatchInputs(baseEnv())
    expect(inputs.maxSkillsPerRepo).toBe('50')
    expect(inputs.supabaseEnv).toBe('prod')
    expect(inputs.tokenSource).toBe('backfill')
  })

  it('picks up explicit process.env overrides for the three job-level-only fields', () => {
    process.env.BACKFILL_MAX_SKILLS_PER_REPO = '25'
    process.env.SUPABASE_ENV = 'staging'
    process.env.TOKEN_SOURCE = 'fallback'
    const inputs = buildBackfillDispatchInputs(baseEnv())
    expect(inputs.maxSkillsPerRepo).toBe('25')
    expect(inputs.supabaseEnv).toBe('staging')
    expect(inputs.tokenSource).toBe('fallback')
  })
})
