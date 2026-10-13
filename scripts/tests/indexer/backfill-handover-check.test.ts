/**
 * SMI-7112 (A1, 1.7): backfill-handover-check.sh GO/NO-GO, run for real under
 * its test seam with a stubbed `gh`. Never calls GitHub.
 *
 * ALL_CLEAR is the control: every check passes. Each NO-GO case then breaks
 * exactly ONE condition, so a mutation that drops that one check is the only
 * thing that can turn the case green.
 */
import { describe, it, expect } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HELPER, runScript, type Seam } from './backfill-driver.test-helpers.ts'
import {
  AUTOCHAIN_LIST,
  DONE_AT,
  STATUSES,
  WORKFLOWS,
  allClear,
  intentLines,
  runPath,
  statusPath,
  verdict,
} from './backfill-handover.fixtures.ts'

describe('CONTROL', () => {
  it('all clear => GO, exit 0', () => {
    const seam = allClear()
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('GO')
    expect(r.status).toBe(0)
  })
})

describe('NO-GO: exactly one broken condition per case', () => {
  it('(a) an unresolved intent', () => {
    const seam = allClear()
    writeFileSync(
      join(seam.dir, 'intents.jsonl'),
      intentLines([
        { event: 'intent', token: 'drv-1-aaaaaaaa', issued_at: '2026-10-12T09:00:00Z', params: {} },
        { event: 'resolved', token: 'drv-1-aaaaaaaa', run_id: 500 },
        { event: 'intent', token: 'drv-2-bbbbbbbb', issued_at: '2026-10-12T09:30:00Z', params: {} },
      ])
    )
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/UNRESOLVED/)
  })

  it('(a) an intent marked reconciled_absent does NOT block', () => {
    const seam = allClear()
    writeFileSync(
      join(seam.dir, 'intents.jsonl'),
      intentLines([
        { event: 'intent', token: 'drv-2-bbbbbbbb', issued_at: '2026-10-12T09:30:00Z', params: {} },
        { event: 'reconciled_absent', token: 'drv-2-bbbbbbbb', reason: 'dispatch never landed' },
      ])
    )
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('GO')
  })

  it('(a) a resolved intent whose run is not completed', () => {
    const seam = allClear()
    seam.fixture(runPath(500), { status: 'in_progress', updated_at: DONE_AT })
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/not completed/)
  })

  for (const wf of WORKFLOWS) {
    for (const s of STATUSES) {
      it(`(b) ${wf} has a run in status '${s}'`, () => {
        const seam = allClear()
        seam.fixture(statusPath(wf, s), { total_count: 1, workflow_runs: [{ id: 7 }] })
        const r = runScript(HELPER, [], seam)
        expect(verdict(r), r.out).toBe('NO-GO')
        expect(r.out).toContain(`${wf} has 1 run(s) in status '${s}'`)
      })
    }
  }

  it('(c) an autochain run created after the last completion that is not completed (the status counts are all 0)', () => {
    const seam = allClear()
    seam.fixture(AUTOCHAIN_LIST, {
      workflow_runs: [
        { id: 9, status: 'completed', created_at: '2026-10-12T11:00:00Z' },
        { id: 10, status: 'in_progress', created_at: '2026-10-12T10:00:01Z' },
      ],
    })
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/autochain run\(s\) not completed \(page 1\): 10:in_progress/)
  })

  it("(c) an OLD open autochain run (created before the last completion) is not this check's concern", () => {
    const seam = allClear()
    seam.fixture(AUTOCHAIN_LIST, {
      workflow_runs: [{ id: 10, status: 'in_progress', created_at: '2026-10-12T09:59:59Z' }],
    })
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('GO')
  })

  const fixtureFile = (seam: Seam, path: string) =>
    join(seam.dir, 'api', `${path.replace(/[^a-zA-Z0-9]/g, '_')}.json`)

  it.each([
    ['the intent run lookup', runPath(500)],
    ['a status count (backfill/queued)', statusPath('indexer-backfill.yml', 'queued')],
    [
      'a status count (autochain/requested)',
      statusPath('indexer-backfill-autochain.yml', 'requested'),
    ],
    ['the autochain run list', AUTOCHAIN_LIST],
  ])('an UNREADABLE body on %s is NO-GO, never "zero"', (_label, path) => {
    const seam = allClear()
    writeFileSync(fixtureFile(seam, path), 'not json {')
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
  })

  it.each([
    ['the intent run lookup', runPath(500)],
    ['a status count (backfill/waiting)', statusPath('indexer-backfill.yml', 'waiting')],
    ['a status count (autochain/pending)', statusPath('indexer-backfill-autochain.yml', 'pending')],
    ['the autochain run list', AUTOCHAIN_LIST],
  ])('a failing gh call (exit 1) on %s is NO-GO', (_label, path) => {
    const seam = allClear()
    rmSync(fixtureFile(seam, path)) // no fixture => the stub exits 1, like a real API error
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/API error/)
  })
})
