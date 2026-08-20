/**
 * Pure formatting helpers for the private-registry dashboard.
 *
 * Supabase queries and mutations remain in registry.astro; this module
 * contains only logic that can be unit-tested without a browser or client.
 */

export type RegistryApprovalStatus = 'pending' | 'approved' | 'rejected'

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
