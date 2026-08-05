/**
 * e2e-registry-roundtrip.mcp-live.ts
 *
 * SMI-5922 — MCP-live coverage companion, split out of e2e-registry-roundtrip.ts to
 * stay under the 500-line file-length gate (audit:standards).
 *
 * Reruns round-trip assertions #3/#4/#6 through the live MCP service
 * (`registry-tools.live.content.ts`'s `getSkillContent()`), reached via a relative
 * dist/ import since these are internal modules, not part of `@skillsmith/mcp-server`'s
 * public package exports — a plain filesystem import within the monorepo, unaffected
 * by the package's declared "exports" map. If this import genuinely fails to resolve,
 * degrades to a loud warning + TODO instead of crashing the whole spec.
 *
 * Scope, stated precisely (GPT-5.6-Sol review finding #5): this calls
 * `resolveLicenseTeamId()` / `getMemberUserClient()` / `getSkillContent()` directly —
 * the entitlement + RLS + credential-resolution primitives the real MCP tool is built
 * on. It does NOT go through `private_registry_manage`'s own input-schema validation
 * or its `executePrivateRegistryManage`/action-dispatch switch (`registry-tools.ts`),
 * so a regression in THAT routing layer (e.g. `install` wired to the wrong getter, or
 * the dispatcher no longer calling `getSkillContent` at all) would not be caught here.
 * The CLI subprocess and raw-HTTP checks elsewhere in this spec already exercise a
 * full real request path end-to-end; this piece's job is deep coverage of the
 * MCP-specific credential/entitlement internals those paths don't touch, not a second
 * full dispatcher-level proof.
 *
 * Team resolution here deliberately does NOT reuse the main script's own
 * service-role-based teamAId/teamBId lookup. The real MCP tool surface
 * (`private_registry_manage`, `registry-tools.ts`'s `resolveTeamId()`) resolves
 * "which team's registry" EXCLUSIVELY from `SKILLSMITH_LICENSE_KEY` via
 * `resolveLicenseTeamId()` (`team-resolver.ts`) — never from the caller's own
 * `team_members` rows. Passing a self-resolved teamId into `getSkillContent()` would
 * test the content-fetch primitive but skip the actual team-selection mechanism a real
 * tool call goes through, so this resolves teamId the same way production does: set
 * `SKILLSMITH_LICENSE_KEY` to the team-scoped key the seed script minted, then call
 * `resolveLicenseTeamId()` for real.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeCredentials } from '@skillsmith/core'
import type { ActorSession, RecordFn } from './e2e-registry-roundtrip.types.js'

export async function runMcpLiveCoverage(
  record: RecordFn,
  memberSession: ActorSession,
  nonentSession: ActorSession,
  dualSession: ActorSession,
  teamALicenseKey: string,
  teamBLicenseKey: string,
  publishedSkillId: string,
  durableSkillId: string
): Promise<void> {
  let mod: {
    getMemberUserClient: (op: string) => Promise<{ client: unknown; role: string }>
  }
  let contentMod: {
    getSkillContent: (params: {
      binding: { client: unknown; actorUserId: string | null; role: 'admin' | 'member' }
      teamId: string
      skillId: string
    }) => Promise<unknown>
  }
  let resolverMod: {
    resolveLicenseTeamId: (licenseKey?: string) => Promise<string | null>
  }
  try {
    mod =
      (await import('../packages/mcp-server/dist/src/tools/registry-tools.live.auth.js')) as typeof mod
    contentMod =
      (await import('../packages/mcp-server/dist/src/tools/registry-tools.live.content.js')) as typeof contentMod
    resolverMod =
      (await import('../packages/mcp-server/dist/src/tools/team-resolver.js')) as typeof resolverMod
  } catch (err) {
    // TODO(SMI-5922-follow-up): the relative dist/ import to the MCP-live internal
    // modules failed to resolve (see error below) -- this was expected to work per
    // the SMI-5922 implementation-time investigation. If this fires, one of the
    // module paths likely moved. File a follow-up SMI for MCP-live coverage rather
    // than silently treating this as covered -- SMI-5882's already-green live RLS
    // harness (Postgres-layer _member_read isolation) is the accepted interim
    // coverage for this path only.
    console.error(
      `[e2e-registry] WARNING: MCP-live coverage skipped -- dist import failed: ${String(err)}`
    )
    record('mcp-live', false, `dist import failed: ${String(err)}`)
    return
  }

  async function withActorContext<T>(
    home: string,
    licenseKey: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const origHome = process.env.HOME
    const origKey = process.env.SKILLSMITH_LICENSE_KEY
    process.env.HOME = home
    process.env.SKILLSMITH_LICENSE_KEY = licenseKey
    try {
      return await fn()
    } finally {
      process.env.HOME = origHome
      process.env.SKILLSMITH_LICENSE_KEY = origKey
    }
  }

  async function seedAndGetContent(
    actorLabel: string,
    session: ActorSession,
    licenseKey: string,
    skillId: string
  ): Promise<{ ok: boolean; error?: string; content?: unknown }> {
    const home = mkdtempSync(join(tmpdir(), `e2e-reg-mcp-${actorLabel}-`))
    try {
      await withActorContext(home, licenseKey, async () => {
        await storeCredentials({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresAt: Date.now() + session.expiresIn * 1000,
          version: 2,
        })
      })
      const result = await withActorContext(home, licenseKey, async () => {
        const teamId = await resolverMod.resolveLicenseTeamId(licenseKey)
        if (!teamId) throw new Error(`resolveLicenseTeamId returned null for ${actorLabel}`)
        const binding = await mod.getMemberUserClient('install')
        return contentMod.getSkillContent({
          binding: binding as {
            client: unknown
            actorUserId: string | null
            role: 'admin' | 'member'
          },
          teamId,
          skillId,
        })
      })
      return { ok: true, content: result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // Row 3 analogue: Team A member fetches the published skill via THEIR OWN
  // license key (always Team A's -- the real tool never lets a caller pick
  // teamId) -- expect content.
  const r3 = await seedAndGetContent('member', memberSession, teamALicenseKey, publishedSkillId)
  record('mcp-live-row3', r3.ok && r3.content != null, r3.error ?? JSON.stringify(r3.content))

  // Row 4 analogue: Team B member asks for Team A's skill_id, scoped to THEIR OWN
  // team (Team B) via their own license key -- no row matches team_id=teamB AND
  // that skill_id, so this is still a valid non-leak check, just enforced by the
  // team-scoped query itself rather than an RLS cross-team filter.
  const r4 = await seedAndGetContent('nonent', nonentSession, teamBLicenseKey, publishedSkillId)
  record('mcp-live-row4', r4.ok && r4.content === null, r4.error ?? JSON.stringify(r4.content))

  // Row 6 analogue (load-bearing): dual-membership actor, scoped to Team B via
  // Team B's own license key, fetches Team B's own durable skill -- expect a
  // throw whose message identifies the ENTITLEMENT denial specifically (not just
  // any thrown error). This is the actual regression case: dual holds Enterprise
  // entitlement via Team A, but the license key here resolves them to Team B,
  // whose subscription is not Enterprise -- a global profiles.tier check would
  // incorrectly grant access.
  //
  // GPT-5.6-Sol review finding #2: the original check treated ANY failure --
  // invalid credentials, token-load failure, license-resolution failure, a DB
  // outage, an audit-write failure -- as "entitlement denied", so this row would
  // pass even if the entitlement path was never reached (e.g. a broken refresh
  // token). Matches getSkillContent()'s exact denial message substring
  // (registry-tools.live.content.ts's "requires an active Enterprise" throw) so
  // only the real denial counts.
  const ENTITLEMENT_DENIAL_MARKER = 'requires an active Enterprise'
  const r6 = await seedAndGetContent('dual', dualSession, teamBLicenseKey, durableSkillId)
  const r6IsEntitlementDenial = !r6.ok && (r6.error ?? '').includes(ENTITLEMENT_DENIAL_MARKER)
  const r6Detail = r6.ok
    ? `expected an entitlement-denial throw, got a result: ${JSON.stringify(r6.content)}`
    : r6IsEntitlementDenial
      ? r6.error
      : `threw, but not the expected entitlement denial (got: ${r6.error})`
  record('mcp-live-row6', r6IsEntitlementDenial, r6Detail)
}
