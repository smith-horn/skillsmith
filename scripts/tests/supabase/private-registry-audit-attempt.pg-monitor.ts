/**
 * SMI-6114 — assertion arms for `registry_audit_volume_over_threshold()` (the volume monitor's
 * predicate; the pg_cron job and alert edge function are deferred to SMI-7050, so scheduling is
 * deliberately NOT tested). Exported functions are shared with the revert-then-restore block.
 *
 * @module scripts/tests/supabase/private-registry-audit-attempt.pg-monitor
 */

import { describe, it, expect } from 'vitest'
import {
  U_ACTOR_A,
  U_ACTOR_B,
  TEAM_A,
  callAs,
  claims,
  realAuditTriggerSql,
  scalar,
  sqlstate,
  type Ctx,
  type PsqlSession,
} from './private-registry-audit-attempt.test-helpers.ts'

export const P_NOW = '2026-03-10 14:37:00+00' // closed_before = 14:00Z; buckets [12,13) and [13,14)

const CLIENT = '{"audit_source":"client_reported"}'

async function insertRow(
  ctl: PsqlSession,
  actor: string,
  at: string,
  opts: { event?: string; meta?: string } = {}
) {
  const res = await ctl.send(
    `INSERT INTO audit_logs (event_type, actor, resource, action, result, metadata, created_at)
     VALUES ('${opts.event ?? 'private_registry:get'}', '${actor}', 'r', 'get', 'error',
             '${opts.meta ?? CLIENT}'::jsonb, '${at}'::timestamptz);`
  )
  expect(res.stderr, `fixture insert for ${actor}`).not.toMatch(/ERROR/)
}

export async function callMonitor(
  ctl: PsqlSession,
  threshold: number | 'NULL',
  pNow: string,
  role: 'service_role' | 'authenticated' = 'service_role'
): Promise<{ lines: string[]; stderr: string }> {
  const res = await callAs(
    ctl,
    role,
    null,
    `SELECT actor || '|' || to_char(hour_bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') || '|' || event_count
       FROM public.registry_audit_volume_over_threshold(${threshold}, '${pNow}'::timestamptz) ORDER BY actor;`
  )
  return { lines: res.stdout.split('\n').filter((l) => l.trim().length > 0), stderr: res.stderr }
}
const actorsOf = (lines: string[]) => new Set(lines.map((l) => l.split('|')[0]))

/** Boundary fixture: one distinct actor per row, so presence/absence is per row in ONE result set. */
export async function seedBoundaries(ctl: PsqlSession) {
  const present: Array<[string, string]> = [
    ['lower-exact', '2026-03-10 12:00:00+00'], // exactly closed_before - 2h
    ['bucket1-inside', '2026-03-10 12:30:00+00'],
    ['bucket2-inside', '2026-03-10 13:30:00+00'],
    ['bucket2-last-instant', '2026-03-10 13:59:59.999999+00'],
  ]
  const absent: Array<[string, string]> = [
    ['before-lower', '2026-03-10 11:59:59.999999+00'],
    ['exactly-closed-before', '2026-03-10 14:00:00+00'],
    ['open-bucket', '2026-03-10 14:20:00+00'],
  ]
  for (const [a, t] of [...present, ...absent]) await insertRow(ctl, `user:${a}`, t)
  await insertRow(ctl, 'user:wrong-event-type', '2026-03-10 12:30:00+00', {
    event: 'private_registry:truncate',
  })
  await insertRow(ctl, 'user:no-source-key', '2026-03-10 12:30:00+00', { meta: '{}' })
  await insertRow(ctl, 'user:trigger-source', '2026-03-10 12:30:00+00', {
    meta: '{"audit_source":"trg_prs_audit"}',
  })
  return { present: present.map(([a]) => `user:${a}`), absent: absent.map(([a]) => `user:${a}`) }
}

/** Presence for rows at/inside the window, absence for rows outside it -- one result set. The
 *  absence assertions run open-bucket FIRST so a mutation that admits the open bucket fails there. */
export async function assertBoundaries(ctl: PsqlSession) {
  const seeded = await seedBoundaries(ctl)
  const out = await callMonitor(ctl, 0, P_NOW)
  expect(out.stderr, 'monitor call must not error').not.toMatch(/ERROR/)
  const got = actorsOf(out.lines)
  for (const a of seeded.present) expect(got.has(a), `present: ${a} is returned`).toBe(true)
  expect(got.has('user:open-bucket'), 'open bucket row is not returned').toBe(false)
  expect(
    got.has('user:exactly-closed-before'),
    'row exactly at closed_before is not returned'
  ).toBe(false)
  expect(got.has('user:before-lower'), 'row just before the lower bound is not returned').toBe(
    false
  )
  expect(got.has('user:wrong-event-type'), 'out-of-set event_type is not returned').toBe(false)
  expect(got.has('user:no-source-key'), 'row with no audit_source key is not returned').toBe(false)
  expect(got.has('user:trigger-source'), 'trigger-sourced row is not returned').toBe(false)
  expect(got.size, 'result set is exactly the four in-window rows').toBe(4)
  return out.lines
}

/** Actor A: 201 client rows via the real RPC. Actor B: 5 client rows (RPC) + 205 rows written by
 *  the REAL trg_prs_audit trigger (real INSERT). All moved into one closed bucket afterwards. */
export async function seedVolume(ctl: PsqlSession) {
  const rpc = (n: number, tag: string) =>
    `SELECT public.record_private_registry_audit_attempt(p_operation => 'get', p_result => 'error', p_detail => '${tag}-' || g) FROM generate_series(1, ${n}) g;`
  const a = await callAs(ctl, 'authenticated', U_ACTOR_A, rpc(201, 'volA'))
  expect(a.stderr, 'actor A RPC rows').not.toMatch(/ERROR/)
  const b = await callAs(ctl, 'authenticated', U_ACTOR_B, rpc(5, 'volB'))
  expect(b.stderr, 'actor B RPC rows').not.toMatch(/ERROR/)
  await ctl.send('RESET ROLE;')
  await ctl.send(claims(U_ACTOR_B))
  const trg = await ctl.send(`${realAuditTriggerSql()}
    INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash)
      SELECT '${TEAM_A}', 'nsa6114/bulk', '1.0.' || g, '{"SKILL.md":"x"}'::jsonb, 'h' FROM generate_series(1, 205) g;
    DROP TRIGGER trg_prs_audit ON private_registry_skills;`)
  expect(trg.stderr, 'trigger install + real INSERT + drop').not.toMatch(/ERROR/)
  // Control: the trigger rows exist, are in-set, belong to B, and carry the trigger's own marker.
  const ctrl = await ctl.send(
    `SELECT count(*) FROM audit_logs WHERE actor = 'user:${U_ACTOR_B}' AND event_type = 'private_registry:publish' AND metadata->>'audit_source' = 'trg_prs_audit';`
  )
  expect(scalar(ctrl.stdout), 'control: 205 trigger-written in-set rows for actor B').toBe('205')
  const mv = await ctl.send(
    `UPDATE audit_logs SET created_at = '2026-03-10 13:20:00+00'::timestamptz;`
  )
  expect(mv.stderr).not.toMatch(/ERROR/)
}

export async function assertVolumeAB(ctl: PsqlSession) {
  await seedVolume(ctl)
  const out = await callMonitor(ctl, 200, P_NOW)
  expect(out.stderr, 'monitor call must not error').not.toMatch(/ERROR/)
  const got = actorsOf(out.lines)
  expect(got.has(`user:${U_ACTOR_A}`), 'actor A (201 client rows) is returned').toBe(true)
  expect(
    out.lines.find((l) => l.startsWith(`user:${U_ACTOR_A}|`)),
    'actor A bucket and count'
  ).toBe(`user:${U_ACTOR_A}|2026-03-10T13:00|201`)
  expect(got.has(`user:${U_ACTOR_B}`), 'B not returned (5 client rows + 205 trigger rows)').toBe(
    false
  )
  expect(out.lines.length, 'result set is exactly actor A').toBe(1)
}

export function registerMonitorTests(ctx: Ctx) {
  const ctl = () => ctx.ctl()
  describe('registry_audit_volume_over_threshold()', () => {
    it('window boundaries: presence and absence in one result set', async () => {
      await assertBoundaries(ctl())
    })
    it('actor A (201 client rows) returned, actor B (5 client + trigger-written rows) not, same result set', async () => {
      await assertVolumeAB(ctl())
    })
    it('a session TimeZone of Asia/Kathmandu gives the same UTC boundaries', async () => {
      await seedBoundaries(ctl())
      const utc = await callMonitor(ctl(), 0, P_NOW)
      try {
        await ctl().send(`SET TIME ZONE 'Asia/Kathmandu';`)
        const tz = await ctl().send(`SELECT current_setting('TimeZone');`)
        expect(scalar(tz.stdout), 'control: the session zone is really in force').toBe(
          'Asia/Kathmandu'
        )
        const naive = await ctl().send(
          `SELECT to_char(date_trunc('hour', '${P_NOW}'::timestamptz) AT TIME ZONE 'UTC', 'HH24:MI');`
        )
        expect(
          scalar(naive.stdout),
          'control: a session-local hour bucket would start at :15Z'
        ).toBe('14:15')
        const npt = await callMonitor(ctl(), 0, P_NOW)
        expect(npt.stderr).not.toMatch(/ERROR/)
        expect(npt.lines, 'identical result set under Asia/Kathmandu').toEqual(utc.lines)
        expect(npt.lines.length, 'and it is not vacuously empty').toBe(4)
      } finally {
        await ctl().send(`SET TIME ZONE 'UTC';`)
      }
    })
    it('two consecutive hourly boundaries both include the intervening bucket', async () => {
      await insertRow(ctl(), 'user:mid', '2026-03-10 13:30:00+00')
      await insertRow(ctl(), 'user:h12', '2026-03-10 12:30:00+00')
      await insertRow(ctl(), 'user:h14', '2026-03-10 14:20:00+00')
      const first = actorsOf((await callMonitor(ctl(), 0, P_NOW)).lines)
      const second = actorsOf((await callMonitor(ctl(), 0, '2026-03-10 15:05:00+00')).lines)
      expect(first.has('user:mid'), '14:37 run includes the 13:00 bucket').toBe(true)
      expect(second.has('user:mid'), '15:05 run includes the 13:00 bucket').toBe(true)
      expect(first.has('user:h12') && !second.has('user:h12'), 'older bucket rolls out').toBe(true)
      expect(!first.has('user:h14') && second.has('user:h14'), 'newly closed bucket rolls in').toBe(
        true
      )
    })
    it('refuses a NULL or negative threshold (22023) and denies authenticated (42501)', async () => {
      expect(sqlstate(await callMonitor(ctl(), 'NULL', P_NOW)), 'NULL threshold').toBe('22023')
      expect(sqlstate(await callMonitor(ctl(), -1, P_NOW)), 'negative threshold').toBe('22023')
      expect(
        sqlstate(await callMonitor(ctl(), 0, P_NOW, 'authenticated')),
        'authenticated denied'
      ).toBe('42501')
    })
  })
}
