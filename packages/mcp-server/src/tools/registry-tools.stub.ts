/**
 * @fileoverview In-memory stub for the private registry MCP tools
 * @module @skillsmith/mcp-server/tools/registry-tools.stub
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 * @see SMI-5905 Wave 3: the stub now persists `content`, so a publish→install round-trip is
 *      testable without live Supabase
 *
 * Local-dev / test fallback used when Supabase is NOT configured. The real, Postgres-backed
 * implementation lives in registry-tools.live.ts and is selected automatically once SUPABASE_URL +
 * SUPABASE_ANON_KEY are present.
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
 *   - **SMI-5949 approval-gate state machine.** `publish()` below sets `approvalStatus:'approved'`,
 *     `approvalMode:'auto'` unconditionally — i.e. it always behaves like a pre-approval-gate
 *     publish, never like the `pending`/`review` state a real post-migration publish now lands in.
 *     This is the minimum edit needed for the stub to satisfy `RegistrySkill`'s two new fields
 *     (type safety only); it deliberately does NOT model `pending` invisibility. `submissions()`/
 *     `review()` below are, likewise, interface-completeness stubs ONLY — no self-approval
 *     refusal, no admin gating, no terminal-state enforcement, and `review()` never fails. Real
 *     coverage of all of that lives against the LIVE service (`registry-tools.live.test.ts` /
 *     `.review-action.test.ts`), which is what the D-5 RPCs actually enforce. Full stub state-
 *     machine parity (so a stub-only test could exercise the same failure paths) is Wave 2 Step
 *     5's job, tracked separately — a test that passes against this stub proves nothing about the
 *     approval gate's enforcement.
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

/** @internal Exported for testing */
export function createStubRegistryService(): PrivateRegistryService {
  // Keyed by `${teamId}::${skillId}` so the stub never leaks across teams.
  const registry = new Map<string, RegistrySkill>()
  const key = (teamId: string, skillId: string): string => `${teamId}::${skillId}`

  // Every published version's content, keyed by `${teamId}::${skillId}::${version}`.
  const versions = new Map<string, StubVersion>()
  const versionKey = (teamId: string, skillId: string, version: string): string =>
    `${key(teamId, skillId)}::${version}`
  let publishSequence = 0

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
      const skill: RegistrySkill = {
        skillId,
        version,
        description: description ?? null,
        deprecated: false,
        publishedAt,
        publishedBy: 'current-user',
        registryUrl: `https://registry.skillsmith.app/private/${teamId}/${skillId}@${version}`,
        // SMI-5949 Wave 2 Step 2: unconditional, pre-approval-gate values — see the header's
        // "does not do" list. Full state-machine modeling is Wave 2 Step 5, done separately.
        approvalStatus: 'approved',
        approvalMode: 'auto',
      }
      registry.set(key(teamId, skillId), skill)
      versions.set(versionKey(teamId, skillId, version), {
        teamId,
        skillId,
        version,
        content,
        publishedAt,
        sequence: ++publishSequence,
      })
      return skill
    },

    async list(teamId, version) {
      const all = [...registry.entries()]
        .filter(([k]) => k.startsWith(`${teamId}::`))
        .map(([, v]) => v)
      if (version) return all.filter((s) => s.version === version)
      return all
    },

    async get(teamId, skillId, version) {
      const skill = registry.get(key(teamId, skillId))
      if (!skill) return null
      if (version && skill.version !== version) return null
      return skill
    },

    // Same version semantics as the live service: an explicit `version` pins it, otherwise the
    // most recently published wins. Returns null (never throws) for an absent skill/version, so
    // the install handler's not-found branch behaves identically in stub and live mode.
    async getContent(teamId, skillId, version): Promise<RegistrySkillContent | null> {
      const entry = version
        ? versions.get(versionKey(teamId, skillId, version))
        : latestVersion(teamId, skillId)
      if (!entry) return null
      const metadata = registry.get(key(teamId, skillId))
      return {
        skillId: entry.skillId,
        version: entry.version,
        teamId: entry.teamId,
        content: entry.content,
        // No content_hash trigger backs the stub; null is honest, a fabricated digest would not be.
        contentHash: null,
        deprecated: metadata?.deprecated ?? false,
        publishedAt: entry.publishedAt,
      }
    },

    async deprecate(teamId, skillId) {
      const skill = registry.get(key(teamId, skillId))
      if (!skill) return false
      skill.deprecated = true
      return true
    },

    async undeprecate(teamId, skillId) {
      const skill = registry.get(key(teamId, skillId))
      if (!skill) return false
      skill.deprecated = false
      return true
    },

    // Interface-completeness only — see this file's header. `publish()` above never lands
    // anything but 'approved'/'auto' in stub mode, so this is `list()` with an optional status
    // filter that (honestly) only ever matches 'approved'.
    async submissions(teamId, status) {
      const all = [...registry.entries()]
        .filter(([k]) => k.startsWith(`${teamId}::`))
        .map(([, v]) => v)
      return status ? all.filter((s) => s.approvalStatus === status) : all
    },

    // Interface-completeness only — see this file's header. No self-approval refusal, no admin
    // gating, no terminal-state check: this unconditionally applies the requested decision.
    async review(teamId, skillId, version, decision, note): Promise<RegistryReviewDecision> {
      const skill = registry.get(key(teamId, skillId))
      if (!skill || skill.version !== version) {
        throw new Error(`Skill "${skillId}@${version}" not found in private registry.`)
      }
      skill.approvalStatus = decision
      skill.approvalMode = 'review'
      return {
        skillId,
        version,
        approvalStatus: decision,
        approvedBy: 'current-user',
        approvedAt: new Date().toISOString(),
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
  }
}
