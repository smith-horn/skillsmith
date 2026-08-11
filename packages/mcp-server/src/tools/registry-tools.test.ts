/**
 * @fileoverview Tests for private registry MCP tools (stub-service path)
 * @see SMI-3902: Private Registry MCP Tools
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 *
 * These exercise the handlers against the in-memory stub (no Supabase configured).
 * Live Supabase-backed behaviour (cross-team scoping, immutability, size cap) is in
 * registry-tools.live.test.ts; RLS policy structure is in
 * scripts/tests/private-registry-rls.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  privateRegistryPublishInputSchema,
  privateRegistryManageInputSchema,
  executePrivateRegistryPublish,
  executePrivateRegistryManage,
  createStubRegistryService,
  setPrivateRegistryService,
  type PrivateRegistryPublishInput,
  type PrivateRegistryManageInput,
  type StubRegistryService,
} from './registry-tools.js'

const mockContext = {} as ToolContext

const SAMPLE_CONTENT = { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' }

/** A simulated admin identity distinct from the stub's `DEFAULT_ACTOR` publisher (SMI-5949 Wave 2
 *  Step 5) — approving/rejecting requires a different, admin caller (D-6 blocks self-approval),
 *  so every test below that needs a published skill to become visible via list()/get() approves
 *  it under this identity first. */
const ADMIN_ACTOR = { id: 'stub-admin-reviewer', isAdmin: true }

describe('registry-tools', () => {
  let service: StubRegistryService

  beforeEach(() => {
    // Reset to fresh stub service before each test
    service = createStubRegistryService()
    setPrivateRegistryService(service)
  })

  /** Approves the given skill@version as a distinct admin identity (never the publisher — D-6),
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

  // ==========================================================================
  // Schema validation
  // ==========================================================================

  describe('privateRegistryPublishInputSchema', () => {
    it('should accept valid publish input with content', () => {
      const input = { skillId: 'myteam/my-skill', version: '1.0.0', content: SAMPLE_CONTENT }
      const parsed = privateRegistryPublishInputSchema.parse(input)
      expect(parsed.skillId).toBe('myteam/my-skill')
      expect(parsed.version).toBe('1.0.0')
      expect(parsed.content['SKILL.md']).toContain('My Skill')
    })

    it('should accept publish input with description and multi-file content', () => {
      const input = {
        skillId: 'myteam/my-skill',
        version: '1.0.0',
        description: 'A useful skill',
        content: { 'SKILL.md': '# S', 'scripts/run.sh': 'echo hi' },
      }
      const parsed = privateRegistryPublishInputSchema.parse(input)
      expect(parsed.description).toBe('A useful skill')
      expect(Object.keys(parsed.content)).toHaveLength(2)
    })

    it('should reject missing content', () => {
      expect(() =>
        privateRegistryPublishInputSchema.parse({ skillId: 'myteam/my-skill', version: '1.0.0' })
      ).toThrow()
    })

    it('should reject invalid skill ID format', () => {
      expect(() =>
        privateRegistryPublishInputSchema.parse({
          skillId: 'no-slash',
          version: '1.0.0',
          content: SAMPLE_CONTENT,
        })
      ).toThrow()
    })

    it('should reject invalid semver', () => {
      expect(() =>
        privateRegistryPublishInputSchema.parse({
          skillId: 'myteam/my-skill',
          version: 'not-semver',
          content: SAMPLE_CONTENT,
        })
      ).toThrow()
    })

    // SMI-5905 Sol final-code-review finding #1: the bare author/name regex accepts "."/".."
    // as either segment, which installFromContent() would otherwise turn into a path escape.
    it.each(['myteam/..', 'myteam/.', '../myteam', 'myteam/   '])(
      'should reject skillId "%s" (unsafe path segment)',
      (skillId) => {
        expect(() =>
          privateRegistryPublishInputSchema.parse({
            skillId,
            version: '1.0.0',
            content: SAMPLE_CONTENT,
          })
        ).toThrow()
      }
    )
  })

  describe('privateRegistryManageInputSchema', () => {
    it('should accept list action', () => {
      const parsed = privateRegistryManageInputSchema.parse({ action: 'list' })
      expect(parsed.action).toBe('list')
    })

    it('should accept get action with skillId', () => {
      const parsed = privateRegistryManageInputSchema.parse({
        action: 'get',
        skillId: 'myteam/my-skill',
      })
      expect(parsed.action).toBe('get')
      expect(parsed.skillId).toBe('myteam/my-skill')
    })

    it('should reject invalid action', () => {
      expect(() => privateRegistryManageInputSchema.parse({ action: 'invalid' })).toThrow()
    })

    it('should accept namespace action (SMI-5852, AC-11)', () => {
      const parsed = privateRegistryManageInputSchema.parse({ action: 'namespace' })
      expect(parsed.action).toBe('namespace')
    })

    it('should accept optional version filter', () => {
      const parsed = privateRegistryManageInputSchema.parse({
        action: 'list',
        version: '1.0.0',
      })
      expect(parsed.version).toBe('1.0.0')
    })

    // SMI-5905 Sol final-code-review finding #1 — same fix as the publish schema above,
    // applied here too since "install" derives its on-disk path from this skillId.
    it.each(['myteam/..', 'myteam/.', '../myteam'])(
      'should reject skillId "%s" (unsafe path segment) for the install action',
      (skillId) => {
        expect(() =>
          privateRegistryManageInputSchema.parse({ action: 'install', skillId })
        ).toThrow()
      }
    )
  })

  // ==========================================================================
  // private_registry_publish handler
  // ==========================================================================

  describe('executePrivateRegistryPublish', () => {
    it('should publish a skill', async () => {
      const input: PrivateRegistryPublishInput = {
        skillId: 'myteam/my-skill',
        version: '1.0.0',
        content: SAMPLE_CONTENT,
      }
      const result = await executePrivateRegistryPublish(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.skill).toBeDefined()
      expect(result.skill!.skillId).toBe('myteam/my-skill')
      expect(result.skill!.version).toBe('1.0.0')
      expect(result.skill!.deprecated).toBe(false)
      expect(result.skill!.registryUrl).toContain('myteam/my-skill@1.0.0')
      // SMI-5949 Wave 2 Step 5: the stub now models the approval gate — every publish lands
      // pending/review (D-7's unconditional default), never auto-approved. The message reflects
      // that (M9: "submitted for review", never presenting a Registry URL as live).
      expect(result.message).toContain('Submitted')
      expect(result.message).not.toContain('Registry URL')
      expect(result.skill!.approvalStatus).toBe('pending')
      expect(result.skill!.approvalMode).toBe('review')
    })

    it('should publish a skill with description', async () => {
      const input: PrivateRegistryPublishInput = {
        skillId: 'myteam/my-skill',
        version: '1.0.0',
        content: SAMPLE_CONTENT,
        description: 'A skill for testing',
      }
      const result = await executePrivateRegistryPublish(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.skill!.description).toBe('A skill for testing')
    })
  })

  // ==========================================================================
  // private_registry_manage handler
  // ==========================================================================

  describe('executePrivateRegistryManage', () => {
    it('should list empty registry', async () => {
      const input: PrivateRegistryManageInput = { action: 'list' }
      const result = await executePrivateRegistryManage(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.skills).toHaveLength(0)
      expect(result.message).toContain('0 skill(s)')
    })

    it('should not list a freshly published (still-pending) skill — SMI-5949 D-4', async () => {
      await executePrivateRegistryPublish(
        { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
        mockContext
      )

      const result = await executePrivateRegistryManage({ action: 'list' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.skills).toHaveLength(0)
    })

    it('should list published skills once approved', async () => {
      // Publish a skill first, then approve it — list()/get() are approved-only (SMI-5949 D-4).
      await executePrivateRegistryPublish(
        { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
        mockContext
      )
      await approve('myteam/skill-a', '1.0.0')

      const result = await executePrivateRegistryManage({ action: 'list' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.skills).toHaveLength(1)
      expect(result.skills![0].skillId).toBe('myteam/skill-a')
      expect(result.skills![0].approvalStatus).toBe('approved')
    })

    it('should get a specific skill once approved', async () => {
      await executePrivateRegistryPublish(
        { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
        mockContext
      )
      await approve('myteam/skill-a', '1.0.0')

      const result = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/skill-a' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.skill).toBeDefined()
      expect(result.skill!.skillId).toBe('myteam/skill-a')
    })

    it('should fail get for a still-pending skill with the same non-leaking hint (SMI-5949 D-4/M11)', async () => {
      await executePrivateRegistryPublish(
        { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
        mockContext
      )

      const result = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/skill-a' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/check with a team admin/i)
    })

    it('should fail get without skillId', async () => {
      const result = await executePrivateRegistryManage({ action: 'get' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('skillId is required')
    })

    it('should fail get for nonexistent skill, with a generic non-leaking hint (SMI-5949 M11)', async () => {
      const result = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/nonexistent' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
      // The hint is always-shown and generic — it must never confirm or deny that an
      // unapproved (pending/rejected) version specifically exists.
      expect(result.error).toMatch(/check with a team admin/i)
    })

    it('should deprecate a skill', async () => {
      await executePrivateRegistryPublish(
        { skillId: 'myteam/old-skill', version: '1.0.0', content: SAMPLE_CONTENT },
        mockContext
      )
      // deprecate() itself is not approval-gated (D-4 only gates list()/get()/submissions()), but
      // the get() verification below is — approve first so the row is visible to check.
      await approve('myteam/old-skill', '1.0.0')

      const result = await executePrivateRegistryManage(
        { action: 'deprecate', skillId: 'myteam/old-skill' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('deprecated')

      // Verify it's marked deprecated
      const getResult = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/old-skill' },
        mockContext
      )
      expect(getResult.skill!.deprecated).toBe(true)
    })

    it('should fail deprecate without skillId', async () => {
      const result = await executePrivateRegistryManage({ action: 'deprecate' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('skillId is required')
    })

    it('should fail deprecate for nonexistent skill', async () => {
      const result = await executePrivateRegistryManage(
        { action: 'deprecate', skillId: 'myteam/nonexistent' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should undeprecate a skill', async () => {
      await executePrivateRegistryPublish(
        { skillId: 'myteam/revived', version: '2.0.0', content: SAMPLE_CONTENT },
        mockContext
      )
      // Same reason as "should deprecate a skill" above — approve first so get() (approval-gated,
      // D-4) can see the row afterward.
      await approve('myteam/revived', '2.0.0')
      await executePrivateRegistryManage(
        { action: 'deprecate', skillId: 'myteam/revived' },
        mockContext
      )

      const result = await executePrivateRegistryManage(
        { action: 'undeprecate', skillId: 'myteam/revived' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('undeprecated')

      // Verify it's no longer deprecated
      const getResult = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/revived' },
        mockContext
      )
      expect(getResult.skill!.deprecated).toBe(false)
    })

    it('should fail undeprecate without skillId', async () => {
      const result = await executePrivateRegistryManage({ action: 'undeprecate' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('skillId is required')
    })

    // SMI-5852 AC-11: the stub has no real `teams` table, so it always reports the
    // namespace as unresolvable — a deliberate, documented limitation (see
    // registry-tools.stub.ts), not a stub bug. Live behavior is covered in
    // registry-tools.live.test.ts.
    it('should report the namespace as unresolvable against the stub', async () => {
      const result = await executePrivateRegistryManage({ action: 'namespace' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/unable to resolve/i)
    })
  })

  // ==========================================================================
  // submissions / approve / reject — SMI-5949 Wave 2 Step 5 stub state machine
  // ==========================================================================

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
})
