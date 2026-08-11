/**
 * @fileoverview Tests for private_registry_manage's submissions/approve/reject actions
 * (stub-service path) -- split out of registry-tools.test.ts (SMI-5949 Wave 3) to stay under
 * the 500-line pre-commit file-length gate.
 * @see SMI-5949: Approval Gate -- Submitter/Approver Role Split for `private_registry_publish`
 *
 * These exercise the handlers against the in-memory stub (no Supabase configured). Live
 * Supabase-backed behaviour is in registry-tools.live.review-decision.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  executePrivateRegistryPublish,
  executePrivateRegistryManage,
  createStubRegistryService,
  setPrivateRegistryService,
  type StubRegistryService,
} from './registry-tools.js'

const mockContext = {} as ToolContext

const SAMPLE_CONTENT = { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' }

/** A simulated admin identity distinct from the stub's `DEFAULT_ACTOR` publisher (SMI-5949 Wave 2
 *  Step 5) -- approving/rejecting requires a different, admin caller (D-6 blocks self-approval),
 *  so every test below that needs a published skill to become visible via list()/get() approves
 *  it under this identity first. */
const ADMIN_ACTOR = { id: 'stub-admin-reviewer', isAdmin: true }

let service: StubRegistryService

beforeEach(() => {
  // Reset to fresh stub service before each test
  service = createStubRegistryService()
  setPrivateRegistryService(service)
})

/** Approves the given skill@version as a distinct admin identity (never the publisher -- D-6),
 *  so list()/get() (approved-only, SMI-5949 D-4) can see it afterward. */
async function approve(skillId: string, version: string): Promise<void> {
  service.setActor(ADMIN_ACTOR)
  const result = await executePrivateRegistryManage(
    { action: 'approve', skillId, version },
    mockContext
  )
  if (!result.success)
    throw new Error(`Test setup: approve(${skillId}@${version}) failed: ${result.error}`)
}

describe('private_registry_manage submissions/approve/reject — stub state machine', () => {
  it('lists a pending submission under "submissions" but not under "list"', async () => {
    await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      mockContext
    )

    const listResult = await executePrivateRegistryManage({ action: 'list' }, mockContext)
    expect(listResult.skills).toHaveLength(0)

    const submissionsResult = await executePrivateRegistryManage(
      { action: 'submissions' },
      mockContext
    )
    expect(submissionsResult.success).toBe(true)
    expect(submissionsResult.submissions).toHaveLength(1)
    expect(submissionsResult.submissions![0].approvalStatus).toBe('pending')
  })

  it('approve succeeds under a distinct admin and the skill becomes list()-visible', async () => {
    await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      mockContext
    )
    await approve('myteam/skill-a', '1.0.0')

    const listResult = await executePrivateRegistryManage({ action: 'list' }, mockContext)
    expect(listResult.skills).toHaveLength(1)
    expect(listResult.skills![0].approvalStatus).toBe('approved')
  })

  it('reject succeeds and the skill stays permanently invisible (D-8)', async () => {
    await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      mockContext
    )
    service.setActor(ADMIN_ACTOR)
    const result = await executePrivateRegistryManage(
      { action: 'reject', skillId: 'myteam/skill-a', version: '1.0.0' },
      mockContext
    )
    expect(result.success).toBe(true)
    expect(result.review?.approvalStatus).toBe('rejected')

    const listResult = await executePrivateRegistryManage({ action: 'list' }, mockContext)
    expect(listResult.skills).toHaveLength(0)
  })

  it('blocks self-approval even when the submitter is also an admin (D-5 step 7 / D-6)', async () => {
    // The publisher is the DEFAULT stub actor, which is admin — mirrors the smoke matrix's own
    // requirement that a self-approval test's actor hold admin/owner, so the RPC's admin check
    // (step 3) is genuinely passed and the self-approval check (step 7) is what actually fires.
    await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      mockContext
    )

    const result = await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/own submission/i)
  })

  it('blocks a non-admin reviewer (D-5 step 3, before self-approval would even be checked)', async () => {
    await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      mockContext
    )
    service.setActor({ id: 'stub-non-admin-member', isAdmin: false })

    const result = await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not an admin/i)
  })

  it('blocks re-review of an already-decided submission (D-5 step 5 / D-8 terminal state)', async () => {
    await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      mockContext
    )
    await approve('myteam/skill-a', '1.0.0')

    const result = await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already been approved/i)
  })
})
