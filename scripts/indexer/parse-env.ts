/**
 * Environment parsing for the Node indexer entrypoint
 * @module scripts/indexer/parse-env
 *
 * SMI-4852: Pure function — testable in isolation. Decisions:
 *   - `CONCURRENCY_KILL_SWITCH=1` forces concurrency=1 regardless of
 *     `CONCURRENCY` (or D-3 default of 2). Hard Rule 1 (retro 2026-05-10).
 *   - Required vars throw at parse time so the entrypoint fails fast.
 *   - All numeric vars default cleanly if absent.
 */

export interface IndexerEnv {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SLOT: number | null
  MAX_PAGES: number
  MAX_REPOS: number
  CODE_SEARCH_MAX_PAGES: number
  DRY_RUN: boolean
  RUN_TYPE: 'discovery' | 'maintenance'
  STALE_DAYS: number
  concurrency: number
  kill_switch_engaged: boolean
}

function getRequired(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required environment variable: ${name}`)
  return v
}

function getInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return defaultValue
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`)
  }
  return parsed
}

function getBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return defaultValue
  return raw === '1' || raw === 'true' || raw === 'True' || raw === 'TRUE'
}

export function parseEnv(env: NodeJS.ProcessEnv = process.env): IndexerEnv {
  const prev = process.env
  // Allow injection-of-env for tests; restore after read.
  if (env !== process.env) {
    process.env = env as NodeJS.ProcessEnv
  }
  try {
    const SUPABASE_URL = getRequired('SUPABASE_URL')
    const SUPABASE_SERVICE_ROLE_KEY = getRequired('SUPABASE_SERVICE_ROLE_KEY')
    const cronRaw = process.env.CRON_SLOT
    const CRON_SLOT =
      cronRaw == null || cronRaw === ''
        ? null
        : (() => {
            const parsed = Number(cronRaw)
            if (!Number.isFinite(parsed)) {
              throw new Error(`Invalid CRON_SLOT: ${cronRaw}`)
            }
            return parsed
          })()

    const MAX_PAGES = getInt('MAX_PAGES', 5)
    const MAX_REPOS = getInt('MAX_REPOS', 100)
    const CODE_SEARCH_MAX_PAGES = getInt('CODE_SEARCH_MAX_PAGES', 1)
    const DRY_RUN = getBool('DRY_RUN', false)
    const RUN_TYPE_RAW = process.env.RUN_TYPE ?? 'discovery'
    if (RUN_TYPE_RAW !== 'discovery' && RUN_TYPE_RAW !== 'maintenance') {
      throw new Error(`Invalid RUN_TYPE: ${RUN_TYPE_RAW} (expected discovery|maintenance)`)
    }
    const RUN_TYPE = RUN_TYPE_RAW
    const STALE_DAYS = getInt('STALE_DAYS', RUN_TYPE === 'maintenance' ? 7 : 30)

    // Concurrency: kill-switch (env=1) forces 1, else CONCURRENCY env or D-3 default of 2.
    const kill_switch_engaged = getBool('CONCURRENCY_KILL_SWITCH', false)
    const concurrencyRequest = getInt('CONCURRENCY', 2)
    const concurrency = kill_switch_engaged ? 1 : Math.max(1, concurrencyRequest)

    return {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      CRON_SLOT,
      MAX_PAGES,
      MAX_REPOS,
      CODE_SEARCH_MAX_PAGES,
      DRY_RUN,
      RUN_TYPE,
      STALE_DAYS,
      concurrency,
      kill_switch_engaged,
    }
  } finally {
    process.env = prev
  }
}
