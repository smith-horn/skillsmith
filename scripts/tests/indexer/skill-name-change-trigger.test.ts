/**
 * SMI-5930 Wave 1 Step 4: `trg_rekey_skill_name_dependents` (the
 * notification-storm-safe name-change trigger added by
 * supabase/migrations/20260811000000_skill_name_change_rekey_trigger.sql)
 * against a REAL Postgres connection — not mocked. Trigger/PL-pgSQL logic
 * cannot be meaningfully verified by structural string-matching (a wrong
 * `IS DISTINCT FROM` or an inverted conflict-drop predicate reads
 * identically in migration-file text either way).
 *
 * Setup/fixture harness lives in `skill-name-change-trigger.test-helpers.ts`
 * (split out to keep this file under the 500-line gate,
 * `scripts/check-file-length.mjs`) — see that file's header for the full
 * connection/standup docs and SKIP BEHAVIOR rationale.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  queryScalar,
  testConnParamsFromEnv,
  type PgConnParams,
} from '../../indexer/smi5879-census.pg.ts'
import {
  prePushNoLiveTestPg,
  resetSchema,
  insertSkill,
  insertWorkspaceSkill,
  insertNotification,
  fetchWorkspaceSkill,
  fetchNotification,
  updateAndDidTriggerFire,
} from './skill-name-change-trigger.test-helpers.ts'

if (prePushNoLiveTestPg) {
  console.warn(
    '[skill-name-change-trigger] SKIPPED: no live test Postgres configured ' +
      '(SMI5879_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). Not yet ' +
      "covered by CI either — see SMI-5946. See this suite's test-helpers " +
      'file header for the docker run standup command to exercise this ' +
      'suite for real.'
  )
}

let conn: PgConnParams

beforeAll(async () => {
  if (prePushNoLiveTestPg) return
  const base = testConnParamsFromEnv()
  if (!base) throw new Error('unreachable: prePushNoLiveTestPg already checked')
  conn = await resetSchema(base, 'smi5930_test_rekey_trigger')
}, 60_000)

describe.skipIf(prePushNoLiveTestPg)('trg_rekey_skill_name_dependents (SMI-5930 Wave 1)', () => {
  it('name change with an existing ledger row in each table: both are re-keyed', async () => {
    const author = `acme-${randomUUID()}`
    const oldName = 'old-name'
    const newName = 'new-name'
    const oldKey = `${author}/${oldName}`
    const newKey = `${author}/${newName}`
    const workspaceId = randomUUID()
    const addedBy = randomUUID()
    const userId = randomUUID()

    const skillId = await insertSkill(conn, author, oldName)
    await insertWorkspaceSkill(conn, {
      workspaceId,
      skillId: oldKey,
      addedBy,
      addedAt: '2021-06-01T00:00:00Z',
    })
    await insertNotification(conn, {
      userId,
      skillId: oldKey,
      lastNotifiedHash: 'hash-preserved',
      lastNotifiedAt: '2021-06-01T00:00:00Z',
    })

    const fired = await updateAndDidTriggerFire(
      conn,
      `UPDATE skills SET name = :'new_name' WHERE id = :'id'::uuid;`,
      { new_name: newName, id: skillId }
    )
    expect(fired).toBe(true)

    // Old key gone from both tables.
    expect(await fetchWorkspaceSkill(conn, workspaceId, oldKey)).toBeNull()
    expect(await fetchNotification(conn, userId, 'public', oldKey)).toBeNull()

    // New key present, carrying the OLD row's own data forward (re-keyed, not
    // dropped-and-reinserted).
    const wsRow = await fetchWorkspaceSkill(conn, workspaceId, newKey)
    expect(wsRow).not.toBeNull()
    expect(wsRow!.addedBy).toBe(addedBy)
    expect(wsRow!.addedAtEpoch).toBe(String(Date.parse('2021-06-01T00:00:00Z') / 1000))

    const notifRow = await fetchNotification(conn, userId, 'public', newKey)
    expect(notifRow).not.toBeNull()
    expect(notifRow!.lastNotifiedHash).toBe('hash-preserved')
    expect(notifRow!.lastNotifiedAtEpoch).toBe(String(Date.parse('2021-06-01T00:00:00Z') / 1000))
  })

  it('name change with no ledger rows in either table: no-op, no error', async () => {
    const author = `acme-${randomUUID()}`
    const oldName = 'lonely-old'
    const newName = 'lonely-new'
    const skillId = await insertSkill(conn, author, oldName)

    const fired = await updateAndDidTriggerFire(
      conn,
      `UPDATE skills SET name = :'new_name' WHERE id = :'id'::uuid;`,
      { new_name: newName, id: skillId }
    )
    expect(fired).toBe(true) // the trigger DOES fire — it just has nothing to re-key

    const totalWorkspaceRows = await queryScalar(
      conn,
      `SELECT count(*)::text FROM workspace_skills WHERE skill_id IN (:'old_key', :'new_key');`,
      { old_key: `${author}/${oldName}`, new_key: `${author}/${newName}` }
    )
    expect(totalWorkspaceRows).toBe('0')

    const totalNotifRows = await queryScalar(
      conn,
      `SELECT count(*)::text FROM skill_update_notifications_sent WHERE skill_id IN (:'old_key', :'new_key');`,
      { old_key: `${author}/${oldName}`, new_key: `${author}/${newName}` }
    )
    expect(totalNotifRows).toBe('0')
  })

  it('new key already has a row in each table: old-key row dropped, new-key row untouched', async () => {
    const author = `acme-${randomUUID()}`
    const oldName = 'conflict-old'
    const newName = 'conflict-new'
    const oldKey = `${author}/${oldName}`
    const newKey = `${author}/${newName}`
    const workspaceId = randomUUID()
    const oldAddedBy = randomUUID()
    const newAddedBy = randomUUID() // deliberately different — proves "untouched"
    const userId = randomUUID()

    const skillId = await insertSkill(conn, author, oldName)
    await insertWorkspaceSkill(conn, {
      workspaceId,
      skillId: oldKey,
      addedBy: oldAddedBy,
      addedAt: '2021-01-01T00:00:00Z',
    })
    await insertWorkspaceSkill(conn, {
      workspaceId,
      skillId: newKey,
      addedBy: newAddedBy,
      addedAt: '2022-02-02T00:00:00Z',
    })
    await insertNotification(conn, {
      userId,
      skillId: oldKey,
      lastNotifiedHash: 'hash-old-should-be-dropped',
      lastNotifiedAt: '2021-01-01T00:00:00Z',
    })
    await insertNotification(conn, {
      userId,
      skillId: newKey,
      lastNotifiedHash: 'hash-new-should-survive',
      lastNotifiedAt: '2022-02-02T00:00:00Z',
    })

    const fired = await updateAndDidTriggerFire(
      conn,
      `UPDATE skills SET name = :'new_name' WHERE id = :'id'::uuid;`,
      { new_name: newName, id: skillId }
    )
    expect(fired).toBe(true)

    // Old key gone — dropped, not merged.
    expect(await fetchWorkspaceSkill(conn, workspaceId, oldKey)).toBeNull()
    expect(await fetchNotification(conn, userId, 'public', oldKey)).toBeNull()

    // New key's PRE-EXISTING row is untouched — still the new row's own data,
    // not overwritten by the old row's data.
    const wsRow = await fetchWorkspaceSkill(conn, workspaceId, newKey)
    expect(wsRow).not.toBeNull()
    expect(wsRow!.addedBy).toBe(newAddedBy)
    expect(wsRow!.addedAtEpoch).toBe(String(Date.parse('2022-02-02T00:00:00Z') / 1000))

    const notifRow = await fetchNotification(conn, userId, 'public', newKey)
    expect(notifRow).not.toBeNull()
    expect(notifRow!.lastNotifiedHash).toBe('hash-new-should-survive')
    expect(notifRow!.lastNotifiedAtEpoch).toBe(String(Date.parse('2022-02-02T00:00:00Z') / 1000))

    // No duplicate under either key — exactly one workspace_skills row and one
    // notification row survive for this workspace/user.
    const wsCount = await queryScalar(
      conn,
      `SELECT count(*)::text FROM workspace_skills WHERE workspace_id = :'workspace_id'::uuid;`,
      { workspace_id: workspaceId }
    )
    expect(wsCount).toBe('1')
  })

  it('name unchanged: the trigger does not fire at all', async () => {
    const author = `acme-${randomUUID()}`
    const name = 'unchanging-name'
    const key = `${author}/${name}`
    const workspaceId = randomUUID()
    const addedBy = randomUUID()

    const skillId = await insertSkill(conn, author, name)
    await insertWorkspaceSkill(conn, { workspaceId, skillId: key, addedBy })

    // Touch an unrelated column — name and author both stay identical.
    const fired = await updateAndDidTriggerFire(
      conn,
      `UPDATE skills SET content_hash = :'hash' WHERE id = :'id'::uuid;`,
      { hash: 'some-content-hash', id: skillId }
    )
    expect(fired).toBe(false)

    // Belt-and-suspenders: the ledger row is untouched (still present, same key).
    const wsRow = await fetchWorkspaceSkill(conn, workspaceId, key)
    expect(wsRow).not.toBeNull()
    expect(wsRow!.addedBy).toBe(addedBy)
  })

  // Bonus case verifying this implementation's one behavioral deviation from
  // the plan's draft SQL (see the migration file's "Deviation 1" header note):
  // the WHEN clause was widened to also fire on an author-only change, since
  // the function body already keys off OLD.author/NEW.author and a
  // name-only guard would have silently left this case unhandled.
  it('author change with name unchanged: still fires and re-keys (WHEN-clause fix)', async () => {
    const oldAuthor = `old-owner-${randomUUID()}`
    const newAuthor = `new-owner-${randomUUID()}`
    const name = 'stable-name'
    const oldKey = `${oldAuthor}/${name}`
    const newKey = `${newAuthor}/${name}`
    const workspaceId = randomUUID()
    const addedBy = randomUUID()

    const skillId = await insertSkill(conn, oldAuthor, name)
    await insertWorkspaceSkill(conn, {
      workspaceId,
      skillId: oldKey,
      addedBy,
      addedAt: '2023-03-03T00:00:00Z',
    })

    const fired = await updateAndDidTriggerFire(
      conn,
      `UPDATE skills SET author = :'new_author' WHERE id = :'id'::uuid;`,
      { new_author: newAuthor, id: skillId }
    )
    expect(fired).toBe(true)

    expect(await fetchWorkspaceSkill(conn, workspaceId, oldKey)).toBeNull()
    const wsRow = await fetchWorkspaceSkill(conn, workspaceId, newKey)
    expect(wsRow).not.toBeNull()
    expect(wsRow!.addedBy).toBe(addedBy)
    expect(wsRow!.addedAtEpoch).toBe(String(Date.parse('2023-03-03T00:00:00Z') / 1000))
  })
})
