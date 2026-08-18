/**
 * e2e-registry-roundtrip.row1-publish.ts
 *
 * SMI-5922 — Row 1/1a/1b/1c (publish + admin-approve) companion, split out of
 * e2e-registry-roundtrip.ts to stay under the 500-line file-length gate
 * (audit:standards).
 *
 * SMI-5969: previously did a raw insert via the admin actor's own user JWT, which the
 * SMI-5949 approval-gate + privilege-hardening RLS now correctly rejects -- real
 * customers never publish that way. This calls the exact handler `private_registry_publish`
 * dispatches to (registry-tools.ts's executePrivateRegistryPublish), via the same dist/
 * import pattern e2e-registry-roundtrip.mcp-live.ts already uses for its own MCP-internal
 * coverage. This exercises the shipped handler, license-key team resolution, live service,
 * service-role insert, trigger, and audit path -- it does NOT exercise the MCP protocol
 * transport or the dispatcher's own input-schema/license/quota middleware
 * (tool-dispatch.ts). Accepted gap for this row specifically: the input here is fixed and
 * valid, and this suite already runs compiled internals in-process elsewhere. See
 * docs/internal/implementation/smi-5969-e2e-real-publish-path.md.
 *
 * SMI-5949 D-7 (plan finding H1): `publish` moved to `getMemberUserClient('publish')`,
 * which requires a real signed-in user's stored credentials in addition to the license
 * key -- row 1b seeds Team A member's real session via `withUserCredentials()` before
 * calling the handler, matching D-7's "any team member, not just admins" publish grant.
 *
 * SMI-6080: readLicenseKey() falls back to SKILLSMITH_API_KEY when SKILLSMITH_LICENSE_KEY
 * is unset, so row 1a's "must refuse without a credential" check has to clear BOTH. This
 * script runs against a real project with real credentials in the environment, so an
 * ambient SKILLSMITH_API_KEY would otherwise resolve a team and turn 1a into a false
 * failure.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { withUserCredentials, approvePendingSubmission } from './e2e-registry-roundtrip.helpers.js'
import type { ActorSession } from './e2e-registry-roundtrip.types.js'

type RecordFn = (row: string, pass: boolean, detail?: string) => void

/**
 * Runs rows 1 (publish-requires-license + publish), and 1c (admin approve).
 *
 * @param record - the caller's shared result-recording function
 * @param admin - service-role Supabase client, used only for the read-only
 *   content_hash observation after publish
 */
export async function runRow1PublishAndApprove(
  record: RecordFn,
  admin: SupabaseClient,
  teamAId: string,
  teamALicenseKey: string,
  publishedSkillId: string,
  publishedContent: Record<string, string>,
  memberSession: ActorSession,
  adminSession: ActorSession
): Promise<void> {
  let publishMod: {
    executePrivateRegistryPublish: (
      input: {
        skillId: string
        version: string
        content: Record<string, string>
        description?: string
      },
      context: unknown
    ) => Promise<{ success: boolean; skill?: { skillId: string; version: string }; error?: string }>
  }
  let contextMod: {
    createToolContext: (options?: { dbPath?: string }) => unknown
    closeToolContext: (context: unknown) => Promise<void>
  }
  try {
    publishMod =
      (await import('../packages/mcp-server/dist/src/tools/registry-tools.js')) as typeof publishMod
    contextMod = (await import('../packages/mcp-server/dist/src/context.js')) as typeof contextMod
  } catch (err) {
    console.error(
      `[e2e-registry] FATAL: dist import for the real publish path failed: ${String(err)}`
    )
    record('row1-publish-requires-license', false, `dist import failed: ${String(err)}`)
    record('row1-publish', false, `dist import failed: ${String(err)}`)
    process.exit(1)
  }

  const publishInput = {
    skillId: publishedSkillId,
    version: '1.0.0',
    description: 'SMI-5922 round-trip fixture',
    content: publishedContent,
  }
  // SKILLSMITH_LICENSE_KEY and SKILLSMITH_API_KEY are process-globals -- save/restore both
  // around these calls (in a finally) so neither can leak into a later row or a later run
  // in this same process. Delete rather than reassign `undefined`: Node coerces
  // `process.env.X = undefined` to the literal string "undefined", which readLicenseKey()
  // would then treat as a non-empty (truthy) key.
  const origLicenseKey = process.env.SKILLSMITH_LICENSE_KEY
  const origApiKey = process.env.SKILLSMITH_API_KEY
  const toolContext = contextMod.createToolContext({ dbPath: ':memory:' })
  try {
    // 1a. Without any team credential, the real handler must refuse -- proves this
    // run isn't silently falling back to the stub service if misconfigured.
    delete process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_API_KEY
    const noAuthResult = await publishMod.executePrivateRegistryPublish(publishInput, toolContext)
    record(
      'row1-publish-requires-license',
      noAuthResult.success === false &&
        (noAuthResult.error ?? '').includes('SKILLSMITH_LICENSE_KEY') &&
        (noAuthResult.error ?? '').includes('SKILLSMITH_API_KEY'),
      noAuthResult.error ?? 'unexpectedly succeeded without a team credential'
    )

    // 1b. The real publish, authenticated the way a real customer would be -- via
    // their team's license key (resolved server-side to a team_id) AND a signed-in
    // team member's own credentials (D-7 -- the license key alone no longer
    // suffices; `published_by` must resolve to a real person).
    process.env.SKILLSMITH_LICENSE_KEY = teamALicenseKey
    const publishResult = await withUserCredentials(memberSession, () =>
      publishMod.executePrivateRegistryPublish(publishInput, toolContext)
    )
    const publishOk =
      publishResult.success === true &&
      publishResult.skill?.skillId === publishedSkillId &&
      publishResult.skill?.version === '1.0.0'

    // content_hash is deliberately not part of the tool's public return shape
    // (RegistrySkill / mapRow() omit it) -- verify the server-side trigger computed
    // a real hash with a read-only service-role check. Observation only, not part
    // of the action under test.
    let contentHashOk = false
    let contentHashDetail: string = publishResult.error ?? 'publish did not succeed'
    if (publishOk) {
      const hashResp = await admin
        .from('private_registry_skills')
        .select('content_hash')
        .eq('team_id', teamAId)
        .eq('skill_id', publishedSkillId)
        .eq('version', '1.0.0')
        .single()
      contentHashOk =
        typeof hashResp.data?.content_hash === 'string' &&
        /^[0-9a-f]{64}$/.test(hashResp.data.content_hash)
      contentHashDetail =
        hashResp.error?.message ?? `content_hash=${String(hashResp.data?.content_hash)}`
    }
    record('row1-publish', publishOk && contentHashOk, contentHashDetail)
  } finally {
    if (origLicenseKey === undefined) {
      delete process.env.SKILLSMITH_LICENSE_KEY
    } else {
      process.env.SKILLSMITH_LICENSE_KEY = origLicenseKey
    }
    if (origApiKey === undefined) {
      delete process.env.SKILLSMITH_API_KEY
    } else {
      process.env.SKILLSMITH_API_KEY = origApiKey
    }
    await contextMod.closeToolContext(toolContext)
  }

  // ---- Row 1c: admin approves the just-published pending submission ---------
  // Without this, every read/install after this point targets a row that is still
  // `pending` and structurally invisible (D-4).
  const approveResult = await approvePendingSubmission(
    adminSession,
    teamALicenseKey,
    publishedSkillId,
    '1.0.0'
  )
  record('row1c-admin-approve', approveResult.success === true, approveResult.error ?? 'approved')
}
