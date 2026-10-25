/**
 * SMI-7167 (ADR-183): scripts/ci/autochain-ledger.sh `prepared`, run through the real
 * `Record dispatch prepared` step text with curl and sleep faked.
 */
import { describe, it, expect } from 'vitest'
import { loadWorkflow } from './indexer-autochain-workflow.helpers.ts'
import { runStep, stepById } from './indexer-autochain-ledger.helpers.ts'

const doc = loadWorkflow()
const PREPARED = stepById(doc, 'prepared')!

const prepared = (env: Record<string, string> = {}, codes: string[] = ['201']) =>
  runStep(PREPARED, { codes, env: { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', ...env } })

const SINCE_RE = /^since=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/m

describe('autochain-ledger.sh prepared', () => {
  it('writes since=<ISO, about now-10min> to GITHUB_OUTPUT BEFORE the first POST', () => {
    const r = prepared()
    expect(r.status).toBe(0)
    const final = SINCE_RE.exec(r.githubOutput)
    expect(final, 'since line in GITHUB_OUTPUT').not.toBeNull()
    // the stub curl dumped GITHUB_OUTPUT at the moment of the first POST
    const atCall = SINCE_RE.exec(r.posts[0]!.outputAtCall)
    expect(atCall, 'since already written when curl ran').not.toBeNull()
    expect(atCall![1]).toBe(final![1])
    const ageMin = (Date.now() - Date.parse(final![1]!)) / 60000
    expect(ageMin).toBeGreaterThan(9.5)
    expect(ageMin).toBeLessThan(11)
  })

  it('writes since even when every attempt then fails (a failed write must not lose the floor)', () => {
    const r = prepared({}, ['500'])
    expect(r.status).toBe(1)
    expect(SINCE_RE.test(r.githubOutput)).toBe(true)
  })

  it('POSTs the documented row: ids are strings, dispatch_token is ac-<GITHUB_RUN_ID>', () => {
    const r = prepared({
      LEDGER_SUPABASE_ENV: 'staging',
      LEDGER_IS_RESUME: 'true',
      LEDGER_RESUME_FROM: 'cursor-9',
    })
    expect(r.status).toBe(0)
    expect(r.posts).toHaveLength(1)
    const since = SINCE_RE.exec(r.githubOutput)![1]
    expect(r.posts[0]!.url).toBe('https://example.test/rest/v1/audit_logs')
    expect(r.posts[0]!.args).toContain('--max-time 15')
    expect(r.posts[0]!.json).toEqual({
      event_type: 'indexer_backfill_autochain_dispatch_prepared',
      actor: 'system',
      action: 'backfill_autochain_dispatch_prepared',
      resource: 'ac-123',
      result: 'success',
      metadata: {
        dispatch_token: 'ac-123',
        link_run_id: '123',
        link_run_attempt: '2',
        supabase_env: 'staging',
        is_resume: true,
        resume_from: 'cursor-9',
        since,
      },
    })
  })

  it('is_resume is a boolean true only for the exact string "true"', () => {
    const flag = (v: string) => prepared({ LEDGER_IS_RESUME: v }).posts[0]!.json.metadata.is_resume
    expect(flag('true')).toBe(true)
    expect(flag('false')).toBe(false)
    expect(flag('')).toBe(false)
    expect(flag('TRUE')).toBe(false)
  })

  it('defaults supabase_env and resume_from to empty strings', () => {
    const m = prepared().posts[0]!.json.metadata
    expect(m.supabase_env).toBe('')
    expect(m.resume_from).toBe('')
  })

  it('a hostile resume_from is encoded, never executed', () => {
    const v = 'x"y $(touch /nonexistent/never) `id`\nz'
    const r = prepared({ LEDGER_RESUME_FROM: v })
    expect(r.posts[0]!.json.metadata.resume_from).toBe(v)
    expect(r.status).toBe(0)
  })

  it('500 then 201: exit 0 after exactly 2 attempts, one back-off of 2s', () => {
    const r = prepared({}, ['500', '201'])
    expect(r.status).toBe(0)
    expect(r.posts).toHaveLength(2)
    expect(r.sleeps).toEqual(['2'])
    expect(r.log).toContain('write attempt 1 returned HTTP 500')
    expect(r.log).toContain('Recorded dispatch_prepared for ac-123')
  })

  it('every 2xx stops at the first attempt', () => {
    for (const code of ['200', '201', '204']) {
      const r = prepared({}, [code])
      expect(r.status, code).toBe(0)
      expect(r.posts, code).toHaveLength(1)
    }
  })

  it('500 x3: exit 1 with ::error::, exactly 3 attempts, back-offs 2s then 4s (no sleep after the last)', () => {
    const r = prepared({}, ['500'])
    expect(r.status).toBe(1)
    expect(r.posts).toHaveLength(3)
    expect(r.sleeps).toEqual(['2', '4'])
    expect(r.log).toContain(
      '::error::autochain-ledger prepared: could not record the dispatch intent after 3 attempts'
    )
    expect(r.log).toContain('refusing to dispatch an unwatched run')
  })

  it('a transport failure (curl exits non-zero) is a failed attempt: 3 attempts, exit 1', () => {
    const r = prepared({}, ['EXIT'])
    expect(r.status).toBe(1)
    expect(r.posts).toHaveLength(3)
    expect(r.log).toContain('HTTP 000')
  })

  it('3xx and 4xx are failures too (only 2xx counts)', () => {
    for (const code of ['301', '400', '401', '409']) {
      const r = prepared({}, [code])
      expect(r.status, code).toBe(1)
      expect(r.posts, code).toHaveLength(3)
    }
  })

  it('LEDGER_RETRY_SLEEP seam sets the first back-off and doubles it', () => {
    const r = prepared({ LEDGER_RETRY_SLEEP: '5' }, ['500'])
    expect(r.sleeps).toEqual(['5', '10'])
  })

  it.each(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])(
    'missing %s: exit 1, ::error::, no POST (fail closed)',
    (name) => {
      const r = prepared({ [name]: '' })
      expect(r.status).toBe(1)
      expect(r.posts).toHaveLength(0)
      expect(r.log).toContain(`::error::autochain-ledger prepared: ${name} is not set`)
    }
  )

  it('an unset GITHUB_OUTPUT is also fail closed', () => {
    const r = prepared({ GITHUB_OUTPUT: '' })
    expect(r.status).toBe(1)
    expect(r.posts).toHaveLength(0)
    expect(r.log).toContain('GITHUB_OUTPUT is not set')
  })

  it('an unknown or missing mode exits 2 and never POSTs', () => {
    for (const run of [
      'bash scripts/ci/autochain-ledger.sh bogus',
      'bash scripts/ci/autochain-ledger.sh',
    ]) {
      const r = runStep(
        { run },
        { codes: ['201'], env: { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' } }
      )
      expect(r.status).toBe(2)
      expect(r.posts).toHaveLength(0)
      expect(r.log).toContain('usage: autochain-ledger.sh prepared|resolved')
    }
  })
})
