/**
 * @fileoverview In-memory stub for the private registry MCP tools
 * @module @skillsmith/mcp-server/tools/registry-tools.stub
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 * @see SMI-5905 Wave 3: the stub now persists `content`, so a publish→install round-trip is
 *      testable without live Supabase
 * @see SMI-5949 Wave 2 Step 5: the approval-gate state machine (D-5/D-6/D-7/D-8) is now modeled
 *      in memory, replicating the two RPCs' behavior — see `setActor()` below.
 * @see SMI-5949 Wave 3: `deprecated` read-filter closure — `list()`/`get()`/`getContent()` now
 *      also exclude deprecated rows, matching the live service's own D-4-adjacent predicate. Kept
 *      in parity deliberately: `registry-tools.cross-transport.test.ts` already treats
 *      "a deprecated skill still installs" as a cross-transport invariant driven through this
 *      stub, so leaving the stub unfiltered would make that test silently assert behavior the two
 *      live transports (registry-tools.live.content.ts, the Edge Function) no longer have.
 *
 * Local-dev / test fallback used when Supabase is NOT configured. The real, Postgres-backed
 * implementation lives in registry-tools.live.ts and is selected automatically once SUPABASE_URL +
 * SUPABASE_ANON_KEY are present (see `registry-tools.ts`'s `isSupabaseConfigured()` branch).
 *
 * WHAT THIS STUB DOES NOT DO, and must never be read as evidence about:
 *   - **Entitlement.** `getContent()` here has no Enterprise/subscription check at all. That gate
 *     is a live-service concern (registry-tools.live.content.ts) because it is a query against
 *     `teams`/`subscriptions`, which the stub has no analogue of. A test that passes against this
 *     stub proves nothing about entitlement; those tests drive the live service instead.
 *   - **Version immutability.** The real table's UNIQUE(team_id, skill_id, version) is what
 *     enforces that; re-publishing the same triple here just overwrites.
 *   - **RLS / cross-team isolation.** Approximated only: entries are keyed by (teamId, skillId) so
 *     list/get/deprecate/getContent never cross a team boundary, but there is no policy engine
 *     behind it.
 *   - **SMI-5949 approval-gate state machine — now modeled (Wave 2 Step 5).** `publish()` lands
 *     every row `approvalStatus:'pending'`, `approvalMode:'review'`, matching D-7's unconditional
 *     gate (nothing here auto-approves). `list()`/`get()` only ever return `'approved'` rows,
 *     matching D-4 surfaces 3/4's `.eq('approval_status','approved')` predicate. `submissions()`/
 *     `review()` replicate `get_private_registry_submissions()`'s visibility rule and
 *     `review_private_registry_submission()`'s D-5 check order EXACTLY: decision value -> caller
 *     identity present -> admin-membership -> row-exists -> terminal-state -> `published_by`
 *     non-null -> self-approval (D-6/D-8). `setActor()` (below, NOT part of `PrivateRegistryService`
 *     — a stub-only test seam) simulates `auth.uid()` + team-admin membership, since the stub has
 *     no real JWT or RLS to derive either from.
 *
 *     What is STILL not modeled, and cannot be without a real Postgres behind it:
 *     - **RLS-based pending invisibility.** A real pending row has NO PostgREST read path at all —
 *       not even a query that tries; the policy itself is the enforcement. This stub only
 *       APPROXIMATES that with an application-level `approvalStatus === 'approved'` filter inside
 *       `list()`/`get()`/`getContent()`/`submissions()` (the `getContent()` filter was ITSELF a
 *       missing-filter bug until an adversarial security review caught it, finding H-1: a pending
 *       row's CONTENT installed successfully even though its metadata was already correctly
 *       gated — the exact omission this paragraph warns a "future new stub method" could make,
 *       except it was an existing one) — a filter a future new stub method could still simply omit, in
 *       exactly the shape `deprecated`'s unenforced read filter already demonstrates (Context §
 *       "precedent warning" in the plan doc). A real policy cannot be forgotten at a new call site;
 *       this filter can, and there is no compiler or test that would catch a stub-only omission of
 *       it the way the live RLS policy is proven by the Wave 1 migration smoke suite + staging
 *       harness (P-4).
 *     - **D-7's BEFORE INSERT trigger.** `publish()` never rejects a null-identity `setActor()`
 *       actor — a real post-migration INSERT with NULL `published_by` is hard-rejected `23514` at
 *       write time, so in live Postgres no NEW row can ever reach review with a null submitter
 *       (D-5 step 6 is pure defense-in-depth there). This stub deliberately does NOT replicate that
 *       trigger in `publish()` — doing so would make step 6 unexercisable in a stub-only test, and
 *       the trigger itself is proven by the Wave 1 smoke suite's `a5`, not by this file.
 *     - **Per-version approval state.** `registry` (this file's metadata map) has always held one
 *       row per `(teamId, skillId)` — the most recently published version's metadata — regardless
 *       of how many versions exist (a pre-existing simplification, not introduced by Step 5;
 *       `versions`, the separate content map, stays correctly per-version). Publishing a second
 *       version of an already-pending skill overwrites the first version's approval state rather
 *       than tracking each version independently.
 *     - **Multi-admin/multi-member team shape.** One simulated actor per stub instance, not a
 *       roster — there is no "this team has exactly one admin, who is also the submitter" concept
 *       to check the D-9 single-admin-deadlock scenario against.
 */

import type { PrivateRegistryService, RegistrySkill, SkillContent } from './registry-tools.js'
import type { RegistrySkillContent } from './registry-tools.content.types.js'
import type { RegistryReviewDecision } from './registry-tools.review.types.js'

/** One published version's payload. Metadata for `list`/`get` lives in the separate skills map. */
interface StubVersion {
  teamId: string
  skillId: string
  version: string
  content: SkillContent
  publishedAt: string
  /**
   * Monotonic publish counter, used ONLY to break a `publishedAt` tie.
   *
   * `publishedAt` is `Date.now()`-derived and two publishes inside one test routinely land on the
   * same millisecond, which would otherwise make "most recently published" a coin flip. The live
   * service breaks such a tie by taking whichever equal-timestamp row its reduce sees first; the
   * stub breaks it by insertion order, which is what a test author means by "publish A, then
   * publish B". Documented rather than hidden, because it IS a behavioral difference.
   */
  sequence: number
}

/**
 * The raw, possibly-null metadata row — mirrors `PrivateRegistrySkillRow` (registry-tools.live.ts):
 * a `publishedBy` that CAN be null, distinct from the always-display-ready `RegistrySkill` the
 * public methods return (which coerces an absent publisher to `'unknown'`, same as live's own
 * `mapRow()`). Kept as an internal type so `RegistrySkill.publishedBy`'s public shape (`string`,
 * never `null`) does not have to change to support D-5 step 6's null-published_by check.
 */
interface StubSkillRow {
  skillId: string
  version: string
  description: string | null
  deprecated: boolean
  publishedAt: string
  publishedBy: string | null
  approvalStatus: 'pending' | 'approved' | 'rejected'
  approvalMode: 'review' | 'auto'
}

/** The simulated caller identity `setActor()` sets — the stub's substitute for a real `auth.uid()`
 *  plus `user_admin_team_ids()` membership, since there is no JWT or RLS behind this stub. */
export interface StubActor {
  /** Simulated `auth.uid()`. `null` simulates "no signed-in user" (D-5 step 2) — used both to
   *  exercise that check directly on `review()`, and, if set before `publish()`, to construct a
   *  row with a null `published_by` for D-5 step 6 (see this file's header on why `publish()`
   *  itself does not reject that, unlike the real D-7 trigger). */
  id: string | null
  /** Simulated `user_admin_team_ids()` membership (`role IN ('admin','owner')`) — D-5 step 3. */
  isAdmin: boolean
  /**
   * SMI-6202 Wave 1 widened the real gate from `user_admin_team_ids()` to
   * `has_team_permission(teamId, 'registry:approve')`, which ALSO returns true for a non-admin
   * member holding an explicit `team_permission_grants` allow row for that permission. This
   * simulates exactly that case — a member who is NOT `isAdmin` but has been individually
   * granted `registry:approve`. Defaults to `false` so every pre-existing test that never sets it
   * keeps the pre-widening (admin-only) behavior unless it opts in.
   */
  hasRegistryApproveGrant?: boolean
}

/**
 * `PrivateRegistryService` plus the stub-only `setActor()` identity seam. NOT part of the shared
 * interface — `registry-tools.ts` still types its module-level singleton as plain
 * `PrivateRegistryService`, so production code and every non-identity-aware test are unaffected.
 */
export interface StubRegistryService extends PrivateRegistryService {
  /**
   * Sets the identity behind every subsequent `publish()`/`review()`/`submissions()` call on this
   * stub instance, until changed again — mirrors a real session, where `skillsmith login` picks
   * one identity for every call that session makes. Defaults to a non-null, admin actor (see
   * `DEFAULT_ACTOR` below), so a fresh stub's `publish()` alone behaves as it always has; a test
   * exercising the review gate itself must call this explicitly before `review()`/`submissions()`,
   * same as the real smoke matrix requires a distinct admin login to approve someone else's
   * submission (D-6 blocks a reviewer approving their own).
   */
  setActor(actor: StubActor): void
}

/** A fresh stub's starting identity — admin, so `submissions()`/`review()` are usable without any
 *  setup for a caller who does not care about the D-5 identity checks specifically. Any test
 *  exercising self-approval, non-admin denial, or the missing-`published_by` case calls
 *  `setActor()` explicitly (see the JSDoc above). */
const DEFAULT_ACTOR: StubActor = { id: 'stub-actor-1', isAdmin: true }

function toRegistrySkill(teamId: string, row: StubSkillRow): RegistrySkill {
  return {
    skillId: row.skillId,
    version: row.version,
    description: row.description,
    deprecated: row.deprecated,
    publishedAt: row.publishedAt,
    // Same null-coalescing display convention as live's mapRow() — 'unknown' is a DISPLAY
    // sentinel; the raw `null` (D-5 step 6's case) still lives on `row.publishedBy` for the
    // review()/submissions() checks below, which must see the real null, not 'unknown'.
    publishedBy: row.publishedBy ?? 'unknown',
    registryUrl: `https://registry.skillsmith.app/private/${teamId}/${row.skillId}@${row.version}`,
    approvalStatus: row.approvalStatus,
    approvalMode: row.approvalMode,
  }
}

/** @internal Exported for testing */
export function createStubRegistryService(): StubRegistryService {
  // Keyed by `${teamId}::${skillId}` so the stub never leaks across teams.
  const registry = new Map<string, StubSkillRow>()
  const key = (teamId: string, skillId: string): string => `${teamId}::${skillId}`

  // Every published version's content, keyed by `${teamId}::${skillId}::${version}`.
  const versions = new Map<string, StubVersion>()
  const versionKey = (teamId: string, skillId: string, version: string): string =>
    `${key(teamId, skillId)}::${version}`
  let publishSequence = 0

  // SMI-5949 Wave 2 Step 5: the simulated caller — see StubActor/setActor() above.
  let actor: StubActor = DEFAULT_ACTOR

  /** The most recently published version of a skill, or undefined when none exist. */
  function latestVersion(teamId: string, skillId: string): StubVersion | undefined {
    const prefix = `${key(teamId, skillId)}::`
    let best: StubVersion | undefined
    for (const [k, entry] of versions) {
      if (!k.startsWith(prefix)) continue
      if (!best || entry.publishedAt > best.publishedAt) {
        best = entry
      } else if (entry.publishedAt === best.publishedAt && entry.sequence > best.sequence) {
        best = entry
      }
    }
    return best
  }

  return {
    async publish(teamId, skillId, version, content: SkillContent, description) {
      const publishedAt = new Date().toISOString()
      const row: StubSkillRow = {
        skillId,
        version,
        description: description ?? null,
        deprecated: false,
        publishedAt,
        // D-7: a real submitter identity (or, deliberately, null — see this file's header on why
        // publish() does not reject that the way the real trigger does).
        publishedBy: actor.id,
        // D-7/D-3: every publish lands pending/review, unconditionally — nothing here auto-
        // approves. Matches what a post-migration live publish now does for every Enterprise team.
        approvalStatus: 'pending',
        approvalMode: 'review',
      }
      registry.set(key(teamId, skillId), row)
      versions.set(versionKey(teamId, skillId, version), {
        teamId,
        skillId,
        version,
        content,
        publishedAt,
        sequence: ++publishSequence,
      })
      return toRegistrySkill(teamId, row)
    },

    // D-4 surface 3 (list): only 'approved' rows — the stub's approximation of the RLS predicate
    // (see this file's header on why it is an approximation, not the real thing). SMI-5949 Wave 3
    // adds the same deprecated=false predicate the live service carries, with the same
    // includeDeprecated opt-in — no equivalent opt-in on get()/getContent() below.
    async list(teamId, version, includeDeprecated) {
      const all = [...registry.entries()]
        .filter(([k]) => k.startsWith(`${teamId}::`))
        .map(([, row]) => row)
        .filter((row) => row.approvalStatus === 'approved')
        .filter((row) => includeDeprecated === true || !row.deprecated)
        .map((row) => toRegistrySkill(teamId, row))
      return version ? all.filter((s) => s.version === version) : all
    },

    // D-4 surface 4 (get): same 'approved'-only predicate as list() above, plus SMI-5949 Wave 3's
    // unconditional (no opt-in) deprecated exclusion.
    async get(teamId, skillId, version) {
      const row = registry.get(key(teamId, skillId))
      if (!row || row.approvalStatus !== 'approved' || row.deprecated) return null
      if (version && row.version !== version) return null
      return toRegistrySkill(teamId, row)
    },

    // Same version semantics as the live service: an explicit `version` pins it, otherwise the
    // most recently published wins. Returns null (never throws) for an absent skill/version, so
    // the install handler's not-found branch behaves identically in stub and live mode.
    //
    // SMI-5949 Wave 3: now excludes a deprecated skill entirely, matching the live service's own
    // getSkillContent() and the Edge Function — no opt-in, same as get() above. The stub only ever
    // tracks ONE metadata row per (teamId, skillId) — "the most recently published version's
    // metadata" (this file's header) — so unlike the live service's version-aware fallback to a
    // previous non-deprecated publish, this can only return null once that one tracked row is
    // deprecated; it cannot fall back to an older version's own (untracked) approval/deprecation
    // state. A documented approximation, same shape as every other "one row per skill, not per
    // version" limitation this file's header already lists.
    //
    // SMI-5949 adversarial-review fix (H-1): also excludes a non-`'approved'` skill, same D-4
    // predicate as list()/get() above. This was MISSING until this fix — `getContent()` had only
    // the `deprecated` check, so a `pending` (unapproved) version's content installed successfully
    // via this stub, which `registry-tools.cross-transport.test.ts` was asserting as a PASSING
    // invariant before that test was also corrected — the exact inverse of what the approval gate
    // exists to enforce. `list()`/`get()` never had this gap; only the content-read path did.
    async getContent(teamId, skillId, version): Promise<RegistrySkillContent | null> {
      const metadata = registry.get(key(teamId, skillId))
      if (!metadata || metadata.approvalStatus !== 'approved' || metadata.deprecated) return null
      const entry = version
        ? versions.get(versionKey(teamId, skillId, version))
        : latestVersion(teamId, skillId)
      if (!entry) return null
      return {
        skillId: entry.skillId,
        version: entry.version,
        teamId: entry.teamId,
        content: entry.content,
        // No content_hash trigger backs the stub; null is honest, a fabricated digest would not be.
        contentHash: null,
        deprecated: metadata.deprecated,
        publishedAt: entry.publishedAt,
      }
    },

    async deprecate(teamId, skillId) {
      const row = registry.get(key(teamId, skillId))
      if (!row) return false
      row.deprecated = true
      return true
    },

    async undeprecate(teamId, skillId) {
      const row = registry.get(key(teamId, skillId))
      if (!row) return false
      row.deprecated = false
      return true
    },

    // D-5 (get_private_registry_submissions): 'approved' rows to anyone; non-approved rows only to
    // their own submitter, the simulated admin actor, or (SMI-6202 Wave 1 widening) a member
    // holding an explicit registry:approve grant — the stub's approximation of the RPC's own
    // visibility rule (see this file's header: an approximation, not a real policy).
    async submissions(teamId, status) {
      const rows = [...registry.entries()]
        .filter(([k]) => k.startsWith(`${teamId}::`))
        .map(([, row]) => row)
        .filter(
          (row) =>
            row.approvalStatus === 'approved' ||
            (actor.id !== null && row.publishedBy === actor.id) ||
            actor.isAdmin ||
            actor.hasRegistryApproveGrant === true
        )
        .map((row) => toRegistrySkill(teamId, row))
      return status ? rows.filter((s) => s.approvalStatus === status) : rows
    },

    // D-5 (review_private_registry_submission) / D-6 (self-approval) / D-8 (terminal state).
    // Replicates the RPC's check ORDER exactly (plan-review finding M7) — not just the outcome:
    //   1. decision value -> 2. caller identity present -> 3. admin-membership -> 4. row exists ->
    //   5. terminal-state -> 6. published_by non-null -> 7. self-approval.
    async review(teamId, skillId, version, decision, note): Promise<RegistryReviewDecision> {
      // Step 1: TS's own union type already stops a well-typed caller from passing anything else;
      // replicated anyway so the check ORDER matches the RPC's, not just the eventual outcome.
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new Error(
          `Invalid decision "${String(decision)}" — must be "approved" or "rejected".`
        )
      }
      // Step 2: `auth.uid()` must be non-NULL — a service-role (no-identity) caller can never
      // approve. `actor.id === null` is this stub's simulation of that (see StubActor/setActor()).
      if (actor.id === null) {
        throw new Error(
          'A private-registry review requires a signed-in user — no caller identity is set on ' +
            'this stub. Call setActor() with a non-null id before review()/submissions().'
        )
      }
      // Step 3: admin-membership OR an explicit registry:approve grant (SMI-6202 Wave 1 widened
      // this from a plain `user_admin_team_ids()` check to `has_team_permission(teamId,
      // 'registry:approve')`), else 42501.
      if (!actor.isAdmin && actor.hasRegistryApproveGrant !== true) {
        throw new Error(
          'Only a team admin or owner, or a holder of an explicit registry:approve grant, may ' +
            'review private-registry submissions. Your account is a member of this team with ' +
            'neither — ask a team admin to run this, have them promote you, or have them grant ' +
            'you registry:approve.'
        )
      }
      // Step 4: row must exist. (Checked AFTER the admin gate, deliberately — see D-5: existence
      // is not leaked to a non-admin caller either.)
      const row = registry.get(key(teamId, skillId))
      if (!row || row.version !== version) {
        throw new Error(`Skill "${skillId}@${version}" not found in private registry.`)
      }
      // Step 5: terminal-state — approved/rejected can never be re-reviewed (D-8).
      if (row.approvalStatus !== 'pending') {
        throw new Error(
          `This submission has already been ${row.approvalStatus} and cannot be reviewed again ` +
            '— approved and rejected are both terminal decisions.'
        )
      }
      // Step 6: published_by must be non-null. The stub's own rows always have one by
      // construction (this file's header explains why publish() cannot land a null one through
      // normal use) — this branch exists for check-order parity with the live RPC, not because a
      // normal publish->review flow reaches it.
      if (row.publishedBy === null) {
        throw new Error(
          'This submission has no recorded submitter (published_by is NULL) and cannot be ' +
            'reviewed — it was published by a client older than the required version. Ask the ' +
            'submitter to upgrade and re-publish.'
        )
      }
      // Step 7: self-approval blocked (D-6) — the submitter may never review their own work, admin
      // or not.
      if (row.publishedBy === actor.id) {
        throw new Error(
          'You cannot approve your own submission. Ask another team admin to review it.'
        )
      }

      row.approvalStatus = decision
      const approvedAt = new Date().toISOString()
      return {
        skillId,
        version,
        approvalStatus: decision,
        approvedBy: actor.id,
        approvedAt,
        reviewNote: note ?? null,
      }
    },

    // No real `teams` table backs the stub, and existing stub-mode tests publish under
    // whatever skillId prefix they choose (the stub never enforced namespace shape) — so
    // this deliberately returns null ("unresolvable") rather than a fixed value that
    // would silently reject every one of those existing fixtures via the handler's
    // namespace pre-check. The live service (registry-tools.live.ts) is the real
    // implementation.
    async getNamespace(_teamId) {
      return null
    },

    setActor(next: StubActor): void {
      actor = next
    },
  }
}
