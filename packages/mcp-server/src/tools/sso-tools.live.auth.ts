/**
 * @fileoverview The two named user-auth getters for SSO configuration
 * @module @skillsmith/mcp-server/tools/sso-tools.live.auth
 * @see SMI-6204 (Wave 3 of SMI-6200): live SSO configuration over `team-sso-manage`
 * @see SMI-6203 (Wave 2) / `rbac-tools.live.auth.ts`: the "two named getters, no defaulted
 *      authorization boolean" convention this file mirrors in SHAPE, not in mechanism (see below)
 * @see SMI-6202 (Wave 1): `has_team_permission()`, extended with `team:manage_sso` in Wave 2
 *
 * ONE FILE, TWO NAMES, NO DEFAULT. `rbac-tools.live.auth.ts`'s header records a cross-provider
 * plan-review finding that rejected a single getter with a defaulted `requiresAdmin: boolean`,
 * because "a defaulted authorization boolean is default-preserving today and silently wrong the
 * first time someone adds a call site and omits it." That reasoning is unchanged here and is not
 * repeated in full — see that file for the complete argument.
 *
 * SAME SHAPE, DIFFERENT MECHANISM. `rbac-tools.live.auth.ts` resolves a Postgres-RPC-capable
 * Supabase client (`RbacSupabaseClient`, `{ rpc }`), because every RBAC operation IS a `.rpc()`
 * call and needs one. Wave 3's `team-sso-manage` is a gateway-JWT-verified EDGE FUNCTION, called
 * over `fetch()` — `packages/core/src/sync/inventory-client.ts:108-127` is the calling pattern
 * (see `sso-tools.live.ts`), not `.rpc()`. So there is nothing here for a Supabase-js client
 * object to DO: the edge function itself extracts `auth.uid()` from the bearer token and resolves
 * the caller's team server-side (Wave 3 plan doc, Step 2, items 1-2) — this file's entire job is
 * producing the one thing a `fetch()` call needs that an RPC call would otherwise get for free
 * from `getSupabaseUserClient()`: the caller's own bearer token, resolved the IDENTICAL way
 * `rbac-tools.live.auth.ts` resolves it (`resolveUserAccessToken()`), so both surfaces refuse an
 * unauthenticated caller with the same "run `skillsmith login`" guidance and neither ever falls
 * back to a service-role or license-key credential when nobody is signed in (see that file's
 * header for why: a shared team license key identifies a TEAM, not a PERSON, and
 * `has_team_permission()` resolves `auth.uid()`, which a license-key-bound credential can never
 * populate).
 *
 * WHY TWO GETTERS WHEN `team-sso-manage` HAS ONLY ONE SERVER-SIDE GATE TODAY. Every action the
 * edge function accepts — `set`, `test`, `remove`, `claim_domain`, `verify_domain`, and the read
 * `get` — is gated identically on `team:manage_sso` (Wave 3 plan doc, Step 2, item 2: "Resolve the
 * caller's team; call `has_team_permission(team_id, 'team:manage_sso')` ... Per request"), unlike
 * Wave 2's genuine two-gate split (`team:manage_rbac` for writes/full-read vs. plain team
 * membership for `list_team_members_with_profile`). So today `getSsoManageUserClient` and
 * `getSsoReadUserClient` resolve through the identical `bindUserAuth()` body and name the same
 * permission in their refusal text — there is no BEHAVIORAL difference yet. The split still earns
 * its keep for two reasons: (1) `sso_settings` (line 351 of the Wave 3 plan doc: "`sso_settings`
 * call it over HTTP with the signed-in user's own JWT") is a read, and keeping it on its own named
 * getter means a future narrowing to "any team member may view whether SSO is configured"
 * (mirroring `getRbacReadUserClient`'s membership-only gate) is a one-line change to this file's
 * `gate` value and message, not a call-site rewrite across `sso-tools.ts`; (2) the `gate` field
 * on the returned binding is recorded so "no call site uses the wrong getter" stays an observable
 * fact rather than an unverified assumption, matching `RbacUserClientBinding.gate`'s own purpose.
 */

import { resolveUserAccessToken } from './team-resolver.js'
import { accessTokenSubject } from './registry-tools.live.audit.js'

/**
 * The caller's own bearer token, plus the identity it presents — everything a `team-sso-manage`
 * `fetch()` call needs. Deliberately NOT a Supabase client object: see this file's header for why
 * an RPC-shaped client (`RbacSupabaseClient`'s `{ rpc }`) has no role on the `fetch()` path.
 */
export interface SsoUserAuthBinding {
  /** Becomes the `Authorization: Bearer` header on the `team-sso-manage` request. */
  accessToken: string
  /** JWT `sub` — the principal `auth.uid()` resolves to. Null when the token is not decodable. */
  actorUserId: string | null
  /**
   * Which getter produced this binding. See this file's header for why the two gates are
   * identical today and what would make them diverge.
   */
  gate: 'manage_sso' | 'read'
}

/**
 * Shared body of {@link getSsoManageUserClient} and {@link getSsoReadUserClient}.
 *
 * Deliberately NOT exported, and deliberately not reachable with a defaulted gate — every caller
 * goes through one of the two named wrappers below. Two parameters, not `rbac-tools.live.auth.ts`'s
 * three (`gate, operation, noUserMessage`): that file's third step — constructing a real Supabase
 * client via `getSupabaseUserClient(token)` — can itself throw (e.g. `@supabase/supabase-js` not
 * installed), which is what its `operation` parameter names in the resulting error. There is no
 * equivalent step here (no client is constructed), so there is nothing after token resolution that
 * could fail and need `operation` to annotate. Both getters below still thread `operation` through
 * into their own `noUserMessage` text — see each getter's own JSDoc.
 */
async function bindUserAuth(
  gate: 'manage_sso' | 'read',
  noUserMessage: string
): Promise<SsoUserAuthBinding> {
  const token = await resolveUserAccessToken()
  if (!token) throw new Error(noUserMessage)
  return { accessToken: token, actorUserId: accessTokenSubject(token), gate }
}

/**
 * A user-bound credential for `configure_sso`'s administrative actions — `set`, `test`, `remove`,
 * `claim_domain`, `verify_domain`. `team-sso-manage` gates every one of them on `team:manage_sso`.
 *
 * @param operation - a verb phrase for the failure message, e.g. `'configure SSO'`
 */
export async function getSsoManageUserClient(operation: string): Promise<SsoUserAuthBinding> {
  return bindUserAuth(
    'manage_sso',
    `Signing in is required to ${operation}. Configuring SSO checks the "team:manage_sso" ` +
      'permission against your own account — a shared team license key identifies a team, not a ' +
      'person, and can never authorize an SSO change. Run `skillsmith login` on this machine and ' +
      'retry.'
  )
}

/**
 * A user-bound credential for `sso_settings` (the read-only query). Gated identically to
 * {@link getSsoManageUserClient} today — see this file's header for why it is still a separate,
 * named getter rather than reusing that one.
 *
 * @param operation - a verb phrase for the failure message, e.g. `'view SSO settings'`
 */
export async function getSsoReadUserClient(operation: string): Promise<SsoUserAuthBinding> {
  return bindUserAuth(
    'read',
    `Signing in is required to ${operation}. This runs as you, not as your team's shared license ` +
      'key — a license key identifies a team, not a person. Run `skillsmith login` on this ' +
      'machine and retry.'
  )
}
