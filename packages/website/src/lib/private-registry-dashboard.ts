/**
 * Formatting helpers + Supabase data access for the private-registry
 * dashboard (registry.astro). Extracted so the read-path invariant and the
 * mutation calls can be unit-tested with a mocked client, the same way
 * team-access.test.ts mocks `.rpc()` (SMI-6087 plan, Wave 2 Step 2).
 *
 * READ-PATH INVARIANT (plan P-5): approved rows come from a plain RLS-scoped
 * select on private_registry_skills — the member_read policy only exposes
 * approval_status='approved' rows. Pending/rejected rows MUST come from the
 * get_private_registry_submissions RPC: a plain select silently returns zero
 * non-approved rows (even for admins), so swapping these paths would blank
 * the pending queue without any error.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type RegistryApprovalStatus = 'pending' | 'approved' | 'rejected'

export type RegistryReviewDecision = Extract<RegistryApprovalStatus, 'approved' | 'rejected'>

export interface PrivateRegistryDashboardRow {
  id?: string
  skill_id: string
  version: string
  description: string | null
  approval_status?: string
  approval_mode?: string
  deprecated?: boolean
  published_by: string
  published_at: string
  approved_by?: string | null
  approved_at?: string | null
  review_note?: string | null
}

export interface RegistrySkillGroup {
  skillId: string
  versions: PrivateRegistryDashboardRow[]
}

export interface RegistryBadge {
  label: string
  className: string
}

/**
 * Group flat registry rows by skill_id while preserving the input order of
 * both skill groups and versions.
 */
export function groupRegistryVersions(
  rows: readonly PrivateRegistryDashboardRow[]
): RegistrySkillGroup[] {
  const groups = new Map<string, PrivateRegistryDashboardRow[]>()

  for (const row of rows) {
    const versions = groups.get(row.skill_id)
    if (versions) {
      versions.push(row)
    } else {
      groups.set(row.skill_id, [row])
    }
  }

  return Array.from(groups, ([skillId, versions]) => ({
    skillId,
    versions,
  }))
}

/**
 * Deprecated state takes precedence over approval status for approved-list
 * versions so deprecated releases remain visually distinct.
 */
export function badgeForRegistryVersion(
  approvalStatus: string,
  deprecated: boolean
): RegistryBadge {
  if (deprecated) {
    return {
      label: 'Deprecated',
      className: 'status-deprecated',
    }
  }

  switch (approvalStatus.toLowerCase()) {
    case 'pending':
      return {
        label: 'Pending',
        className: 'status-pending',
      }
    case 'approved':
      return {
        label: 'Approved',
        className: 'status-approved',
      }
    case 'rejected':
      return {
        label: 'Rejected',
        className: 'status-rejected',
      }
    default:
      return {
        label: 'Unknown',
        className: 'status-unknown',
      }
  }
}

export interface RegistryDashboardData {
  namespace: string
  approved: PrivateRegistryDashboardRow[]
  pending: PrivateRegistryDashboardRow[]
  rejected: PrivateRegistryDashboardRow[]
}

/**
 * Load the four dashboard datasets in parallel.
 *
 * See the module-level READ-PATH INVARIANT: only the approved list may use a
 * plain select; the submissions helper's parameter type forbids routing
 * 'approved' through the RPC path and nothing else may query the table.
 */
export async function loadRegistryDashboardData(
  supabase: SupabaseClient,
  teamId: string
): Promise<RegistryDashboardData> {
  const submissions = (status: Exclude<RegistryApprovalStatus, 'approved'>) =>
    supabase.rpc('get_private_registry_submissions', {
      p_team_id: teamId,
      p_status: status,
    })

  const [namespaceRes, approvedRes, pendingRes, rejectedRes] = await Promise.all([
    supabase.from('teams').select('skill_namespace').eq('id', teamId).single(),
    supabase
      .from('private_registry_skills')
      .select('skill_id, version, description, deprecated, published_by, published_at')
      .eq('team_id', teamId)
      .eq('approval_status', 'approved')
      .order('skill_id')
      .order('version'),
    submissions('pending'),
    submissions('rejected'),
  ])

  if (namespaceRes.error) throw new Error(namespaceRes.error.message)
  if (approvedRes.error) throw new Error(approvedRes.error.message)
  if (pendingRes.error) throw new Error(pendingRes.error.message)
  if (rejectedRes.error) throw new Error(rejectedRes.error.message)

  const namespaceRow = namespaceRes.data as { skill_namespace?: string | null } | null

  return {
    namespace: String(namespaceRow?.skill_namespace ?? ''),
    approved: (approvedRes.data ?? []) as PrivateRegistryDashboardRow[],
    pending: (pendingRes.data ?? []) as PrivateRegistryDashboardRow[],
    rejected: (rejectedRes.data ?? []) as PrivateRegistryDashboardRow[],
  }
}

/**
 * Approve or reject a pending submission via the
 * review_private_registry_submission RPC. Admin/owner requirement and the
 * self-approval block are enforced server-side (SMI-5949 D-6) — this
 * function surfaces those refusals as thrown Errors.
 */
export async function reviewRegistrySubmission(
  supabase: SupabaseClient,
  teamId: string,
  skillId: string,
  version: string,
  decision: RegistryReviewDecision,
  note: string | null
): Promise<void> {
  const { error } = await supabase.rpc('review_private_registry_submission', {
    p_team_id: teamId,
    p_skill_id: skillId,
    p_version: version,
    p_decision: decision,
    p_note: note,
  })

  if (error) throw new Error(error.message)
}

/**
 * Toggle deprecation via a plain RLS-protected update (admin_update policy,
 * column-scoped GRANT UPDATE (deprecated)). The trailing .select() is
 * load-bearing: without it Supabase reports success with null data even when
 * RLS matched zero rows, so a non-admin (or a stale row) would look like a
 * successful update.
 */
export async function setRegistryVersionDeprecated(
  supabase: SupabaseClient,
  teamId: string,
  skillId: string,
  version: string,
  deprecated: boolean
): Promise<void> {
  const { data, error } = await supabase
    .from('private_registry_skills')
    .update({ deprecated })
    .eq('team_id', teamId)
    .eq('skill_id', skillId)
    .eq('version', version)
    .select()

  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('The skill version could not be updated.')
  }
}
