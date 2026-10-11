/**
 * SMI-6114 / SMI-6669 (ADR-178) -- live-Postgres suite for `record_private_registry_audit_attempt()`
 * and `registry_audit_volume_over_threshold()`. Harness, env vars, real-vs-stub inventory:
 * ./private-registry-audit-attempt.test-helpers.ts.
 *
 * ONE test file on purpose: the arms live in sibling modules (pg-rpc / pg-monitor / pg-reds) and are
 * registered here, because every arm rebuilds the same database and vitest runs separate test
 * FILES in parallel. The PG-free assertions about the migration's text live in
 * ./private-registry-audit-attempt.structural.test.ts, which has no Postgres gate.
 *
 * The pg_cron job and alert edge function are deferred to SMI-7050, so scheduling is not tested;
 * the predicate the job will call is.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest'
import {
  PsqlSession,
  baseSchemaSql,
  fixtureSql,
  migrationSql,
  noLiveTestPg,
  requireTestConn,
  type Ctx,
} from './private-registry-audit-attempt.test-helpers.ts'
import { registerRpcTests } from './private-registry-audit-attempt.pg-rpc.ts'
import { registerMonitorTests } from './private-registry-audit-attempt.pg-monitor.ts'
import { registerRedTests } from './private-registry-audit-attempt.pg-reds.ts'

describe.skipIf(noLiveTestPg)(
  'SMI-6114 -- record_private_registry_audit_attempt() / registry_audit_volume_over_threshold()',
  { timeout: 120_000 },
  () => {
    let ctl: PsqlSession

    const ctx: Ctx = {
      ctl: () => ctl,
      rebuild: async (migrationText, opts) => {
        const res = await ctl.send(baseSchemaSql() + '\n' + migrationText)
        if (opts?.expectSelfSmokeFailure) {
          expect(res.stderr, 'expected the migration to trip its own smoke block').toMatch(
            opts.expectSelfSmokeFailure
          )
        } else {
          expect(res.stderr, `schema+migration build failed:\n${res.stderr}`).not.toMatch(/ERROR/)
        }
        const fx = await ctl.send(fixtureSql())
        expect(fx.stderr, `fixture load failed:\n${fx.stderr}`).not.toMatch(/ERROR/)
      },
    }

    beforeAll(async () => {
      ctl = new PsqlSession(requireTestConn(), 'ctl')
      await ctl.send('\\set VERBOSITY verbose')
      await ctx.rebuild(migrationSql())
    }, 90_000)

    afterAll(async () => {
      await ctl?.close()
    })

    beforeEach(async () => {
      const fx = await ctl.send(fixtureSql())
      expect(fx.stderr, `fixture reload failed:\n${fx.stderr}`).not.toMatch(/ERROR/)
    })

    registerRpcTests(ctx)
    registerMonitorTests(ctx)
    registerRedTests(ctx)
  }
)
