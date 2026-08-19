/**
 * SMI-5898 Wave 2 Step 1: `trg_set_repo_url_canonical` (the case-insensitive
 * `repo_url` normalization trigger added by
 * supabase/migrations/20260819000000_smi5898_repo_url_canonical.sql)
 * against a REAL Postgres connection — not mocked. The design doc's own
 * original normalization expression looked plausible as migration-file text
 * but was a silent no-op (`lower('\1')` lowercases the two-character
 * backreference token, not the text it expands to) — exactly the class of
 * bug structural string-matching cannot catch.
 *
 * Setup/fixture harness lives in
 * `repo-url-canonical-trigger.test-helpers.ts` (split out to keep this file
 * under the 500-line gate) — see that file's header for the connection/
 * standup docs and SKIP BEHAVIOR rationale.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { testConnParamsFromEnv, type PgConnParams } from '../../indexer/smi5879-census.pg.ts'
import {
  prePushNoLiveTestPg,
  resetSchema,
  insertSkill,
  updateSkillRepoUrl,
} from './repo-url-canonical-trigger.test-helpers.ts'

if (prePushNoLiveTestPg) {
  console.warn(
    '[repo-url-canonical-trigger] SKIPPED: no live test Postgres configured ' +
      '(SMI5879_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). See this ' +
      "suite's test-helpers file header for the docker run standup command."
  )
}

let conn: PgConnParams

beforeAll(async () => {
  if (prePushNoLiveTestPg) return
  const base = testConnParamsFromEnv()
  if (!base) throw new Error('unreachable: prePushNoLiveTestPg already checked')
  conn = await resetSchema(base, 'smi5898_test_repo_url_canonical')
}, 60_000)

describe.skipIf(prePushNoLiveTestPg)('trg_set_repo_url_canonical — INSERT path (SMI-5898)', () => {
  it('the actual production bug: case-only owner/repo rename produces IDENTICAL canonical', async () => {
    const a = await insertSkill(
      conn,
      'https://github.com/gabrielwithappy/agentos/tree/main/.agents/skills/harness/debug'
    )
    const b = await insertSkill(
      conn,
      'https://github.com/gabrielwithappy/agentOS/tree/main/.agents/skills/harness/debug'
    )
    expect(a.canonical).not.toBeNull()
    expect(a.canonical).toBe(b.canonical)
    expect(a.canonical).toBe(
      'https://github.com/gabrielwithappy/agentos/tree/main/.agents/skills/harness/debug'
    )
  })

  it("lowercases host+owner+repo only — path/branch segments untouched (the design doc's own worst-case footgun)", async () => {
    const { canonical } = await insertSkill(
      conn,
      'https://github.com/Foo/Bar/tree/Main/.claude/skills/Foo'
    )
    // Owner+repo lowercased; 'Main' branch and 'Foo' path segment must NOT be.
    expect(canonical).toBe('https://github.com/foo/bar/tree/Main/.claude/skills/Foo')
  })

  it('trailing slash stripped', async () => {
    const { canonical } = await insertSkill(conn, 'https://github.com/owner/repo/')
    expect(canonical).toBe('https://github.com/owner/repo')
  })

  it('.git suffix stripped from the repo segment only', async () => {
    const { canonical } = await insertSkill(conn, 'https://github.com/owner/repo.git')
    expect(canonical).toBe('https://github.com/owner/repo')
  })

  it('.git appearing inside the path/branch segment is left untouched (not stripped)', async () => {
    const { canonical } = await insertSkill(
      conn,
      'https://github.com/owner/repo/tree/main/some.git-folder/skill'
    )
    expect(canonical).toBe('https://github.com/owner/repo/tree/main/some.git-folder/skill')
  })

  it('bare root-tree URL with no path suffix', async () => {
    const { canonical } = await insertSkill(conn, 'https://github.com/owner/repo')
    expect(canonical).toBe('https://github.com/owner/repo')
  })

  it('NULL repo_url produces NULL canonical (discovery-only rows)', async () => {
    const { canonical } = await insertSkill(conn, null)
    expect(canonical).toBeNull()
  })

  it('malformed repo_url produces NULL canonical, does not crash the write path', async () => {
    const { canonical } = await insertSkill(conn, 'not-a-url-at-all')
    expect(canonical).toBeNull()
  })
})

describe.skipIf(prePushNoLiveTestPg)('trg_set_repo_url_canonical — UPDATE path (SMI-5898)', () => {
  it('UPDATE recomputes canonical when repo_url changes', async () => {
    const { id } = await insertSkill(conn, 'https://github.com/owner/repo-one')
    const updated = await updateSkillRepoUrl(conn, id, 'https://github.com/Owner/Repo-Two')
    expect(updated).toBe('https://github.com/owner/repo-two')
  })

  it('UPDATE to NULL clears canonical', async () => {
    const { id } = await insertSkill(conn, 'https://github.com/owner/repo')
    const updated = await updateSkillRepoUrl(conn, id, null)
    expect(updated).toBeNull()
  })
})
