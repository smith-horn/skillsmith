/**
 * SMI-6345 Wave 1 Step 4 — the per-device lock protocol (ADR-144 §9) and the SMI-6353
 * provenance regression, exercised with TWO REAL, SIMULTANEOUS Postgres sessions.
 *
 * WHAT IS ACTUALLY BEING PROVED. `reconcile_device_inventory()` shipped for months with
 * NO explicit lock — only an INCIDENTAL one, of NO KEY UPDATE strength, from its device
 * upsert, which nothing documented as a serialization point. The Step 1 lock-ordering
 * audit could reason about that but could not measure it. These tests measure it: the
 * same interleaving runs against the shipped `FOR UPDATE` lock and against a NO KEY
 * UPDATE lock side by side, so "the new lock is a genuine strengthening" stops being an
 * inference. A sequential simulation would prove none of it — to a lone session a locking
 * read and an unlocked read are indistinguishable, so a single-session test cannot
 * distinguish a locked ownership read from the unlocked one this function shipped with.
 *
 * Harness, env vars, CI-coverage gap: ./inventory-device-lock.test-helpers.ts.
 *
 * DEFERRED TO WAVE 3, deliberately and not silently: matrix rows C-1 (reconcile vs the
 * classification procedure), C-6 (two racing `CALL classify_device_identity_batch(...)`)
 * and C-7 (`rollback_identity_after(N)` vs a live reconcile) all name procedures Wave 3
 * introduces. They ship with the procedures they test.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  InventoryProbe,
  PsqlSession,
  requireTestConn,
  noLiveTestPg,
  schemaSql,
  fixtureSql,
  reconcileSql,
  asUser,
  sleep,
  OWNER,
  OTHER_USER,
  DEVICE,
  NEW_DEVICE,
  type TestConn,
} from './inventory-device-lock.test-helpers.ts'

let conn: TestConn
let ctl: PsqlSession // control/assertion session
let a: PsqlSession // "A" — holds a transaction open
let b: PsqlSession // "B" — the concurrent competitor
let probe: InventoryProbe

const skillState = (deviceId?: string) => probe.skillState(deviceId)
const scalar = (sql: string) => probe.scalar(sql)

describe.skipIf(noLiveTestPg)('SMI-6345 — per-device lock protocol, two live sessions', () => {
  beforeAll(async () => {
    conn = requireTestConn()
    ctl = new PsqlSession(conn, 'ctl')
    probe = new InventoryProbe(ctl)
    const { stderr } = await ctl.send(schemaSql(), 60_000)
    // A failed schema build must be loud: every assertion below would otherwise pass or
    // fail for the wrong reason.
    expect(stderr, `schema build failed:\n${stderr}`).not.toMatch(/ERROR/)
  }, 90_000)

  afterAll(async () => {
    await Promise.all([ctl?.close(), a?.close(), b?.close()])
  })

  beforeEach(async () => {
    await a?.close()
    await b?.close()
    a = new PsqlSession(conn, 'A')
    b = new PsqlSession(conn, 'B')
    await ctl.send(fixtureSql())
    await a.send(asUser(OWNER))
    await b.send(asUser(OWNER))
  })

  // ==========================================================================
  // THE LOCK ITSELF — measured, including the contrast that gives it meaning.
  // ==========================================================================
  it('blocks a concurrent device_skills INSERT while a reconcile is in flight', async () => {
    // The audit's one INFERRED claim, converted into a regression test. FOR UPDATE is
    // key-strength, so it conflicts with the FOR KEY SHARE that Postgres takes on the
    // parent row for every FK-referencing child insert — which is what makes a writer
    // that ignores the protocol fail closed instead of silently interleaving.
    await a.send('BEGIN;')
    const push = await a.send(reconcileSql(DEVICE, [{ skill_id: 'alpha' }]))
    expect(push.stderr).not.toMatch(/ERROR/)

    await b.send(`SET lock_timeout = '1s';`)
    const blocked = await b.send(
      `INSERT INTO device_skills (user_id, device_id, harness, skill_id)
       VALUES ('${OWNER}', '${DEVICE}', 'claude-code', 'sneaked-in');`
    )
    expect(blocked.stderr).toMatch(/lock timeout/i)

    await a.send('COMMIT;')
    await b.send('RESET lock_timeout;')
    // Nothing was written behind the lock.
    expect(await scalar(`SELECT count(*) FROM device_skills WHERE skill_id = 'sneaked-in';`)).toBe(
      '0'
    )
  }, 60_000)

  it('would NOT have blocked it under the incidental NO KEY UPDATE lock the pre-fix body held', async () => {
    // The side-by-side that turns "FOR UPDATE is a genuine strengthening" from an
    // inference into a measurement. The pre-fix body's only lock came from its
    // `ON CONFLICT DO UPDATE` on user_devices, which touches no key column and therefore
    // takes NO KEY UPDATE — which does NOT conflict with the FK insert's FOR KEY SHARE.
    await a.send('BEGIN;')
    await a.send(
      `SELECT d.user_id FROM user_devices d WHERE d.device_id = '${DEVICE}' FOR NO KEY UPDATE;`
    )

    await b.send(`SET lock_timeout = '1s';`)
    const notBlocked = await b.send(
      `INSERT INTO device_skills (user_id, device_id, harness, skill_id)
       VALUES ('${OWNER}', '${DEVICE}', 'claude-code', 'slipped-through');`
    )
    expect(notBlocked.stderr).not.toMatch(/lock timeout|ERROR/i)

    // And the same interleaving against the shipped key-strength lock IS refused.
    await a.send('ROLLBACK;')
    await a.send('BEGIN;')
    await a.send(`SELECT d.user_id FROM user_devices d WHERE d.device_id = '${DEVICE}' FOR UPDATE;`)
    const refused = await b.send(
      `INSERT INTO device_skills (user_id, device_id, harness, skill_id)
       VALUES ('${OWNER}', '${DEVICE}', 'claude-code', 'refused');`
    )
    expect(refused.stderr).toMatch(/lock timeout/i)

    await a.send('ROLLBACK;')
    await b.send('RESET lock_timeout;')
  }, 60_000)

  it('locks NOTHING when consent is disabled', async () => {
    // ADR-124: a consent-disabled call must write nothing AND lock nothing. The lock is
    // placed after the consent gate precisely so an opted-out user's push cannot contend
    // for their own device row.
    await ctl.send(
      `UPDATE user_telemetry_preferences SET inventory_sync_enabled = FALSE
        WHERE user_id = '${OWNER}';`
    )
    await a.send('BEGIN;')
    const push = await a.send(reconcileSql(DEVICE, [{ skill_id: 'alpha' }]))
    expect(push.stdout).toMatch(/consent_disabled/)

    await b.send(`SET lock_timeout = '1s';`)
    const insert = await b.send(
      `INSERT INTO device_skills (user_id, device_id, harness, skill_id)
       VALUES ('${OWNER}', '${DEVICE}', 'claude-code', 'no-lock-taken');`
    )
    expect(insert.stderr).not.toMatch(/lock timeout|ERROR/i)

    await a.send('ROLLBACK;')
    await b.send('RESET lock_timeout;')
  }, 60_000)

  it('does not serialize unrelated devices', async () => {
    // The lock must be per-device, not a table-level or global gate. A "fix" for
    // contention that widened it would make every user's push queue behind every other.
    const other = '6345dddd-0000-0000-0000-0000000000d2'
    await ctl.send(
      `INSERT INTO user_devices (device_id, user_id, label, last_seen_at)
       VALUES ('${other}', '${OWNER}', 'second-box', now());`
    )
    await a.send('BEGIN;')
    await a.send(reconcileSql(DEVICE, [{ skill_id: 'alpha' }]))

    await b.send(`SET lock_timeout = '1s';`)
    const push = await b.send(reconcileSql(other, [{ skill_id: 'zulu' }], 'second-box'))
    expect(push.stderr).not.toMatch(/lock timeout|ERROR/i)
    expect(push.stdout).toMatch(/"applied": ?true/)

    await a.send('COMMIT;')
    await b.send('RESET lock_timeout;')
  }, 60_000)

  it('still fails closed on a cross-user device_id, now on a serialized read', async () => {
    // Regression on the fold: the ownership guard moved INTO the locking statement, so
    // its refusal must be unchanged.
    await b.send(asUser(OTHER_USER))
    const push = await b.send(reconcileSql(DEVICE, [{ skill_id: 'intruder' }]))
    expect(push.stderr).toMatch(/device_owned_by_another_user/)
    expect(await scalar(`SELECT count(*) FROM device_skills WHERE skill_id = 'intruder';`)).toBe(
      '0'
    )
  }, 60_000)

  // ==========================================================================
  // C-2 — reconcile vs reconcile, same device.
  // ==========================================================================
  it('C-2: two reconciles on the same device serialize rather than interleave', async () => {
    await a.send('BEGIN;')
    await a.send(reconcileSql(DEVICE, [{ skill_id: 'alpha' }, { skill_id: 'gamma' }]))

    await b.send(`SET lock_timeout = '1s';`)
    const contended = await b.send(reconcileSql(DEVICE, [{ skill_id: 'beta' }]))
    expect(contended.stderr).toMatch(/lock timeout/i)

    await a.send('COMMIT;')
    await b.send('RESET lock_timeout;')
  }, 60_000)

  it('C-2: no lost mark-absent, no mixed outcome, monotonic last_seen_at, identity untouched', async () => {
    await probe.snapshotLastSeen()
    const identityBefore = await scalar(
      `SELECT canonical_skill_id || '|' || identity_evidence || '|' || evidence_protocol
         FROM device_skills WHERE device_id = '${DEVICE}' AND skill_id = 'beta';`
    )
    expect(identityBefore).toBe('acme/beta|manifest|1')

    // `shared` is in BOTH pushes: the lost-mark-absent failure mode is a row that both
    // pushes reported present ending up present = false, which is what an interleaved
    // mark-absent (B's UPDATE landing after A's re-assert) would produce.
    await a.send('BEGIN;')
    await a.send(
      reconcileSql(DEVICE, [{ skill_id: 'alpha' }, { skill_id: 'gamma' }, { skill_id: 'shared' }])
    )

    let settled = false
    const second = b
      .fire(
        reconcileSql(DEVICE, [{ skill_id: 'beta' }, { skill_id: 'delta' }, { skill_id: 'shared' }])
      )
      .then((r) => {
        settled = true
        return r
      })
    await sleep(500)
    // It is WAITING, not skipping: a skipped reconcile would be a silently dropped push.
    expect(settled, 'the second reconcile committed inside the first push window').toBe(false)

    await a.send('COMMIT;')
    const result = await second
    expect(result.stderr).not.toMatch(/ERROR|deadlock/i)

    // Exactly the later push's outcome — never a mixture of both pushes' present sets —
    // and `shared`, reported by both, is present rather than casualty of a lost mark-absent.
    expect(await skillState()).toBe('alpha:f,beta:t,delta:t,gamma:f,shared:t')
    expect(await probe.lastSeenRegressions()).toBe('0')
    // Stickiness (ADR-144 §4 rule 2): reconcile writes no identity column, so Wave 2's
    // resolved identities survive an ordinary push. Wave 2's whole demotion design
    // depends on this being true BEFORE it ships.
    const identityAfter = await scalar(
      `SELECT canonical_skill_id || '|' || identity_evidence || '|' || evidence_protocol
         FROM device_skills WHERE device_id = '${DEVICE}' AND skill_id = 'beta';`
    )
    expect(identityAfter).toBe(identityBefore)
  }, 60_000)

  // ==========================================================================
  // C-3 — reconcile vs purge_user_inventory, same device.
  // ==========================================================================
  it('C-3: a purge waits for an in-flight reconcile, then erases both tables cleanly', async () => {
    await a.send('BEGIN;')
    await a.send(reconcileSql(DEVICE, [{ skill_id: 'alpha' }, { skill_id: 'gamma' }]))

    let settled = false
    const purge = b.fire('SELECT purge_user_inventory();').then((r) => {
      settled = true
      return r
    })
    await sleep(500)
    expect(settled, 'purge deleted the device while a reconcile held its lock').toBe(false)

    await a.send('COMMIT;')
    const result = await purge
    expect(result.stderr).not.toMatch(/ERROR|deadlock|foreign key/i)
    expect(result.stdout.trim().split('\n').pop()).toBe('1')

    // No orphan survives the cascade, and the erasure is complete on both tables.
    expect(await scalar(`SELECT count(*) FROM user_devices WHERE user_id = '${OWNER}';`)).toBe('0')
    expect(await scalar(`SELECT count(*) FROM device_skills WHERE user_id = '${OWNER}';`)).toBe('0')
    expect(
      await scalar(
        `SELECT count(*) FROM audit_logs WHERE event_type = 'inventory:purge.completed';`
      )
    ).toBe('1')
  }, 60_000)

  it('C-3: a reconcile after a purge does not resurrect purged rows', async () => {
    const purged = await a.send('SELECT purge_user_inventory();')
    expect(purged.stdout.trim().split('\n').pop()).toBe('1')

    const push = await a.send(reconcileSql(DEVICE, [{ skill_id: 'delta' }]))
    expect(push.stderr).not.toMatch(/ERROR/)

    // The device comes back because the client re-registered it; the previously purged
    // skills do NOT, because the reconcile only ever asserts its own pushed set.
    expect(await skillState()).toBe('delta:t')
    expect(await scalar(`SELECT count(*) FROM user_devices WHERE user_id = '${OWNER}';`)).toBe('1')
  }, 60_000)

  // ==========================================================================
  // C-4 — first push of an UNKNOWN device, twice concurrently (no row to lock).
  // ==========================================================================
  it('C-4: two first pushes of the same unknown device serialize on the upsert instead', async () => {
    // No user_devices row exists, so neither push takes the protocol lock — correct, per
    // ADR-144 §9: a device with no parent row has no device_skills rows to protect. They
    // must still serialize, on the unique index, and neither may surface a duplicate-key
    // error to the caller.
    await a.send('BEGIN;')
    await a.send(reconcileSql(NEW_DEVICE, [{ skill_id: 'first' }]))

    let settled = false
    const second = b.fire(reconcileSql(NEW_DEVICE, [{ skill_id: 'second' }])).then((r) => {
      settled = true
      return r
    })
    await sleep(500)
    expect(settled).toBe(false)

    await a.send('COMMIT;')
    const result = await second
    expect(result.stderr).not.toMatch(/duplicate key|ERROR|deadlock/i)

    expect(
      await scalar(`SELECT count(*) FROM user_devices WHERE device_id = '${NEW_DEVICE}';`)
    ).toBe('1')
    // Both pushes' rows exist; the later push's set is the present one, which is the
    // set-reconciliation contract, not a lost write.
    expect(await skillState(NEW_DEVICE)).toBe('first:f,second:t')
  }, 60_000)

  it('C-4: a different user racing the same unknown device_id is refused with 23503, writing nothing', async () => {
    await b.send(asUser(OTHER_USER))
    await a.send('BEGIN;')
    await a.send(reconcileSql(NEW_DEVICE, [{ skill_id: 'first' }]))

    const second = b.fire(reconcileSql(NEW_DEVICE, [{ skill_id: 'hijack' }]))
    await sleep(500)
    await a.send('COMMIT;')
    const result = await second

    // The ownership guard cannot fire (no row existed when either read it), so the
    // composite FK is what fails closed: user_devices ends up (NEW_DEVICE, OWNER), and
    // (NEW_DEVICE, OTHER_USER) has no parent to reference.
    expect(result.stderr).toMatch(/foreign key/i)
    expect(result.stderr).toMatch(/device_skills_device_owner_fk/)

    expect(
      await scalar(`SELECT user_id FROM user_devices WHERE device_id = '${NEW_DEVICE}';`)
    ).toBe(OWNER)
    expect(await skillState(NEW_DEVICE)).toBe('first:t')
    expect(
      await scalar(`SELECT count(*) FROM device_skills WHERE user_id = '${OTHER_USER}';`)
    ).toBe('0')
  }, 60_000)

  // ==========================================================================
  // C-5 — identity mutation under concurrency.
  //
  // SCOPE NOTE (sharpened per SMI-6345 Wave 1 Codex adversarial review, finding 3). The
  // plan's full C-5 ("one push introduces a duplicate canonical claim, another removes
  // the other claimant") needs Wave 2's ingestion-resolution logic, which does not exist
  // yet — nothing today computes an ambiguity snapshot or demotes a claimant; both tests
  // below drive that entirely by hand (manual UPDATEs, a manually-held lock, manually
  // inserted audit rows), never through application code, because no such code exists
  // yet. These two tests do NOT prove Wave 2's ambiguity computation will be correct —
  // they cannot, since it doesn't exist — and must not be read as C-5 coverage once
  // Wave 2 ships; that wave needs its own tests exercising its real resolver. What these
  // two DO prove, and all they claim to prove: the protocol LOCK itself guarantees a
  // read taken under it cannot be invalidated by a concurrent push, which is the
  // precondition Wave 2's real ambiguity computation will rely on. Read the two titles
  // below as being about the lock, not about ambiguity resolution.
  // ==========================================================================
  it('C-5 precondition: a device-row read taken under the protocol lock cannot go stale mid-transaction', async () => {
    // Introduce the duplicate canonical claim Wave 2 will detect: two rows in one
    // (device, harness) both resolving to acme/beta from independent E1 evidence.
    await ctl.send(
      `UPDATE device_skills
          SET canonical_skill_id = 'acme/beta', identity_evidence = 'manifest',
              identity_resolved_at = now(), evidence_protocol = 1
        WHERE device_id = '${DEVICE}' AND skill_id = 'alpha';`
    )

    await a.send('BEGIN;')
    await a.send(`SELECT d.user_id FROM user_devices d WHERE d.device_id = '${DEVICE}' FOR UPDATE;`)
    const snapshot1 = await a.send(
      `SELECT count(*) FROM device_skills WHERE device_id = '${DEVICE}' AND present;`
    )
    expect(snapshot1.stdout).toBe('2')

    // A concurrent push that would remove one of the two claimants.
    let settled = false
    const push = b.fire(reconcileSql(DEVICE, [{ skill_id: 'beta' }])).then((r) => {
      settled = true
      return r
    })
    await sleep(500)
    expect(settled).toBe(false)

    // Re-read under the same lock: identical, so the demotion decision below is taken on
    // a set that cannot have moved.
    const snapshot2 = await a.send(
      `SELECT count(*) FROM device_skills WHERE device_id = '${DEVICE}' AND present;`
    )
    expect(snapshot2.stdout).toBe(snapshot1.stdout)

    // The demotion a Wave 2 resolver would write, plus its audit rows.
    await a.send(
      `UPDATE device_skills
          SET canonical_skill_id = NULL, identity_evidence = 'unresolved',
              identity_resolved_at = now(), evidence_protocol = 1
        WHERE device_id = '${DEVICE}' AND skill_id IN ('alpha', 'beta');
       INSERT INTO device_skills_identity_audit
         (device_id, harness, skill_id, prior_canonical_skill_id, new_canonical_skill_id,
          prior_identity_evidence, new_identity_evidence, contested_canonical_skill_id,
          evidence_protocol_at_change, reason)
       VALUES
         ('${DEVICE}', 'claude-code', 'alpha', 'acme/beta', NULL, 'manifest', 'unresolved',
          'acme/beta', 1, 'ambiguous_duplicate'),
         ('${DEVICE}', 'claude-code', 'beta', 'acme/beta', NULL, 'manifest', 'unresolved',
          'acme/beta', 1, 'ambiguous_duplicate');`
    )
    await a.send('COMMIT;')
    const result = await push
    expect(result.stderr).not.toMatch(/ERROR|deadlock/i)

    // The push landed after, and did not clobber the identity decision.
    expect(await skillState()).toBe('alpha:f,beta:t')
    expect(
      await scalar(
        `SELECT count(*) FROM device_skills
          WHERE device_id = '${DEVICE}' AND canonical_skill_id IS NULL
            AND identity_evidence = 'unresolved';`
      )
    ).toBe('2')
    // Both competing claims stay queryable (ADR-144 §3) — the contested identifier is on
    // the audit rows, not merely implied by two unresolved rows.
    expect(
      await scalar(
        `SELECT count(*) FROM device_skills_identity_audit
          WHERE reason = 'ambiguous_duplicate' AND contested_canonical_skill_id = 'acme/beta';`
      )
    ).toBe('2')
  }, 60_000)

  it('C-5 precondition contrast: the same read DOES go stale for a writer that skips the lock', async () => {
    // The measurement that makes the previous test mean something. A non-compliant
    // writer — one that reads the device's rows without taking the protocol lock — has
    // its snapshot invalidated by a push that commits mid-decision, and would demote (or
    // fail to demote) on a set that no longer exists.
    await a.send('BEGIN;')
    const snapshot1 = await a.send(
      `SELECT count(*) FROM device_skills WHERE device_id = '${DEVICE}' AND present;`
    )
    expect(snapshot1.stdout).toBe('2')

    const push = await b.send(reconcileSql(DEVICE, [{ skill_id: 'beta' }]))
    expect(push.stderr).not.toMatch(/ERROR/)

    const snapshot2 = await a.send(
      `SELECT count(*) FROM device_skills WHERE device_id = '${DEVICE}' AND present;`
    )
    expect(snapshot2.stdout).toBe('1')
    expect(snapshot2.stdout).not.toBe(snapshot1.stdout)

    await a.send('ROLLBACK;')
  }, 60_000)

  // ==========================================================================
  // SMI-6353 — author / license / repository survive the round trip.
  // ==========================================================================
  it('SMI-6353: persists author, license and repository through reconcile', async () => {
    // This regressed silently once already: 20260707000003 reproduced a pre-SMI-5442
    // body verbatim during a rebase and every push discarded these three columns for two
    // months with no error, because jsonb_to_recordset simply does not project a field it
    // was not asked for. The harness extracts the SHIPPED body, so dropping any of the
    // five threading sites fails here rather than in production.
    const push = await a.send(
      reconcileSql(DEVICE, [
        {
          skill_id: 'prov',
          author: 'acme',
          license: 'MIT',
          repository: 'https://github.com/acme/prov',
        },
      ])
    )
    expect(push.stderr).not.toMatch(/ERROR/)
    expect(
      await scalar(
        `SELECT coalesce(author, '<null>') || '|' || coalesce(license, '<null>') || '|' ||
                coalesce(repository, '<null>')
           FROM device_skills WHERE device_id = '${DEVICE}' AND skill_id = 'prov';`
      )
    ).toBe('acme|MIT|https://github.com/acme/prov')
  }, 60_000)

  it('SMI-6353: updates author, license and repository on a subsequent push', async () => {
    // The INSERT path and the ON CONFLICT path are separate threading sites; a fix that
    // restored only the INSERT would pass the previous test and still lose every update.
    await a.send(
      reconcileSql(DEVICE, [
        { skill_id: 'prov', author: 'acme', license: 'MIT', repository: 'https://old.example' },
      ])
    )
    const second = await a.send(
      reconcileSql(DEVICE, [
        {
          skill_id: 'prov',
          author: 'acme-renamed',
          license: 'Apache-2.0',
          repository: 'https://new.example',
        },
      ])
    )
    expect(second.stderr).not.toMatch(/ERROR/)
    expect(
      await scalar(
        `SELECT author || '|' || license || '|' || repository
           FROM device_skills WHERE device_id = '${DEVICE}' AND skill_id = 'prov';`
      )
    ).toBe('acme-renamed|Apache-2.0|https://new.example')
  }, 60_000)
})
