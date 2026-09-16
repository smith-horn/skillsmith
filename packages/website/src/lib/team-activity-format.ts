/**
 * SMI-5151: human-readable Team Dashboard activity feed.
 *
 * Pure formatters for the Overview "Recent Activity" panel. Maps raw `audit_logs`
 * rows (actor UUID or the literal `authenticated_user`, snake_case action,
 * `resource/uuid`) into plain-English sentences with relative timestamps and no
 * raw UUIDs. Returns plain text — the caller (`index.astro`) is responsible for
 * HTML-escaping every field before inserting into the DOM.
 *
 * SMI-6114: private-registry rows (`private_registry:*`) name the skill version
 * (`namespace/skill@version`, from metadata — never the resource path or a UUID)
 * and read their `result`, since client-side rows record refused attempts too.
 * Only member-visible registry rows reach this feed: the trigger omits
 * `metadata.team_id` from events about pending or rejected versions, and the
 * feed's query filters on that key.
 */

export interface ActivityEvent {
  event_type: string | null
  actor: string | null
  action: string | null
  resource: string | null
  /** `success` / `denied` / `not_found` / `error`; absent on rows selected without it. */
  result?: string | null
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
 * Actor prefixes that name a credential or database session, never a person
 * (SMI-6114 trigger: `jwt_role:service_role`, `db_session:postgres`; legacy MCP
 * rows: `license_key:<fingerprint>`). Rendered passively, not as "A team member".
 */
const SYSTEM_ACTOR_PREFIXES = ['jwt_role:', 'db_session:', 'license_key:']
/** Prefix the registry writers put before a user id (`user:<uuid>`). */
const USER_ACTOR_PREFIX = 'user:'

/**
 * Resolve an audit actor to a display name, or `null` for the system/passive
 * actor. Branch order is significant (plan-review #2): the `authenticated_user`
 * literal and the system prefixes are handled before the UUID lookup so an
 * unknown UUID never falls into the passive branch — it resolves to
 * {@link FALLBACK_ACTOR} instead. `user:<uuid>` is looked up by its uuid.
 */
function resolveActor(actor: string | null, nameMap: Map<string, string>): string | null {
  if (!actor || actor === LITERAL_SYSTEM_ACTOR || actor === 'anonymous') return null
  if (SYSTEM_ACTOR_PREFIXES.some((prefix) => actor.startsWith(prefix))) return null
  const userId = actor.startsWith(USER_ACTOR_PREFIX) ? actor.slice(USER_ACTOR_PREFIX.length) : actor
  return nameMap.get(userId) ?? FALLBACK_ACTOR
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

/** Active verb for a successful registry event, and the bare verb for an attempt. */
const REGISTRY_VERBS: Record<string, { done: string; attempt: string }> = {
  publish: { done: 'submitted', attempt: 'submit' },
  approve: { done: 'approved', attempt: 'approve' },
  reject: { done: 'rejected', attempt: 'reject' },
  deprecate: { done: 'deprecated', attempt: 'deprecate' },
  undeprecate: { done: 'undeprecated', attempt: 'undeprecate' },
  update: { done: 'changed', attempt: 'change' },
  delete: { done: 'deleted', attempt: 'delete' },
  content_read: { done: 'downloaded', attempt: 'download' },
}

/**
 * `ATTEMPT_OUTCOMES` is this renderer's own vocabulary for a non-success registry result -- it is
 * not, and cannot be, machine-checked against what a writer can actually produce. Four writers
 * emit `private_registry:*` audit_logs rows and no single one of them is authoritative over the
 * full result vocabulary: two in TypeScript (`registry-tools.live.audit.ts`'s
 * `RegistryReadAuditEvent`/`RegistryMutationAuditEvent`, and `private-registry-get/access.ts`'s
 * `AuditResult`) and two in SQL (the audit trigger and the content-release RPC migrations) --
 * a prior version of this map was checked at runtime against only the two TypeScript writers,
 * which asserted a completeness it never actually had, since the RPC migration's own `'denied'`
 * and `'not_found'` writes were invisible to that check the whole time it existed (PR #2860 gate).
 * What actually keeps this map safe is `registrySentence()`'s own fallback: any `result` this map
 * doesn't recognise -- a new writer, a new outcome, a typo -- renders as `'did not complete'`
 * rather than crashing or ever reading as success. Add a writer's new outcome here for a better
 * sentence; the fallback is what makes leaving one out safe rather than silently wrong.
 *
 * No registry writer emits `result: 'failure'`; the one function that does, `handleTeamInviteSend`
 * (`supabase/functions/team-invite-send/index.ts`), is a different event shape
 * (`team_invitation:email_sent`) that renders its own two-branch sentence in the `email_sent` arm
 * below instead of going through this map -- the registry's denied/not_found/error taxonomy
 * doesn't meaningfully apply to an email send, so reusing this map there would be accidental
 * coupling between two unrelated event shapes, not a design improvement.
 */
const ATTEMPT_OUTCOMES: Record<string, string> = {
  denied: 'was refused',
  not_found: 'matched nothing',
  error: 'failed',
}

/**
 * Own keys only: an empty string or a prototype name such as `constructor` must fall through, not
 * index the prototype chain. A user-defined type guard (rather than an inline `hasOwnProperty`
 * check) so the exact-key `ATTEMPT_OUTCOMES` type above narrows `result` for the lookup below —
 * `Record<string, string>` allowed any string index; the tightened type needs one.
 */
function isAttemptOutcomeKey(value: string): value is keyof typeof ATTEMPT_OUTCOMES {
  return Object.prototype.hasOwnProperty.call(ATTEMPT_OUTCOMES, value)
}

/** `private skill ns/skill@1.0.0`, or `a private skill` when metadata does not name one. */
function registrySubject(metadata: Record<string, unknown> | null): string {
  const skill = metadata && typeof metadata.skill_id === 'string' ? metadata.skill_id : ''
  if (!skill) return 'a private skill'
  const version = metadata && typeof metadata.version === 'string' ? metadata.version : ''
  return `private skill ${skill}${version ? `@${version}` : ''}`
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Sentence for a `private_registry:*` row (SMI-6114). */
function registrySentence(ev: ActivityEvent, who: string | null, operation: string): string {
  if (operation === 'truncate') return 'The private registry was cleared'
  const verbs = REGISTRY_VERBS[operation]
  if (!verbs)
    return withActor(who, 'viewed the private registry', 'The private registry was viewed')
  const subject = registrySubject(ev.metadata)
  // A missing `result` (e.g. the select ever drops the column) must never read as success — fall
  // through to the attempt/outcome branch below, whose `?? 'did not complete'` default is the
  // most conservative existing wording (SMI-6114 retro F3).
  const result = ev.result
  if (result === 'success') {
    return withActor(who, `${verbs.done} ${subject}`, `${capitalize(subject)} was ${verbs.done}`)
  }
  const outcome =
    typeof result === 'string' && isAttemptOutcomeKey(result)
      ? ATTEMPT_OUTCOMES[result]
      : 'did not complete'
  return withActor(
    who,
    `tried to ${verbs.attempt} ${subject}, which ${outcome}`,
    `An attempt to ${verbs.attempt} ${subject} ${outcome}`
  )
}

/**
 * Build the plain-English sentence for one event. Never includes the raw resource/UUID.
 *
 * SMI-6114 retro F4 sibling sweep: of the arms below, only `email_sent` (an edge function,
 * `supabase/functions/team-invite-send/index.ts:261`) can ever write a non-'success' `result` --
 * it writes 'failure' on a non-2xx/thrown Resend call, hence the fix just above. `created`
 * (`supabase/migrations/20260520000001_team_invitations.sql:182`), `accepted` (:304), `revoked`
 * (:371), and `team_member:removed`
 * (`supabase/migrations/20260521000001_team_member_visibility_and_removal.sql:160`) are each
 * written by a single SQL RPC whose `audit_logs` INSERT hardcodes the literal `'success'` and is
 * itself wrapped in a `BEGIN ... EXCEPTION WHEN OTHERS ... END` block that only `RAISE WARNING`s
 * on failure (never writing a 'failure' row) -- so today these four rows either carry
 * `result: 'success'` or were never written at all; there is no non-success row for them to
 * misrender, and no fix is needed for those arms. The `default:` humanize-action fallback never
 * asserts success or failure in the first place (it paraphrases the raw action verb, present
 * tense, ambiguous), so it carries no equivalent defect to guard against either.
 */
function buildSentence(ev: ActivityEvent, who: string | null): string {
  if (ev.event_type?.startsWith('private_registry:')) {
    return registrySentence(ev, who, ev.event_type.slice('private_registry:'.length))
  }
  switch (ev.event_type) {
    case 'team_invitation:created':
      return withActor(
        who,
        `created an invitation${roleSuffix(ev.metadata)}`,
        'An invitation was created'
      )
    case 'team_invitation:email_sent':
      // SMI-6114 retro F4: this arm rendered every row as "was sent" regardless of `ev.result`,
      // the same silent-success defect `registrySentence()` above was hardened against --
      // team-invite-send/index.ts:261 writes `result: 'failure'` on a non-2xx/thrown Resend
      // call, and that row's `metadata.team_id` (:264) reaches this feed the same way a
      // successful send's does. Strict `=== 'success'` (not `!== 'failure'`) so a missing/
      // unknown result never reads as success either, matching registrySentence()'s own rule.
      return ev.result === 'success'
        ? 'An invitation email was sent'
        : 'An invitation email failed to send'
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
