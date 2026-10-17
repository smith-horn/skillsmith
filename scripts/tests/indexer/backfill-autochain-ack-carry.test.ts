/**
 * SMI-7121: an acknowledgement survives a deferral. A manual link (workflow_dispatch,
 * verify_only=false) that acknowledges a halt and lands in a closed window records the
 * acknowledgement on its marker; schedule-target emits it; the resume passes it to recovery
 * as ACKNOWLEDGE_HALTS (the workflow's recover-step expression), so the acknowledged halt
 * does not fire again while an unacknowledged one still does and the marker is closed.
 * Every hop runs the real CLI/recover code against in-memory projects.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runCommand } from '../../indexer/backfill-autochain-defer.ts'
import { recover } from '../../indexer/backfill-autochain-inputs.ts'
import { canonicalAcknowledgedHalts } from '../../indexer/backfill-autochain-halts.ts'
import { NOW, fakeProject, marker, projects } from './backfill-autochain-defer.fake.ts'

const RUN = '38013586443'
const CREDS = {
  SUPABASE_URL: 'p',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  SUPABASE_URL_STAGING: 's',
  SUPABASE_SERVICE_ROLE_KEY_STAGING: 'k',
}

/** A checkpoint for RUN whose counters trip the given halts. */
function checkpoint(counters: { no_default_branch: number; license_filtered: number }) {
  return {
    run_id: RUN,
    cursor: { path: '.agents/skills', facet: 'f3', last_page: 2 },
    facets_completed: 3,
    facets_total: 10,
    dry_run: false,
    dispatch_inputs: {
      maxSkillsPerRepo: '50',
      pathPrefix: '.agents/skills',
      maxRanges: 10,
      minSizeBytes: 1024,
      maxSkillsPerDispatch: 5000,
      maxElapsedMinutes: 280,
      acceptTruncation: false,
      supabaseEnv: 'prod',
      tokenSource: 'backfill',
    },
    dispatch_counters: { admitted: 4, ranges_crawled: 3, ...counters },
    resumed_from: { run_id: '38013586000', path: '.agents/skills' },
  }
}

/** A client whose only answer is RUN's checkpoint (the checkpoint path of recover()). */
function checkpointClient(metadata: unknown): SupabaseClient {
  const b = {
    select: () => b,
    eq: () => b,
    or: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: { metadata }, error: null }),
  }
  return { from: () => b } as unknown as SupabaseClient
}

/** The recover step's ACKNOWLEDGE_HALTS on a schedule tick: no dispatch input, the marker's value. */
const scheduleTickAck = (target: Record<string, string>) => target.acknowledged_halts || ''

async function deferThenTarget(ack: string | undefined) {
  const p = fakeProject([])
  const s = fakeProject([])
  const makeClient = (url: string) => (url === 'p' ? p.client : s.client)
  await runCommand('insert', {
    penv: {
      ...CREDS,
      SUPABASE_ENV: 'prod',
      DRY_RUN: 'false',
      NEXT_WINDOW_UTC: '2026-10-16T15:00:00Z',
      COMPLETED_RUN_ID: RUN,
      COMPLETED_RUN_ATTEMPT: '1',
      GITHUB_RUN_ID: '777',
      ...(ack === undefined ? {} : { ACKNOWLEDGE_HALTS: ack }),
    },
    makeClient,
    now: NOW,
  })
  const target = await runCommand('schedule-target', { penv: CREDS, makeClient })
  return { p, makeClient, target }
}

describe('an acknowledgement survives a deferral', () => {
  it('the deferring manual link records the canonical acknowledgement on the marker', async () => {
    const { p, target } = await deferThenTarget(' license_filtered , license_filtered')
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0].metadata.acknowledged_halts).toBe('license_filtered')
    expect(target).toMatchObject({
      resume: 'true',
      completed_run_id: RUN,
      acknowledged_halts: 'license_filtered',
    })
  })

  it('the resume recovery sees it: the acknowledged halt does not fire', async () => {
    const { target } = await deferThenTarget('license_filtered')
    const out = await recover({
      completedRunId: target.completed_run_id,
      supabaseEnv: 'prod',
      processEnv: { ...CREDS, ACKNOWLEDGE_HALTS: scheduleTickAck(target) },
      makeClient: () => checkpointClient(checkpoint({ no_default_branch: 0, license_filtered: 2 })),
    })
    expect(out.halted).toBeUndefined()
    expect(out.skip).toBe('false')
  })

  it('an unacknowledged halt on the same resume still fires, and the marker is then closed', async () => {
    const { p, target, makeClient } = await deferThenTarget('license_filtered')
    const out = await recover({
      completedRunId: target.completed_run_id,
      supabaseEnv: 'prod',
      processEnv: { ...CREDS, ACKNOWLEDGE_HALTS: scheduleTickAck(target) },
      makeClient: () =>
        checkpointClient(checkpoint({ no_default_branch: 99, license_filtered: 2 })),
    })
    expect(out).toMatchObject({ halted: 'true', skip: 'true', halt_names: 'no_default_branch' })
    // the workflow's "Close the deferral marker, not resumable (schedule)" step
    const closed = await runCommand('needs-intervention', {
      penv: {
        ...CREDS,
        MARKER_ID: target.marker_id,
        MARKER_ENV: 'prod',
        REASON: out.skip_reason,
        GITHUB_RUN_ID: '778',
      },
      makeClient,
      now: NOW,
    })
    expect(closed).toEqual({ moved: 'true' })
    expect(p.rows[0].metadata.state).toBe('needs_intervention')
  })

  it('CONTROL: without the carried acknowledgement the resume halts on license_filtered', async () => {
    const out = await recover({
      completedRunId: RUN,
      supabaseEnv: 'prod',
      processEnv: { ...CREDS, ACKNOWLEDGE_HALTS: '' },
      makeClient: () => checkpointClient(checkpoint({ no_default_branch: 0, license_filtered: 2 })),
    })
    expect(out).toMatchObject({ halted: 'true', halt_names: 'license_filtered' })
  })

  it('a link with no acknowledgement writes no acknowledged_halts key; the target emits empty', async () => {
    const { p, target } = await deferThenTarget(undefined)
    expect(p.rows[0].metadata).not.toHaveProperty('acknowledged_halts')
    expect(target.acknowledged_halts).toBe('')
  })

  it('an unknown or unacknowledgeable name is refused at the insert (red, nothing written)', async () => {
    await expect(deferThenTarget('bogus')).rejects.toThrow(/unknown halt/)
    await expect(deferThenTarget('no_progress_record')).rejects.toThrow(/cannot be acknowledged/)
  })

  it('a stored value is re-validated by schedule-target (never trusted blindly)', async () => {
    for (const bad of ['bogus', 7]) {
      const { clients } = projects([marker('a', { state: 'open', acknowledged_halts: bad })])
      await expect(
        runCommand('schedule-target', {
          penv: CREDS,
          makeClient: (url) => (url === 'p' ? clients.prod : clients.staging),
        })
      ).rejects.toThrow(/unknown halt|non-string acknowledged_halts/)
    }
  })
})

describe('canonicalAcknowledgedHalts', () => {
  it('dedupes, trims and orders by HALT_NAMES; empty or undefined is empty', () => {
    expect(
      canonicalAcknowledgedHalts(' license_filtered , counters_missing,license_filtered')
    ).toBe('counters_missing,license_filtered')
    expect(canonicalAcknowledgedHalts('')).toBe('')
    expect(canonicalAcknowledgedHalts(undefined)).toBe('')
  })
})
