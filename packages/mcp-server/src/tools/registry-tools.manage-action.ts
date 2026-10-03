/**
 * @fileoverview `private_registry_manage` action-switch body
 * @module @skillsmith/mcp-server/tools/registry-tools.manage-action
 * @see registry-tools.ts, whose `executePrivateRegistryManageImpl` resolves the team/credential
 *   source and the module's `service` singleton, then delegates the whole action switch here —
 *   split out (SMI-6622 round 3) to keep `registry-tools.ts` comfortably under the pre-commit
 *   500-line file-length gate, the same reason `install`/`submissions`/`approve`/`reject` already
 *   delegate to their own companion files (`registry-tools.install-action.ts`,
 *   `registry-tools.review-action.ts`) instead of living inline here.
 *
 * `service` is received as a plain parameter, not re-fetched via a getter imported from
 * registry-tools.ts — this is deliberate, and load-bearing for correctness: `registry-tools.ts`'s
 * own `executePrivateRegistryManageImpl` reads its module-level `service` singleton fresh on every
 * call (through `dataSourceFor(service)` and the value it passes down here), so the singleton is
 * still read AT CALL TIME, never captured once at import time — `setPrivateRegistryService()`'s
 * test/production swap keeps working exactly as before. Fetching it via a getter imported from
 * registry-tools.ts here instead would also create a value-level circular import between the two
 * files; a plain parameter avoids that entirely (this file's only reference to registry-tools.ts
 * is the `import type` below, which is fully erased at compile time).
 */

import type { ToolContext } from '../context.js'
import type { PrivateRegistryManageResult, PrivateRegistryService } from './registry-tools.js'
import type { PrivateRegistryManageInput } from './registry-tools.schemas.js'
import type { RegistryCredentialSource } from './registry-tools.team.js'
import { membershipOverrideError } from './registry-tools.membership-check.js'
import { executeRegistryInstall } from './registry-tools.install-action.js'
import {
  executeRegistrySubmissions,
  executeRegistryReview,
} from './registry-tools.review-action.js'
import { registrySkillNotFoundMessage } from './registry-tools.content.types.js'

/**
 * Execute the `private_registry_manage` action switch. `teamId`/`credentialSource`/`dataSource`
 * are already resolved by the caller (registry-tools.ts); `service` is that same call's current
 * singleton value, passed straight through.
 */
export async function executePrivateRegistryManageAction(params: {
  input: PrivateRegistryManageInput
  context: ToolContext
  teamId: string
  credentialSource: RegistryCredentialSource
  dataSource: 'stub' | 'live'
  service: PrivateRegistryService
}): Promise<PrivateRegistryManageResult> {
  const { input, context, teamId, credentialSource, dataSource, service } = params

  // Wrap service calls so live-mode errors (e.g. missing service-role key) surface
  // as typed {success:false} results instead of propagating as unhandled exceptions.
  try {
    switch (input.action) {
      case 'list': {
        const skills = await service.list(teamId, input.version, input.includeDeprecated)
        // SMI-6622 round 2 finding 3 / round 4 PR-07: an empty live list also means "not a
        // member" (RLS hides every row identically either way) — overridden when membership is
        // positively ruled out OR when the probe itself could not run (a network outage or
        // expired JWT must never look identical to a genuinely empty registry — see
        // registry-tools.membership-check.ts's own header for the round-4 fix). Only a confirmed
        // MEMBER leaves this empty-list result standing.
        if (dataSource === 'live' && skills.length === 0) {
          const override = await membershipOverrideError(teamId, credentialSource)
          if (override) return { success: false, dataSource, error: override }
        }
        return {
          success: true,
          dataSource,
          skills,
          message: `Found ${skills.length} skill(s) in private registry.`,
        }
      }

      case 'get': {
        if (!input.skillId) {
          return { success: false, dataSource, error: 'skillId is required for action "get".' }
        }
        const skill = await service.get(teamId, input.skillId, input.version)
        if (!skill) {
          // Non-leaking (plan-review finding M11): the same message covers "does not exist",
          // "wrong team", and "exists but is pending/rejected and therefore RLS-invisible" — a
          // caller must not be able to distinguish those from this response.
          return {
            success: false,
            dataSource,
            error: registrySkillNotFoundMessage(input.skillId),
          }
        }
        return { success: true, dataSource, skill }
      }

      // SMI-5905 Wave 3. Handler lives in a companion file (this one was 466/500 lines).
      // `await` is load-bearing here (SMI-5949 Wave 2 Step 4 finding): `return promise` inside a
      // try block does NOT let a rejection reach this function's own `catch` below — the promise
      // adoption happens outside the try/catch's synchronous scope, so an unawaited rejection
      // bypasses it and becomes an unhandled rejection at the caller instead of a typed
      // {success:false} result. Confirmed empirically; applies to every delegating case below too.
      case 'install':
        return await executeRegistryInstall({ input, teamId, dataSource, service, context })

      case 'deprecate': {
        if (!input.skillId) {
          return {
            success: false,
            dataSource,
            error: 'skillId is required for action "deprecate".',
          }
        }
        const deprecated = await service.deprecate(teamId, input.skillId)
        if (!deprecated) {
          return {
            success: false,
            dataSource,
            error: registrySkillNotFoundMessage(input.skillId),
          }
        }
        return {
          success: true,
          dataSource,
          // SMI-5949 Wave 3: corrected from "will no longer appear in search results" — the
          // private registry has no search surface at all (Context § "precedent warning" in the
          // plan doc). This is the actual, now-enforced behavior: `list`/`get`/`install` (both the
          // MCP and Edge Function transports) all carry a `deprecated = FALSE` predicate with no
          // per-call bypass, so an approved-then-deprecated version is invisible everywhere,
          // including to a caller who already knows its exact skillId+version.
          //
          // SMI-5949 adversarial-review corrections (M-1, M-3): this UPDATE has no `.eq('version',
          // …)`, but PostgreSQL applies the SELECT policy to it too (migration
          // 20260809000000_private_registry_approval_gate.sql:78-86), so it only ever actually
          // affects this skillId's currently-APPROVED row(s) — a `pending`/`rejected` sibling
          // version, if one exists, is untouched by this call and can still be independently
          // approved and installed later, regardless of this deprecation. And the
          // `includeDeprecated:true` opt-in is NOT admin-gated — it is a plain, unauthenticated
          // query parameter on `list()`, checked nowhere against role (see
          // `registry-tools.live.reads.ts`'s own doc comment on `listSkills()`), so any team
          // member can pass it, not only a team admin. Since SMI-6109, `list()` runs on the
          // signed-in user's own JWT, not the shared license key — so the message below says
          // "signed-in team member," not "anyone holding the license key."
          message: `Skill "${input.skillId}" has been deprecated. Its approved version(s) will no longer be returned by list, get, or install — even by an exact version — for any team member; a separate pending or rejected version of this skillId, if one exists, is unaffected. Any signed-in team member can still see deprecated versions via private_registry_manage {action:'list', includeDeprecated:true} — this is not restricted to team admins.`,
        }
      }

      case 'undeprecate': {
        if (!input.skillId) {
          return {
            success: false,
            dataSource,
            error: 'skillId is required for action "undeprecate".',
          }
        }
        const undeprecated = await service.undeprecate(teamId, input.skillId)
        if (!undeprecated) {
          return {
            success: false,
            dataSource,
            error: registrySkillNotFoundMessage(input.skillId),
          }
        }
        return {
          success: true,
          dataSource,
          // SMI-5949 Wave 3: same correction as the deprecate message above — "search results" was
          // never accurate for a private registry with no search surface.
          message: `Skill "${input.skillId}" has been undeprecated and is visible again via list, get, and install.`,
        }
      }

      // SMI-5852, AC-11: discover the team's publish namespace without attempting a
      // publish (the required skill_id prefix, e.g. "acme" for "acme/my-skill").
      case 'namespace': {
        const namespace = await service.getNamespace(teamId)
        if (!namespace) {
          // getNamespace() never throws, so "not logged in" and "genuinely unconfigured" both
          // collapse to this one message (unlike list/get's actionable login error) — hinting at
          // login here is a partial fix for that UX gap (SMI-6109 cross-provider review).
          // SMI-6622 round 2 finding 3 / round 4 PR-07: confirmed non-membership AND a failed
          // membership probe (network outage, expired JWT, any other transport/query error) each
          // get their own, more specific message — a failed probe must never fall through to the
          // generic "unable to resolve" text below as if nothing had gone wrong differently.
          if (dataSource === 'live') {
            const override = await membershipOverrideError(teamId, credentialSource)
            if (override) return { success: false, dataSource, error: override }
          }
          return {
            success: false,
            dataSource,
            error:
              "Unable to resolve this team's private registry namespace. If you haven't run " +
              '`skillsmith login` yet, do that and try again.',
          }
        }
        return {
          success: true,
          dataSource,
          namespace,
          message: `Your team's private registry namespace is "${namespace}".`,
        }
      }

      // SMI-5949 D-5/D-12 — handlers in a companion file, same reason 'install' is. `await`
      // is load-bearing — see the comment on 'install' above.
      case 'submissions':
        return await executeRegistrySubmissions({ input, teamId, dataSource, service })

      case 'approve':
      case 'reject':
        return await executeRegistryReview({ input, teamId, dataSource, service })
    }
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Registry operation failed.',
    }
  }
}
