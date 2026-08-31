/**
 * @fileoverview The one structured permission-denial shape every team-permission surface returns
 * @module @skillsmith/mcp-server/tools/team-permission-error
 * @see SMI-6203 (Wave 2 of SMI-6200): live RBAC service on `has_team_permission()`
 * @see SMI-6202 (Wave 1): `team_permission_grants` + the five resolver functions
 *
 * WHY THIS IS ITS OWN MODULE, AND NOT PART OF `rbac-tools.types.ts`.
 *
 * The Wave 2 plan specifies this shape once, deliberately, so no call site invents its own copy:
 * `{ success: false, error: { code: 'permission_denied', permission, message } }`, with the CLI
 * and the website both rendering `error.message` verbatim. Two consumers already exist
 * (`rbac-tools.live.ts`, `rbac-tools.ts`) and a third arrives in Wave 3 — `sso-tools.live.ts`,
 * gated on `team:manage_sso`. Having the SSO tools import a permission shape out of
 * `rbac-tools.types.ts` would be a domain inversion, and copying the sentence into a second file
 * is exactly how two surfaces end up disagreeing about what a refusal says. One module, imported
 * by all of them.
 *
 * A CUSTOMER MUST NEVER SEE A RAW SQLSTATE, AND MUST NEVER SEE A RAW POSTGRES REFUSAL EITHER.
 *
 * Every gate in Wave 1's migration raises `42501`, but they do not all mean the same thing, and
 * one of them is not even ours: Postgres itself raises `42501` with messages like
 * `permission denied for table team_permission_grants`, which names internal schema objects. So
 * {@link toPermissionDeniedError} maps by an ALLOWLIST, not by passthrough:
 *
 *  - `permission_denied` (the exact text `has_team_permission()`'s callers raise) → the standard
 *    sentence naming the permission the operation required.
 *  - One of the three owner-protection refusals `set_team_member_role()` raises → that refusal's
 *    own text, which is authored copy and strictly more useful than the generic sentence
 *    ("cannot change the team owner's role" tells the caller something the generic one cannot).
 *  - Any other `42501`, from any source → the standard sentence. Fails SAFE: if the migration's
 *    copy is ever reworded, the allowlist stops matching and the caller gets the generic sentence
 *    rather than a leaked internal message.
 */

/** The literal every permission refusal carries, so consumers can switch on one value. */
export const PERMISSION_DENIED_CODE = 'permission_denied' as const

/** SQLSTATE `insufficient_privilege` — what every Wave 1 gate raises. */
const POSTGRES_INSUFFICIENT_PRIVILEGE = '42501'

/**
 * The structured error body. `permission` names the permission the operation REQUIRED (not one the
 * caller holds), so a UI can offer "ask an admin to grant `<permission>`" without parsing prose.
 */
export interface PermissionDeniedError {
  code: typeof PERMISSION_DENIED_CODE
  permission: string
  message: string
}

/** The full refusal envelope, for a surface that returns rather than throws. */
export interface PermissionDeniedResult {
  success: false
  error: PermissionDeniedError
}

/**
 * The one sentence. Specified in the Wave 2 plan (Step 4) and rendered verbatim by the CLI, the
 * MCP tool output, and the website — do not reword it at a call site.
 */
export function permissionDeniedMessage(permission: string): string {
  return (
    `You don't have the "${permission}" permission for this team. ` +
    'Ask a team admin to grant it.'
  )
}

/**
 * The exact refusals `set_team_member_role()` / `set_team_role_permission()` /
 * `reset_team_role_permission()` raise with `42501` that are NOT "you lack the permission" — they
 * are owner-anchored structural rules, and their own wording is better copy than the generic
 * sentence. Matched case-insensitively against the trimmed message.
 *
 * Kept as an allowlist rather than a passthrough because `42501` is also raised by Postgres itself
 * with messages that name internal schema objects (`permission denied for table
 * team_permission_grants`). See the module header.
 *
 * SMI-6203 Wave 2 additions (`20260828000000_rbac_grant_writes.sql`): the owner-anchored refusals
 * `set_team_role_permission()` / `reset_team_role_permission()` raise — gate 4 (only the owner may
 * write or clear a row for EITHER meta-permission, `team:manage_rbac` or `team:manage_sso`) and
 * gate 5 (no self-widening — only an owner/admin-role caller may write `effect=allow`). Gate 4's
 * SQL builds its message with a `%` substitution of `p_permission`, which gate 1 has already
 * constrained to the four-value allowlist — so it has exactly the two possible outputs listed
 * below and can never carry caller-controlled text. Both are enumerated here rather than matched
 * by prefix, because a prefix match would be a passthrough in allowlist clothing.
 *
 * SMI-6319 additions (`20260901000000_rbac_meta_permission_not_grantable.sql`, gate 4b): the
 * refusal raised when a caller tries to GRANT either meta-permission to a role. Gate 4 (above)
 * checks the CALLER and never the TARGET, so before SMI-6319 the owner could hand `admin` or
 * `member` the very authority gate 4 exists to keep owner-anchored — confirmed live during
 * SMI-6312 UAT. Gate 4b refuses that write for everyone, including the owner, who already holds
 * both unconditionally via `has_team_permission()`'s owner short-circuit. Same `%`-substitution
 * shape as gate 4's message, on the same gate-1-validated four-value allowlist, so it likewise
 * has exactly the two possible outputs enumerated below and can never carry caller-controlled
 * text. `deny` writes on a meta-permission are NOT refused (they can only narrow), so no third
 * sentence exists.
 *
 * Text is byte-identical to both the SQL's `RAISE EXCEPTION` message and the stub's
 * `requireGrantWriteAuthority()` (`rbac-tools.stub.ts`), so live and stub render the same authored
 * copy rather than the generic sentence. Matching is full-string and case-insensitive, and the
 * value RETURNED is this constant — never `err.message` — so even a match cannot echo remote text.
 */
const PASSTHROUGH_REFUSALS: readonly string[] = [
  "cannot change the team owner's role",
  "forbidden: only the team owner can change an admin's role",
  'forbidden: only owners and admins can promote a member to admin',
  'Only the team owner can change who holds the "team:manage_rbac" permission.',
  'Only the team owner can change who holds the "team:manage_sso" permission.',
  'The "team:manage_rbac" permission is owner-only and cannot be granted to another role.',
  'The "team:manage_sso" permission is owner-only and cannot be granted to another role.',
  "Only owners and admins can widen a role's permissions. You can review permissions and " +
    'remove grants, but not add an allow.',
]

/**
 * A permission refusal raised as an exception, so a service method can `throw` it and a handler can
 * map it in one place.
 *
 * The stub service throws this directly (its in-memory gates mirror the SQL ones); the live service
 * constructs it from a PostgREST `42501`. Both therefore reach the tool layer identically, which is
 * the point — a test asserting on a refusal must not be able to tell stub from live.
 */
export class TeamPermissionDeniedError extends Error {
  readonly code = PERMISSION_DENIED_CODE
  readonly permission: string

  constructor(permission: string, message?: string) {
    super(message ?? permissionDeniedMessage(permission))
    this.name = 'TeamPermissionDeniedError'
    this.permission = permission
  }

  toErrorShape(): PermissionDeniedError {
    return { code: this.code, permission: this.permission, message: this.message }
  }
}

/** The minimal shape of a PostgREST/`supabase-js` error, without taking a hard dependency on it. */
interface PostgresErrorLike {
  code?: unknown
  message?: unknown
}

function readPostgresError(err: unknown): { code: string | null; message: string } | null {
  if (typeof err !== 'object' || err === null) return null
  const candidate = err as PostgresErrorLike
  const code = typeof candidate.code === 'string' ? candidate.code : null
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  if (code === null && message.length === 0) return null
  return { code, message }
}

/**
 * Map any thrown/returned error to the structured refusal shape, or `null` when it is not a
 * permission refusal at all (so the caller can surface it as an ordinary error instead of
 * mislabelling an outage as a denial).
 *
 * @param err - a {@link TeamPermissionDeniedError}, a PostgREST error object, or anything else
 * @param requiredPermission - the permission the attempted operation needs; used for `permission`
 *        and for the generic message. The caller always knows this statically, so it is a required
 *        argument rather than something guessed out of the error text.
 */
export function toPermissionDeniedError(
  err: unknown,
  requiredPermission: string
): PermissionDeniedError | null {
  if (err instanceof TeamPermissionDeniedError) return err.toErrorShape()

  const pg = readPostgresError(err)
  if (!pg) return null

  const text = pg.message.trim()
  const isDenial =
    pg.code === POSTGRES_INSUFFICIENT_PRIVILEGE || text.toLowerCase() === PERMISSION_DENIED_CODE
  if (!isDenial) return null

  const passthrough = PASSTHROUGH_REFUSALS.find((r) => r.toLowerCase() === text.toLowerCase())
  return {
    code: PERMISSION_DENIED_CODE,
    permission: requiredPermission,
    message: passthrough ?? permissionDeniedMessage(requiredPermission),
  }
}

/** True when `error` is the structured refusal rather than a plain validation string. */
export function isPermissionDeniedError(error: unknown): error is PermissionDeniedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as PermissionDeniedError).code === PERMISSION_DENIED_CODE
  )
}

/**
 * The display string for a tool result's `error` field, which is `string` for input-validation
 * failures and {@link PermissionDeniedError} for refusals. One helper so every renderer (CLI, MCP
 * text output, website) gets the same text without repeating the narrowing.
 */
export function permissionErrorText(error: string | PermissionDeniedError | undefined): string {
  if (error === undefined) return ''
  return typeof error === 'string' ? error : error.message
}
