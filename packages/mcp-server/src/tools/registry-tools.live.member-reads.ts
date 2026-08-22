/**
 * @fileoverview Audited, member-JWT-authenticated wrappers for list()/get()/getNamespace()
 * @module @skillsmith/mcp-server/tools/registry-tools.live.member-reads
 * @see SMI-6109: moved these three off the Supabase service-role client
 *
 * Split out of registry-tools.live.ts (580/500 lines after the SMI-6109 credential move) — the
 * established `.live.auth.ts`/`.live.audit.ts`/`.live.content.ts`/`.live.submissions.ts`
 * companion-module convention. Each function here: binds the signed-in user's own JWT via
 * getMemberUserClient() (registry-tools.live.auth.ts — MEMBER, not admin: any team member may
 * list/get/discover-namespace), runs the actual query (listSkills()/getSkill() from
 * registry-tools.live.reads.ts for the first two; getNamespace's own inline `teams` table query,
 * which belongs here rather than in reads.ts since that file is scoped to
 * `private_registry_skills` predicates specifically, not `teams`), and records a
 * recordRegistryAudit() row (registry-tools.live.audit.ts) so the license-key-team-vs-signed-in-
 * user dual-identity-signal gap this credential move introduces is observable rather than
 * invisible: the license key resolves one team, the signed-in user's own membership can silently
 * point at a different one (or none), and RLS fails closed on the mismatch indistinguishably from
 * "genuinely not found."
 *
 * getNamespace()'s wrapper deliberately swallows a getMemberUserClient() failure and returns null
 * rather than throwing — its documented contract (registry-tools.ts's PrivateRegistryService
 * interface) is "or null if it could not be resolved," and two callers (the
 * manage(action:'namespace') handler, and the publish namespace pre-check) depend on that
 * never-throws contract staying true. list()/get() have no such contract and throw normally on
 * failure — registry-tools.ts's dispatcher already wraps every service call to convert a thrown
 * error into a typed {success:false} result (see its own comment there: "Wrap service calls so
 * live-mode errors ... surface as typed results instead of propagating as unhandled exceptions"),
 * the same path `deprecate`/`undeprecate`/`getContent`/`publish` already rely on.
 */

import { recordRegistryAudit } from './registry-tools.live.audit.js'
import { getMemberUserClient } from './registry-tools.live.auth.js'
import { listSkills, getSkill } from './registry-tools.live.reads.js'
import type { RegistrySkill } from './registry-tools.js'

/** D-4 surface 3 + SMI-5949 Wave 3 (deprecated read-filter closure) + SMI-6109 (this file). */
export async function auditedList(
  teamId: string,
  version?: string,
  includeDeprecated?: boolean
): Promise<RegistrySkill[]> {
  let actorUserId: string | null = null
  try {
    const { client, actorUserId: uid } = await getMemberUserClient('list')
    actorUserId = uid
    const skills = await listSkills(client, teamId, version, includeDeprecated)
    await recordRegistryAudit({
      operation: 'list',
      teamId,
      result: 'success',
      authPath: 'user_jwt',
      authRole: 'member',
      actorUserId,
    })
    return skills
  } catch (err) {
    await recordRegistryAudit({
      operation: 'list',
      teamId,
      result: 'error',
      authPath: 'user_jwt',
      authRole: 'member',
      actorUserId,
      detail: err instanceof Error ? err.message : 'unknown error',
    })
    throw err
  }
}

/**
 * D-4 surface 4 + SMI-5949 Wave 3 + SMI-6109 (this file) — see registry-tools.live.reads.ts's
 * getSkill() for why this one carries no includeDeprecated opt-in, unlike auditedList() above.
 */
export async function auditedGet(
  teamId: string,
  skillId: string,
  version?: string
): Promise<RegistrySkill | null> {
  let actorUserId: string | null = null
  try {
    const { client, actorUserId: uid } = await getMemberUserClient('get')
    actorUserId = uid
    const skill = await getSkill(client, teamId, skillId, version)
    await recordRegistryAudit({
      operation: 'get',
      teamId,
      skillId,
      version,
      result: 'success',
      authPath: 'user_jwt',
      authRole: 'member',
      actorUserId,
    })
    return skill
  } catch (err) {
    await recordRegistryAudit({
      operation: 'get',
      teamId,
      skillId,
      version,
      result: 'error',
      authPath: 'user_jwt',
      authRole: 'member',
      actorUserId,
      detail: err instanceof Error ? err.message : 'unknown error',
    })
    throw err
  }
}

/** SMI-6109. Never throws — see this file's header comment for why. */
export async function auditedGetNamespace(teamId: string): Promise<string | null> {
  let actorUserId: string | null = null
  try {
    const { client, actorUserId: uid } = await getMemberUserClient('namespace')
    actorUserId = uid
    const resp = await client
      .from<{ skill_namespace: string }>('teams')
      .select('skill_namespace')
      .eq('id', teamId)
      .single()
    const namespace = resp.error || !resp.data ? null : (resp.data.skill_namespace ?? null)
    await recordRegistryAudit({
      operation: 'namespace',
      teamId,
      result: 'success',
      authPath: 'user_jwt',
      authRole: 'member',
      actorUserId,
    })
    return namespace
  } catch (err) {
    await recordRegistryAudit({
      operation: 'namespace',
      teamId,
      result: 'error',
      authPath: 'user_jwt',
      authRole: 'member',
      actorUserId,
      detail: err instanceof Error ? err.message : 'unknown error',
    })
    return null
  }
}
