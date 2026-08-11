/**
 * @fileoverview SMI-5949 Wave 2 Step 5 (plan-review finding M7) — stub/live review-gate error
 * PARITY between the two `PrivateRegistryService` implementations.
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * Split out of `registry-tools.cross-transport.test.ts` (SMI-5949 adversarial-review pass): that
 * file's own H-1 fix needed an `approve()` fixture helper that pushed it over the 500-line
 * audit:standards budget, and this block was already testing a genuinely different concern from
 * the rest of that file — it exercises `PrivateRegistryService.review()` DIRECTLY on a stub
 * instance and a live instance (fake-client-backed), bypassing the tool dispatcher entirely, to
 * prove stub/live REVIEW-GATE ERROR parity. That is unrelated to the sibling file's own subject
 * (install-round-trip parity between the MCP and CLI transports).
 *
 * The requirement (M7) is error TYPE and ORDER parity: both transports must fail at the SAME
 * conceptual D-5 check for the same scenario, not merely "both throw". Each case below asserts the
 * expected pattern matches AND that the other three documented failure patterns do NOT — proving
 * the right check fired, not an accidental one. This is a SERVICE-level parity proof, not a
 * message-format proof — `registry-tools.live.review-decision.test.ts` already owns verbatim
 * passthrough of whatever the live RPC returns, and deliberately does NOT need its own fixture
 * text to match the real migration wording, since it tests generic passthrough behavior, not
 * fidelity to the RPC's actual text.
 *
 * @see SMI-5949 adversarial-review finding M-4: two of the four live-side fixture messages below
 * (`notAdmin`, `terminal`) were previously HAND-WRITTEN PARAPHRASES that did not match what
 * `review_private_registry_submission()` actually raises — verified directly against
 * `supabase/migrations/20260809000000_private_registry_approval_gate.sql` (the `notAdmin` RAISE
 * EXCEPTION at lines 539-543, the `terminal` one at lines 567-570) — despite the `liveRpcError()`
 * doc comment below claiming the fixture was "driven by the exact shape the RPC itself returns,
 * not a hand-rolled approximation". Both are now the migration's VERBATIM text (with its `%`
 * placeholder substituted for this file's own `REVIEW_TEAM`/row-status values); `selfApproval` and
 * `missingPublisher` already matched and are unchanged. `PARITY_PATTERNS.notAdmin` and `.terminal`
 * are updated to match, since the old regexes (`/not an admin|admins can/i` and `/already been
 * (approved|rejected)/i`) did not match the corrected verbatim live text either.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createStubRegistryService, type StubRegistryService } from './registry-tools.js'
import { createLiveRegistryService } from './registry-tools.live.js'
import { createFakeClient, mockBothClients } from './registry-tools.live.test-helpers.js'

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
  resolveUserAccessToken: vi.fn(async () => 'fake-user-access-token'),
}))

const REVIEW_TEAM = 'team-parity'
const REVIEW_SKILL = 'myteam/parity-skill'
const REVIEW_VERSION = '1.0.0'
const REVIEW_CONTENT = {
  'SKILL.md': '# Parity Skill\n\nUsed only by the review-gate parity tests.',
}

const PARITY_PATTERNS = {
  // Matches both the stub's "Only team admins can review private-registry submissions." and the
  // migration's real "only a team admin or owner may review private-registry submissions for
  // team %." — neither of the OLD paraphrased patterns (`not an admin`, `admins can`) matched the
  // real migration text (M-4).
  notAdmin: /review private-registry submissions/i,
  selfApproval: /own submission/i,
  // Matches both the stub's "already been approved" and the migration's real "already % -- an
  // approval decision is final" (M-4) — the old `/already been (approved|rejected)/i` pattern did
  // not match the real text, which never says "been".
  terminal: /already (been )?(approved|rejected)|approval decision is final/i,
  missingPublisher: /no recorded submitter|published_by.*NULL/i,
}

/** Asserts `err` matches exactly the ONE expected pattern among the four documented D-5 failure
 *  shapes — proving order, not just type: a hit on the wrong pattern means the wrong check fired. */
function expectOnlyPattern(message: string, expected: keyof typeof PARITY_PATTERNS): void {
  for (const [name, pattern] of Object.entries(PARITY_PATTERNS)) {
    if (name === expected) {
      expect(message).toMatch(pattern)
    } else {
      expect(message).not.toMatch(pattern)
    }
  }
}

/** Live-side RPC error fixture — same four scenarios registry-tools.live.review-decision.test.ts
 *  scripts, reused here so the live half of each parity case is driven by the exact shape the RPC
 *  itself returns, not a hand-rolled approximation (as of the M-4 fix, this is now actually true
 *  for all four — see this file's header). */
function liveRpcError(error: { code: string; message: string }) {
  return {
    rpcResponder: (fn: string) =>
      fn === 'review_private_registry_submission'
        ? { data: null, error }
        : { data: [], error: null },
  }
}

describe('stub/live review-gate error parity (SMI-5949 Wave 2 Step 5, M7)', () => {
  let stub: StubRegistryService

  beforeEach(() => {
    stub = createStubRegistryService()
  })

  it('not-admin: both transports fail at the admin-membership check (D-5 step 3)', async () => {
    const { client } = createFakeClient(
      liveRpcError({
        code: '42501',
        // Verbatim from migrations/20260809000000_private_registry_approval_gate.sql:539-543
        // (the concatenated PL/pgSQL string literal, `%` substituted for `p_team_id`).
        message:
          'only a team admin or owner may review private-registry submissions for team ' +
          'team-parity. If this team has exactly one admin and that admin is also the ' +
          'submitter, nothing can be approved until a second admin or owner exists -- promote ' +
          'one in team_members (self-approval is refused, see below).',
      })
    )
    await mockBothClients(client)
    const live = createLiveRegistryService()
    const liveErr = await live
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((liveErr as Error).message, 'notAdmin')

    await stub.publish(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, REVIEW_CONTENT)
    stub.setActor({ id: 'a-different-non-admin', isAdmin: false })
    const stubErr = await stub
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((stubErr as Error).message, 'notAdmin')
  })

  it('self-approval: both transports fail at self-approval, not the admin check (D-5 step 7 / D-6)', async () => {
    const { client } = createFakeClient(
      liveRpcError({
        code: 'P0001',
        message: 'You cannot approve your own submission. Ask another team admin to review it.',
      })
    )
    await mockBothClients(client)
    const live = createLiveRegistryService()
    const liveErr = await live
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((liveErr as Error).message, 'selfApproval')

    // The publisher must ALSO be admin here (mirrors the plan's smoke matrix, H3): otherwise the
    // admin check (step 3) fires first and this would prove the wrong thing.
    stub.setActor({ id: 'same-actor', isAdmin: true })
    await stub.publish(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, REVIEW_CONTENT)
    const stubErr = await stub
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((stubErr as Error).message, 'selfApproval')
  })

  it('already-decided: both transports fail at the terminal-state check (D-5 step 5 / D-8)', async () => {
    const { client } = createFakeClient(
      liveRpcError({
        code: '55000',
        // Verbatim from migrations/20260809000000_private_registry_approval_gate.sql:567-570
        // (`%` substituted for `v_row.approval_status`, i.e. 'approved' here).
        message:
          'this submission is already approved -- an approval decision is final. Versions are ' +
          'immutable (UNIQUE team_id, skill_id, version), so a rejected version cannot be ' +
          'resubmitted: publish a new version instead.',
      })
    )
    await mockBothClients(client)
    const live = createLiveRegistryService()
    const liveErr = await live
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((liveErr as Error).message, 'terminal')

    stub.setActor({ id: 'publisher', isAdmin: false })
    await stub.publish(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, REVIEW_CONTENT)
    stub.setActor({ id: 'admin-1', isAdmin: true })
    await stub.review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved') // succeeds once
    const stubErr = await stub
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((stubErr as Error).message, 'terminal')
  })

  it('missing published_by: both transports fail at the legacy-client check (D-5 step 6, D-7)', async () => {
    const { client } = createFakeClient(
      liveRpcError({
        code: '23514',
        message:
          'This submission has no recorded submitter (published_by is NULL) and cannot be ' +
          'reviewed — it was published by a client older than the required version. Ask the ' +
          'submitter to upgrade and re-publish.',
      })
    )
    await mockBothClients(client)
    const live = createLiveRegistryService()
    const liveErr = await live
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((liveErr as Error).message, 'missingPublisher')

    // Publish with a null identity — the only way a stub row can lack published_by (see
    // registry-tools.stub.ts's header for why publish() does not itself reject this, unlike the
    // real D-7 trigger).
    stub.setActor({ id: null, isAdmin: false })
    await stub.publish(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, REVIEW_CONTENT)
    stub.setActor({ id: 'admin-1', isAdmin: true })
    const stubErr = await stub
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((stubErr as Error).message, 'missingPublisher')
  })
})
