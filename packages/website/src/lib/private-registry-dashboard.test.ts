import { describe, expect, it } from 'vitest'
import {
  badgeForRegistryVersion,
  groupRegistryVersions,
  type PrivateRegistryDashboardRow,
} from './private-registry-dashboard'

function registryRow(
  skillId: string,
  version: string,
  overrides: Partial<PrivateRegistryDashboardRow> = {}
): PrivateRegistryDashboardRow {
  return {
    skill_id: skillId,
    version,
    description: null,
    approval_status: 'approved',
    deprecated: false,
    published_by: '00000000-0000-0000-0000-000000000001',
    published_at: '2026-08-19T12:00:00.000Z',
    ...overrides,
  }
}

describe('groupRegistryVersions', () => {
  it('groups multiple versions of the same skill together', () => {
    const rows = [
      registryRow('acme/code-review', '1.0.0'),
      registryRow('acme/code-review', '1.1.0'),
      registryRow('acme/release-notes', '2.0.0'),
    ]

    expect(groupRegistryVersions(rows)).toEqual([
      {
        skillId: 'acme/code-review',
        versions: [rows[0], rows[1]],
      },
      {
        skillId: 'acme/release-notes',
        versions: [rows[2]],
      },
    ])
  })

  it('returns an empty list for no registry rows', () => {
    expect(groupRegistryVersions([])).toEqual([])
  })
})

describe('badgeForRegistryVersion', () => {
  it('badges a deprecated approved version distinctly from a non-deprecated one', () => {
    expect(badgeForRegistryVersion('approved', false)).toEqual({
      label: 'Approved',
      className: 'status-approved',
    })
    expect(badgeForRegistryVersion('approved', true)).toEqual({
      label: 'Deprecated',
      className: 'status-deprecated',
    })
  })

  it.each([
    ['pending', 'Pending', 'status-pending'],
    ['approved', 'Approved', 'status-approved'],
    ['rejected', 'Rejected', 'status-rejected'],
  ])('maps %s to the expected badge', (status, label, className) => {
    expect(badgeForRegistryVersion(status, false)).toEqual({
      label,
      className,
    })
  })
})
