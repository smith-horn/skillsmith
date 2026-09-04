/**
 * Roster-field visibility gating for the team members page.
 * @see ./team-invite-ui.ts
 *
 * SMI-6205 (Wave 4, adversarial review L12). `provisioned_via` and
 * `sso_verified_at` were rendered into every member's card for every viewer,
 * although the plan scoped both as ADMIN visibility: they say how a colleague
 * was provisioned and when their identity provider last authenticated them,
 * which is roster-audit information for whoever manages the team.
 *
 * Only the predicate is unit-tested here, not `renderMemberRow` itself: that
 * function's `escapeHtml` helper calls `document.createElement`, and this
 * package's vitest environment is `node` with no DOM available (and no jsdom
 * dependency to add one). The rendered output is covered by the Playwright
 * specs under tests/e2e/, which run in a real browser.
 */

import { describe, it, expect } from 'vitest'
import { canSeeProvisioning } from './team-invite-ui'

describe('canSeeProvisioning (SMI-6205 L12)', () => {
  it('shows provisioning metadata to owners and admins', () => {
    expect(canSeeProvisioning({ role: 'owner', userId: 'u1', canManageMembers: true })).toBe(true)
    expect(canSeeProvisioning({ role: 'admin', userId: 'u1', canManageMembers: true })).toBe(true)
  })

  it('hides it from ordinary members', () => {
    expect(canSeeProvisioning({ role: 'member', userId: 'u1', canManageMembers: false })).toBe(
      false
    )
  })

  it('draws the line in the same place as the other admin-only row controls', () => {
    // canRemove/canEditGithubUsername both gate on `owner || admin`. If those
    // ever move to a permission lookup, this must move with them rather than
    // silently diverging. canSeeProvisioning itself stays role-literal by
    // design (SMI-6241 Wave 3 does not touch it) — canManageMembers here just
    // satisfies the Viewer type and mirrors what a real caller in that role
    // would resolve from has_team_permission('team:manage_members').
    for (const role of ['owner', 'admin', 'member'] as const) {
      const viewerOnlyRoleMatters = canSeeProvisioning({
        role,
        userId: null,
        canManageMembers: role !== 'member',
      })
      expect(viewerOnlyRoleMatters).toBe(role !== 'member')
    }
  })
})
