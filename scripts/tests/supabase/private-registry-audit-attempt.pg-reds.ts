/**
 * SMI-6114 / SMI-6598 — revert-then-restore red-tests.
 *
 * Each test: (1) DECLARES, in the `declared` regex written next to it BEFORE any run, the exact
 * assertion label that must fail; (2) rebuilds the schema from an in-memory broken COPY of the
 * migration (the file on disk is never touched); (3) runs the same assertion function the green
 * arm runs and requires it to throw an error whose message matches the declared label -- so a red
 * that arrives anywhere else (setup, compilation, a different assertion) fails THIS test rather
 * than counting; (4) rebuilds the real migration in a `finally`, so a failing red can never leave
 * the database on the broken build, and requires the assertion to pass again.
 *
 * @module scripts/tests/supabase/private-registry-audit-attempt.pg-reds
 */

import { describe, it, expect } from 'vitest'
import {
  brokenMigrationSql,
  type RevertVariant,
} from './private-registry-audit-attempt.test-reverts.ts'
import {
  migrationSql,
  type Ctx,
  type PsqlSession,
} from './private-registry-audit-attempt.test-helpers.ts'
import {
  assertAcceptedCase,
  assertAnonNoExecute,
  assertCatalogShape,
  assertClosedSet,
  assertMemberOtherNamespace,
  assertNonMemberCase,
  assertRefusedCase,
  assertRowsInvisibleToMembers,
  assertServiceRoleNoExecute,
} from './private-registry-audit-attempt.pg-rpc.ts'
import { assertSkillIdCharBound } from './private-registry-audit-attempt.pg-bounds.ts'
import {
  assertBoundaries,
  assertKathmanduSameBoundaries,
  assertVolumeAB,
} from './private-registry-audit-attempt.pg-monitor.ts'

async function redThenRestore(
  ctx: Ctx,
  variant: RevertVariant,
  declared: RegExp,
  assertion: (ctl: PsqlSession) => Promise<unknown>,
  opts?: { expectSelfSmokeFailure?: RegExp }
) {
  try {
    await ctx.rebuild(brokenMigrationSql(variant), opts)
    let failure: Error | null = null
    try {
      await assertion(ctx.ctl())
    } catch (e) {
      failure = e as Error
    }
    if (process.env.SMI6114_REDS_VERBOSE)
      console.log(`[RED ${variant}] ${failure ? failure.message.split('\n')[0] : 'NO FAILURE'}`)
    expect(failure, `${variant}: the mutation must make the assertion FAIL`).not.toBeNull()
    expect(failure!.message, `${variant}: it must fail at the DECLARED assertion`).toMatch(declared)
  } finally {
    await ctx.rebuild(migrationSql())
  }
  await assertion(ctx.ctl()) // restored: passes again
}

export function registerRedTests(ctx: Ctx) {
  describe('revert-then-restore (SMI-6598)', () => {
    it('adding a team_id key for members fails at NOT (metadata ? team_id)', async () => {
      // DECLARED: acc-get-error: NOT (metadata ? 'team_id')
      await redThenRestore(
        ctx,
        'team-id-key-added',
        /acc-get-error: NOT \(metadata \? 'team_id'\)/,
        (c) => assertAcceptedCase(c, 'get', 'error')
      )
    })

    it('adding a team_id key for members fails at "members see ZERO rows the RPC wrote"', async () => {
      // DECLARED: members see ZERO rows the RPC wrote (paired presence and control pass first)
      await redThenRestore(ctx, 'team-id-key-added', /members see ZERO rows the RPC wrote/, (c) =>
        assertRowsInvisibleToMembers(c)
      )
    })

    it('removing REVOKE ... FROM service_role fails at has_function_privilege(service_role)', async () => {
      // DECLARED: has_function_privilege('service_role', rpc, 'EXECUTE') is false
      await redThenRestore(
        ctx,
        'service-role-revoke-removed',
        /has_function_privilege\('service_role', rpc, 'EXECUTE'\) is false/,
        (c) => assertServiceRoleNoExecute(c)
      )
    })

    it('dropping the audit_source clause fails at "B not returned"', async () => {
      // DECLARED: B not returned (5 client rows + 205 trigger rows now push B over 200)
      await redThenRestore(ctx, 'audit-source-clause-dropped', /B not returned/, (c) =>
        assertVolumeAB(c)
      )
    })

    it('HAVING count(*) >= p_threshold fails at "C absent at threshold 200"', async () => {
      // DECLARED: C absent at threshold 200 (exactly 200 rows)
      await redThenRestore(ctx, 'having-ge', /C absent at threshold 200/, (c) => assertVolumeAB(c))
    })

    it('upper bound <= p_now fails at "open bucket row is not returned"', async () => {
      // DECLARED: open bucket row is not returned
      await redThenRestore(ctx, 'upper-bound-le-now', /open bucket row is not returned/, (c) =>
        assertBoundaries(c)
      )
    })

    it('removing the UTC pin fails at "identical result set under Asia/Kathmandu"', async () => {
      // DECLARED: identical result set under Asia/Kathmandu
      await redThenRestore(
        ctx,
        'utc-pin-removed',
        /identical result set under Asia\/Kathmandu/,
        (c) => assertKathmanduSameBoundaries(c)
      )
    })

    it("the precedent's NULL-admitting idiom on p_operation fails at the SQLSTATE 22023 assertion", async () => {
      // DECLARED: null-operation: SQLSTATE is 22023 (a NULL operation now reaches the INSERT: 23502)
      await redThenRestore(
        ctx,
        'null-operation-admitted',
        /null-operation: SQLSTATE is 22023/,
        (c) => assertClosedSet(c, 'null-operation', null, 'error')
      )
    })

    it("the precedent's NULL-admitting idiom on p_result fails at the SQLSTATE 22023 assertion", async () => {
      // DECLARED: null-result: SQLSTATE is 22023 (a NULL result is now silently written)
      await redThenRestore(ctx, 'null-result-admitted', /null-result: SQLSTATE is 22023/, (c) =>
        assertClosedSet(c, 'null-result', 'get', null)
      )
    })

    it("removing REVOKE ... FROM anon trips the migration's own smoke block at the anon-EXECUTE check", async () => {
      // DECLARED: SMOKE FAIL (fn-catalog): anon holds EXECUTE on ...
      try {
        await ctx.rebuild(brokenMigrationSql('anon-revoke-removed'), {
          expectSelfSmokeFailure: /SMOKE FAIL \(fn-catalog\): anon holds EXECUTE/,
        })
      } finally {
        await ctx.rebuild(migrationSql())
      }
    })

    it("removing REVOKE ... FROM anon (smoke blinded) fails at has_function_privilege('anon')", async () => {
      // DECLARED: has_function_privilege('anon', rpc, 'EXECUTE') is false
      await redThenRestore(
        ctx,
        'anon-revoke-removed-smoke-blind',
        /has_function_privilege\('anon', rpc, 'EXECUTE'\) is false/,
        (c) => assertAnonNoExecute(c)
      )
    })

    it('adding a p_actor parameter fails at the proargnames element-for-element assertion', async () => {
      // DECLARED: proargnames element for element
      await redThenRestore(ctx, 'actor-parameter-added', /proargnames element for element/, (c) =>
        assertCatalogShape(c)
      )
    })

    it('dropping the namespace equality fails at the member-other-namespace JSON-null skill_id', async () => {
      // DECLARED: mo-get: other-namespace skill_id is JSON null
      await redThenRestore(
        ctx,
        'namespace-equality-dropped',
        /mo-get: other-namespace skill_id is JSON null/,
        (c) => assertMemberOtherNamespace(c, 'get')
      )
    })

    it('letting a non-member populate skill_id fails at the non-member JSON-null skill_id', async () => {
      // DECLARED: nm-get: non-member skill_id is JSON null
      await redThenRestore(
        ctx,
        'non-member-attributed',
        /nm-get: non-member skill_id is JSON null/,
        (c) => assertNonMemberCase(c, 'get')
      )
    })

    it('counting bytes instead of characters on p_skill_id fails at "256 multibyte chars is accepted"', async () => {
      // DECLARED: p_skill_id at 256 multibyte chars is accepted
      await redThenRestore(
        ctx,
        'octet-length-bound',
        /p_skill_id at 256 multibyte chars is accepted/,
        (c) => assertSkillIdCharBound(c)
      )
    })

    it('removing the mutation-success refusal fails at "refusal raises 22023"', async () => {
      // DECLARED: ref-publish-success: refusal raises 22023
      await redThenRestore(
        ctx,
        'mutation-success-refusal-removed',
        /ref-publish-success: refusal raises 22023/,
        (c) => assertRefusedCase(c, 'publish', 'success')
      )
    })

    it('removing the content_read refusal fails at "refusal raises 22023"', async () => {
      // DECLARED: ref-content_read-success: refusal raises 22023
      await redThenRestore(
        ctx,
        'content-read-refusal-removed',
        /ref-content_read-success: refusal raises 22023/,
        (c) => assertRefusedCase(c, 'content_read', 'success')
      )
    })
  })
}
