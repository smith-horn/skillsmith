/**
 * SMI-5151: human-readable Team Dashboard activity feed.
 *
 * Pure formatters for the Overview "Recent Activity" panel. Maps raw `audit_logs`
 * rows (actor UUID or the literal `authenticated_user`, snake_case action,
 * `resource/uuid`) into plain-English sentences with relative timestamps and no
 * raw UUIDs. Returns plain text — the caller (`index.astro`) is responsible for
 * HTML-escaping every field before inserting into the DOM.
 */

export interface ActivityEvent {
  event_type: string | null
  actor: string | null
  action: string | null
  resource: string | null
  timestamp: string
  metadata: Record<string, unknown> | null
}

export interface FormattedActivity {
  /** Plain-English line. NOT escaped — the caller must escape before DOM insertion. */
  text: string
  /** Absolute timestamp for the `title=` tooltip. NOT escaped. */
  iso: string
  /** Short relative string, e.g. "5 min ago". NOT escaped. */
  relative: string
}

/** The literal actor edge functions write when acting on behalf of a user. */
const LITERAL_SYSTEM_ACTOR = 'authenticated_user'
/** Shown when an actor UUID can't be resolved (e.g. a since-removed member). */
const FALLBACK_ACTOR = 'A team member'

/**
 * Resolve an audit actor to a display name, or `null` for the system/passive
 * actor. Branch order is significant (plan-review #2): the `authenticated_user`
 * literal is handled before the UUID lookup so an unknown UUID never falls into
 * the passive branch — it resolves to {@link FALLBACK_ACTOR} instead.
 */
function resolveActor(actor: string | null, nameMap: Map<string, string>): string | null {
  if (!actor || actor === LITERAL_SYSTEM_ACTOR) return null
  return nameMap.get(actor) ?? FALLBACK_ACTOR
}

/**
 * `" (role)"` only when the row's metadata actually carries a string `role`
 * (plan-review #1) — `:revoked`/`:removed` carry none, so this never renders
 * `(undefined)`/`()`.
 */
function roleSuffix(metadata: Record<string, unknown> | null): string {
  const role = metadata && typeof metadata.role === 'string' ? metadata.role.trim() : ''
  return role ? ` (${role})` : ''
}

/** De-snake an action verb for the unknown-event fallback ('send_email' → 'send email'). */
function humanizeAction(action: string | null): string {
  const cleaned = (action ?? '').replace(/_/g, ' ').trim()
  return cleaned || 'updated team activity'
}

/** `"{who} {activeTail}"` when an actor is known, else the passive form. */
function withActor(who: string | null, activeTail: string, passive: string): string {
  return who ? `${who} ${activeTail}` : passive
}

/**
 * Format a past timestamp as a short relative string ("just now", "5 min ago",
 * "3 hr ago", "2 days ago"); falls back to an absolute date past ~7 days.
 * Mirrors `team-invitations.ts:formatRelativeExpiry` but for the past direction.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const sec = Math.floor((now.getTime() - then) / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const days = Math.floor(hr / 24)
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Build the plain-English sentence for one event. Never includes the raw resource/UUID. */
function buildSentence(ev: ActivityEvent, who: string | null): string {
  switch (ev.event_type) {
    case 'team_invitation:created':
      return withActor(
        who,
        `created an invitation${roleSuffix(ev.metadata)}`,
        'An invitation was created'
      )
    case 'team_invitation:email_sent':
      return 'An invitation email was sent'
    case 'team_invitation:accepted':
      return withActor(who, 'accepted their invitation', 'An invitation was accepted')
    case 'team_invitation:revoked':
      return withActor(who, 'revoked an invitation', 'An invitation was revoked')
    case 'team_member:removed':
      return withActor(who, 'removed a member', 'A member was removed')
    default: {
      const verb = humanizeAction(ev.action)
      return withActor(who, verb, `Team activity: ${verb}`)
    }
  }
}

/**
 * Turn one `audit_logs` row into a human-readable activity line. Returns plain
 * text — the caller must HTML-escape `text`, `iso`, and `relative` before
 * inserting into the DOM.
 */
export function humanizeActivity(
  ev: ActivityEvent,
  nameMap: Map<string, string>
): FormattedActivity {
  const who = resolveActor(ev.actor, nameMap)
  const parsed = new Date(ev.timestamp)
  const iso = Number.isNaN(parsed.getTime()) ? ev.timestamp : parsed.toLocaleString()
  return {
    text: buildSentence(ev, who),
    iso,
    relative: formatRelativeTime(ev.timestamp),
  }
}
