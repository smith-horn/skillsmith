import { describe, expect, it } from 'vitest'
import { formatRelativeTime, humanizeActivity, type ActivityEvent } from './team-activity-format'

const RYAN = '7cf4c4a8-e0cb-4168-9e4d-c45a56cadfcf'
const TONY = 'a11828aa-4d3a-4820-87fc-2c9949afb9f7'
const INVITE_UUID = 'dc352e77-393a-431e-a545-fee30f182068'

const nameMap = new Map<string, string>([
  [RYAN, 'Ryan Smith'],
  [TONY, 'Tony Lee'],
])

function ev(partial: Partial<ActivityEvent>): ActivityEvent {
  return {
    event_type: null,
    actor: null,
    action: null,
    resource: null,
    timestamp: '2026-05-23T08:36:21.000Z',
    metadata: null,
    ...partial,
  }
}

describe('formatRelativeTime', () => {
  const now = new Date('2026-05-23T12:00:00.000Z')

  it('renders "just now" under 45s', () => {
    expect(formatRelativeTime('2026-05-23T11:59:30.000Z', now)).toBe('just now')
  })

  it('renders minutes', () => {
    expect(formatRelativeTime('2026-05-23T11:55:00.000Z', now)).toBe('5 min ago')
  })

  it('renders hours', () => {
    expect(formatRelativeTime('2026-05-23T09:00:00.000Z', now)).toBe('3 hr ago')
  })

  it('renders days with singular/plural', () => {
    expect(formatRelativeTime('2026-05-22T12:00:00.000Z', now)).toBe('1 day ago')
    expect(formatRelativeTime('2026-05-20T12:00:00.000Z', now)).toBe('3 days ago')
  })

  it('falls back to an absolute date past ~7 days', () => {
    const out = formatRelativeTime('2026-05-01T12:00:00.000Z', now)
    expect(out).not.toMatch(/ago/)
    expect(out).toMatch(/2026/)
  })

  it('returns empty string for an invalid timestamp', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('')
  })
})

describe('humanizeActivity — actor resolution (three branches)', () => {
  it('literal authenticated_user → passive voice (no actor name)', () => {
    const out = humanizeActivity(
      ev({ event_type: 'team_invitation:email_sent', actor: 'authenticated_user' }),
      nameMap
    )
    expect(out.text).toBe('An invitation email was sent')
  })

  it('actor UUID present in nameMap → display name', () => {
    const out = humanizeActivity(
      ev({ event_type: 'team_invitation:revoked', actor: RYAN }),
      nameMap
    )
    expect(out.text).toBe('Ryan Smith revoked an invitation')
  })

  it('actor UUID absent from nameMap (removed member) → "A team member", never passive', () => {
    const out = humanizeActivity(
      ev({ event_type: 'team_invitation:revoked', actor: 'unknown-uuid-xyz' }),
      nameMap
    )
    expect(out.text).toBe('A team member revoked an invitation')
  })
})

describe('humanizeActivity — sentence by event_type', () => {
  it('created shows the role suffix from metadata', () => {
    const out = humanizeActivity(
      ev({
        event_type: 'team_invitation:created',
        actor: RYAN,
        metadata: { role: 'member', team_id: 't1' },
      }),
      nameMap
    )
    expect(out.text).toBe('Ryan Smith created an invitation (member)')
  })

  it('accepted reads naturally without a role suffix', () => {
    const out = humanizeActivity(
      ev({ event_type: 'team_invitation:accepted', actor: TONY, metadata: { role: 'member' } }),
      nameMap
    )
    expect(out.text).toBe('Tony Lee accepted their invitation')
  })

  it('revoked never renders an empty/undefined role parenthetical', () => {
    const out = humanizeActivity(
      ev({ event_type: 'team_invitation:revoked', actor: RYAN, metadata: { team_id: 't1' } }),
      nameMap
    )
    expect(out.text).toBe('Ryan Smith revoked an invitation')
    expect(out.text).not.toMatch(/\(\s*\)|undefined/)
  })

  it('removed stays generic (does not resolve the removed member)', () => {
    const out = humanizeActivity(
      ev({
        event_type: 'team_member:removed',
        actor: RYAN,
        metadata: { team_id: 't1', removed_member_id: 'tm_tony' },
      }),
      nameMap
    )
    expect(out.text).toBe('Ryan Smith removed a member')
    expect(out.text).not.toContain('tm_tony')
  })

  it('unknown event_type falls back to a de-snaked action verb', () => {
    const out = humanizeActivity(
      ev({ event_type: 'something:weird', actor: RYAN, action: 'refresh_metadata' }),
      nameMap
    )
    expect(out.text).toBe('Ryan Smith refresh metadata')
  })

  it('created with an empty nameMap → passive fallback name', () => {
    const out = humanizeActivity(
      ev({ event_type: 'team_invitation:created', actor: RYAN, metadata: { role: 'admin' } }),
      new Map()
    )
    expect(out.text).toBe('A team member created an invitation (admin)')
  })
})

describe('humanizeActivity — never leaks raw identifiers', () => {
  it('omits the resource UUID for every event_type', () => {
    const eventTypes = [
      'team_invitation:created',
      'team_invitation:email_sent',
      'team_invitation:accepted',
      'team_invitation:revoked',
      'team_member:removed',
      'unknown:event',
    ]
    for (const event_type of eventTypes) {
      const out = humanizeActivity(
        ev({
          event_type,
          actor: RYAN,
          resource: `team_invitations/${INVITE_UUID}`,
          action: 'create',
        }),
        nameMap
      )
      expect(out.text).not.toContain(INVITE_UUID)
      expect(out.text).not.toContain('team_invitations/')
      expect(out.text).not.toContain(RYAN)
    }
  })
})
