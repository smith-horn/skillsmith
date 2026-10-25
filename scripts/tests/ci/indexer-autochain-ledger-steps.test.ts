/**
 * SMI-7167 (ADR-183): `Record link start` / `Record link finish` EXECUTED.
 *
 * The steps' real `run:` text runs under `bash -e` (what Actions uses with no `shell:` key), with
 * curl, sleep and gh replaced by fakes on a temp PATH and HOME in a temp dir. jq is the real one
 * when the machine has it; otherwise a shim that refuses any program other than the pinned one
 * (the dev container has no jq; GitHub runners do).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadWorkflow } from './indexer-autochain-workflow.helpers.ts'
import { mutate, runStep, stepById } from './indexer-autochain-ledger.helpers.ts'

const doc = loadWorkflow()
const START = stepById(doc, 'link_start')!
const FINISH = stepById(doc, 'link_finish')!

const ENV = {
  LEDGER_COMPLETED_RUN_ID: '555',
  LEDGER_COMPLETED_RUN_ATTEMPT: '2',
  LEDGER_COMPLETED_TITLE: 'Skill Indexer Backfill env=prod [tok=ac-1]',
  LEDGER_EVENT_NAME: 'workflow_run',
  GITHUB_RUN_ID: '900',
  GITHUB_RUN_ATTEMPT: '3',
  SUPABASE_URL: 'https://example.test',
}
const run = (step: typeof START, env: Record<string, string> = {}, codes: string[] = ['201']) =>
  runStep(step, {
    codes,
    env: {
      ...ENV,
      LEDGER_EVENT: step.env!.LEDGER_EVENT!,
      LEDGER_STATUS: step === START ? (step.env!.LEDGER_STATUS ?? '') : 'success',
      ...env,
    },
  })

describe.each([
  ['link_start', START],
  ['link_finish', FINISH],
])('%s executed', (_name, step) => {
  const isFinish = step === FINISH
  const status = (env: Record<string, string>) => (isFinish ? env : { ...env, LEDGER_STATUS: '' })

  it('a valid id writes exactly one POST with the exact JSON body (ids are strings)', () => {
    const r = run(step, status({ LEDGER_STATUS: 'success' }))
    expect(r.status).toBe(0)
    expect(r.posts).toHaveLength(1)
    const p = r.posts[0]!
    expect(p.url).toBe('https://example.test/rest/v1/audit_logs')
    expect(p.args).toContain('--max-time 15')
    expect(p.args).toContain('-X POST')
    const metadata: Record<string, string> = {
      completed_run_id: '555',
      completed_run_attempt: '2',
      completed_title: 'Skill Indexer Backfill env=prod [tok=ac-1]',
      link_run_id: '900',
      link_run_attempt: '3',
      event: 'workflow_run',
    }
    if (isFinish) metadata.status = 'success'
    expect(p.json).toEqual({
      event_type: step.env!.LEDGER_EVENT,
      actor: 'system',
      action: 'backfill_autochain_link',
      resource: '555',
      result: 'success',
      metadata,
    })
    expect('status' in p.json.metadata).toBe(isFinish)
    expect(r.log).toContain('Recorded')
    expect(r.log).not.toContain('::warning::')
  })

  it('a 19-digit id is the longest accepted', () => {
    const r = run(step, status({ LEDGER_COMPLETED_RUN_ID: '1234567890123456789' }))
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0]!.json.resource).toBe('1234567890123456789')
  })

  it('the title round-trips quotes, $(...), backticks and a newline and NOTHING executes', () => {
    const r0 = run(step, status({}))
    const marker = join(r0.out, 'PWNED')
    const title = `a "q" $(touch ${marker}) \`touch ${marker}2\` '; touch ${marker}3\nline2 \\ end`
    const r = run(step, status({ LEDGER_COMPLETED_TITLE: title }))
    expect(r.status).toBe(0)
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0]!.json.metadata.completed_title).toBe(title)
    for (const suffix of ['', '2', '3']) expect(existsSync(marker + suffix)).toBe(false)
    expect(existsSync(join(r.out, 'PWNED'))).toBe(false)
  })

  it.each([
    ['empty', ''],
    ['zero', '0'],
    ['leading zero', '0123'],
    ['letters', 'abc'],
    ['embedded space', '12 3'],
    ['negative', '-5'],
    ['a $(...) payload', '$(touch x)'],
    ['20 digits', '12345678901234567890'],
  ])('an invalid id (%s) writes no POST, exits 0 and warns', (_label, id) => {
    const r = run(step, status({ LEDGER_COMPLETED_RUN_ID: id }))
    expect(r.status).toBe(0)
    expect(r.posts).toHaveLength(0)
    expect(r.log).toContain('::warning::Not recording')
  })

  it.each([
    ['HTTP 500', ['500'], 'HTTP 500'],
    ['HTTP 401', ['401'], 'HTTP 401'],
    ['curl exiting non-zero', ['EXIT'], 'HTTP 000'],
  ])('%s: exit 0 with a ::warning:: naming the status', (_label, codes, text) => {
    const r = run(step, status({}), codes)
    expect(r.status).toBe(0)
    expect(r.posts).toHaveLength(1)
    expect(r.log).toContain('::warning::Could not record')
    expect(r.log).toContain(text)
    expect(r.log).toContain('silent-stop detector will page')
  })

  it('a 2xx other than 201 is a success (no warning)', () => {
    const r = run(step, status({}), ['204'])
    expect(r.log).not.toContain('::warning::')
    expect(r.log).toContain('HTTP 204')
  })
})

describe('the status key', () => {
  it('link_finish records job.status verbatim, including failure and cancelled', () => {
    for (const s of ['success', 'failure', 'cancelled']) {
      const r = run(FINISH, { LEDGER_STATUS: s })
      expect(r.posts[0]!.json.metadata.status).toBe(s)
    }
  })

  it('link_start (empty status) has no status key even if the other fields vary', () => {
    const r = run(START, { LEDGER_STATUS: '', LEDGER_EVENT_NAME: 'workflow_dispatch' })
    expect(r.posts[0]!.json.metadata.event).toBe('workflow_dispatch')
    expect('status' in r.posts[0]!.json.metadata).toBe(false)
  })
})

describe('known-negatives: the executed assertions bite when the step is broken', () => {
  const broken = (from: string, to: string) => ({ ...START, run: mutate(START.run!, from, to) })

  it('without the integer guard, an invalid id reaches curl (so "no POST" is a real observation)', () => {
    const step = broken("''|0*|*[!0-9]*)", 'NEVER_MATCHES)')
    const r = run(step, { LEDGER_COMPLETED_RUN_ID: 'abc', LEDGER_STATUS: '' })
    expect(r.posts).toHaveLength(1)
  })

  it('without the length guard, a 20-digit id reaches curl', () => {
    const step = broken('-gt 19', '-gt 99')
    const r = run(step, { LEDGER_COMPLETED_RUN_ID: '12345678901234567890', LEDGER_STATUS: '' })
    expect(r.posts).toHaveLength(1)
  })

  it('without --arg title, the title does not round-trip (the JSON-encoding assertion is live)', () => {
    const step = broken('--arg title "$LEDGER_COMPLETED_TITLE"', '--arg title "x"')
    const r = run(step, { LEDGER_COMPLETED_TITLE: 'a "q"', LEDGER_STATUS: '' })
    expect(r.posts[0]!.json.metadata.completed_title).not.toBe('a "q"')
  })

  it('a step that swallowed the HTTP status would log no warning on a 500', () => {
    const step = broken('*) echo "::warning::Could not record', '*) echo "Could not record')
    const r = run(step, { LEDGER_STATUS: '' }, ['500'])
    expect(r.log).not.toContain('::warning::Could not record')
  })
})
