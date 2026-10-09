/**
 * SMI-6114 -- length and range bound arms for `record_private_registry_audit_attempt()`.
 * Split out of pg-rpc.ts to keep each file under 500 lines. Exported for the revert block.
 *
 * @module scripts/tests/supabase/private-registry-audit-attempt.pg-bounds
 */

import { expect } from 'vitest'
import {
  TEAM_A,
  U_MEMBER,
  attempt,
  scalar,
  snapshot,
  sqlstate,
  type PsqlSession,
} from './private-registry-audit-attempt.test-helpers.ts'

async function totalRows(ctl: PsqlSession): Promise<string | null> {
  return scalar((await ctl.send('SELECT count(*) FROM audit_logs;')).stdout)
}

const text = (ch: string, n: number) => ch.repeat(n)
let bndSeq = 0
const bndKey = () => `bd${String(++bndSeq).padStart(10, '0')}`

export interface Bound {
  arg: string
  limit: number
  mk: (n: number) => Record<string, string>
  field: string
}
export const BOUNDS: Bound[] = [
  {
    arg: 'p_skill_id',
    limit: 256,
    mk: (n) => ({ skillId: text('日', n) }),
    field: 'requested_skill_id',
  },
  {
    arg: 'p_version',
    limit: 64,
    mk: (n) => ({ version: text('日', n) }),
    field: 'requested_version',
  },
  {
    arg: 'p_team_id',
    limit: 128,
    mk: (n) => ({ teamId: text('日', n) }),
    field: 'requested_team_id',
  },
  {
    arg: 'p_content_hash',
    limit: 128,
    mk: (n) => ({ contentHash: text('日', n) }),
    field: 'requested_content_hash',
  },
  { arg: 'p_detail', limit: 1024, mk: (n) => ({ detail: text('日', n) }), field: 'detail' },
]

/** Multibyte at the boundary: accepted at `limit` characters (which exceeds `limit` BYTES, so a
 *  byte-based check would refuse it), refused 22023 at limit + 1. */
export async function assertTextBound(ctl: PsqlSession, b: Bound) {
  const key = bndKey()
  const ok = await attempt(ctl, U_MEMBER, {
    operation: 'get',
    result: 'error',
    fingerprint: key.slice(0, 12),
    ...b.mk(b.limit),
  })
  expect(ok.stderr, `${b.arg} at ${b.limit} multibyte chars is accepted`).not.toMatch(/ERROR/)
  const s = await snapshot(ctl, `al.metadata->>'license_key_fingerprint' = '${key.slice(0, 12)}'`)
  expect(s, `${b.arg}: row written at the limit`).not.toBeNull()
  expect([...String(s!.md[b.field])].length, `${b.arg}: stored whole (char_length)`).toBe(b.limit)
  const before = await totalRows(ctl)
  const over = await attempt(ctl, U_MEMBER, {
    operation: 'get',
    result: 'error',
    ...b.mk(b.limit + 1),
  })
  expect(sqlstate(over), `${b.arg} at ${b.limit + 1} chars raises 22023`).toBe('22023')
  expect(await totalRows(ctl), `${b.arg}: over-limit writes no row`).toBe(before)
}

export async function assertSkillIdCharBound(ctl: PsqlSession) {
  await assertTextBound(ctl, BOUNDS[0])
}

export async function assertValueBound(
  ctl: PsqlSession,
  tag: string,
  args: Record<string, string | number | null>,
  ok: boolean
) {
  const before = await totalRows(ctl)
  const res = await attempt(ctl, U_MEMBER, {
    operation: 'get',
    result: 'error',
    teamId: TEAM_A,
    detail: `vb-${tag}`,
    ...args,
  })
  if (ok) {
    expect(res.stderr, `${tag}: in-range value accepted`).not.toMatch(/ERROR/)
    expect(Number(await totalRows(ctl)), `${tag}: one row written`).toBe(Number(before) + 1)
  } else {
    expect(sqlstate(res), `${tag}: out-of-range raises 22023`).toBe('22023')
    expect(await totalRows(ctl), `${tag}: no row written`).toBe(before)
  }
}
