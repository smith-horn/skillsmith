/**
 * Service Exports — Install/Adoption
 * @module exports/services.install
 *
 * Split out of services.ts (SMI-6274 Wave 4, file-length gate) — skill
 * installation, adoption, and discovery-tool-consistency exports. Re-exported
 * from services.ts so `@skillsmith/core`'s root barrel is unaffected.
 */

// ADR-139 (SMI-6274 Wave 4): reconstructs a manifest entry for a skill on
// disk with no manifest record ("adoption"). Re-exported at the root for
// the identical mockability reason as the pair above — `manage.update.ts`'s
// own adoption path reuses this SAME logic as `performUninstall`'s, not a
// second copy that could drift.
//
// GPT-5.6-Sol PR review round 4: `adoptUntrackedSkillEntry` (the race-safe
// updateSafely() wrapper around buildAdoptedManifestEntry, above) is
// re-exported alongside it for the same reason — `performUninstall` calls
// it directly (same file), `getSkillDiff` (`manage.update.ts`) calls it via
// this root export, so there is exactly ONE race-safe adoption-write
// implementation, not a CLI-package-local copy that can drift from it.
export {
  buildAdoptedManifestEntry,
  adoptUntrackedSkillEntry,
  type AdoptUntrackedSkillOptions,
  type AdoptUntrackedSkillResult,
} from '../services/skill-installation.uninstall.js'

// ============================================================================
// Billing (SMI-1062 to SMI-1070) — RELOCATED in SMI-5006 (core 0.7.0)
// ============================================================================
//
// BREAKING: The billing module was moved to `@smith-horn/enterprise/billing`.
// Both the root re-exports that previously lived here and the `./billing`
// subpath shim were removed. Consumers must update imports:
//
//   - Before: import { StripeWebhookHandler } from '@skillsmith/core/billing'
//   - After:  import { StripeWebhookHandler } from '@smith-horn/enterprise/billing'
//
// Stripe is no longer a runtime dependency of @skillsmith/core (removed in a
// follow-up wave); applications wanting billing functionality must depend on
// @smith-horn/enterprise directly. createLogger / Logger are exported from the
// core barrel (see ../index.ts) to support enterprise's billing consumers.

// ============================================================================
// Skill Installation (SMI-3483: Wave 0)
// ============================================================================

export {
  SkillInstallationService,
  type SkillInstallationServiceParams,
} from '../services/skill-installation.service.js'

// SMI-6733 MAJOR 3: `installedSkillsOf` is exported because the crash it
// prevents is not confined to `@skillsmith/core` — `apply_manifest_reconcile`
// dereferences `manifest.installedSkills` from mcp-server on a document it
// got from `ManifestManager.load()`, which now classifies a nullish
// `installedSkills` as `ok`. One accessor rather than an `?? {}` per call
// site, for the same reason `assertNotRealUserHome` is shared: four copies of
// a guard is four things to regress.
export {
  ManifestManager,
  assertNotRealUserHome,
  installedSkillsOf,
} from '../services/skill-manifest.js'

// ADR-171 (SMI-6733 Phase 1): the two named read-state policy wrappers, for
// mcp-server/cli consumers migrating off ad-hoc `catch {}` manifest reads
// (Phase 2). Deliberately NOT exporting `readManifestState` (the raw
// classifier) here — ADR-171 § 4's Open Risk 3 finding: a barrel re-export
// under a name that gives no hint it resolves to the classifier is exactly
// how `outdated.action.ts` reached the OLD fail-open `loadManifest` without
// ever writing that name in its own file. Only the two wrappers and the
// error type they throw belong on this package's public surface.
export {
  loadManifestForWrite,
  loadManifestLenient,
  ManifestUnwritableError,
  type ManifestReadState,
  type ManifestCorruptKind,
  type ManifestLenientRead,
} from '../services/skill-manifest.read-state.js'

// SMI-6529 L20 (round 2): exported so mcp-server's `install.ts` conflict
// pre-flight can run the SAME pre-write target guard `install()` itself runs
// internally, BEFORE any backup/GC side effect — see that call site's own
// comment for why running it first matters.
export {
  checkInstallTarget,
  type CheckInstallTargetParams,
  type CheckInstallTargetResult,
} from '../services/skill-installation.target-guard.js'

export {
  TRUST_TIER_SCANNER_OPTIONS as INSTALL_TRUST_TIER_SCANNER_OPTIONS,
  type ProgressCallback,
  type InstallOptions,
  type InstallResult as CoreInstallResult,
  type InstallErrorCode,
  // SMI-5905 Wave 1: content-based install path (private registry).
  type SkillContent,
  type InstallFromContentOptions,
  type UninstallOptions,
  type UninstallResult as CoreUninstallResult,
  type SkillManifest,
  type SkillManifestEntry,
  type RegistrySkillInfo,
  type RegistryLookup,
  type CoInstallRecorder,
  type DepIntelResult,
  type OptimizationInfo as CoreOptimizationInfo,
  type ConflictAction as CoreConflictAction,
  type AiDefenceFeedback,
} from '../services/skill-installation.types.js'

export {
  recordAiDefenceFeedback,
  collectTrendWarnings,
} from '../services/skill-installation.feedback.js'

// ============================================================================
// Identity Classification (SMI-6343 Wave 3)
// ============================================================================

// Shared three-signal contradiction classification, consumed by BOTH
// mcp-server (`outdated.identity.ts`) and cli (`manage.update.helpers.ts`)
// so the two packages cannot drift into two independently-maintained
// implementations of the same logic.
export {
  parseOwnerFromSource,
  parseOwnerFromId,
  detectOwnerMismatch,
  detectPathUnresolved,
  classifyManifestEntryIdentity,
  hasRecordedLocalEdit,
  classifyDivergentEntry,
  classifyOutdatedState,
  type IdentitySignal,
  type IdentityInconclusiveReason,
  type OutdatedClassificationState,
  type IdentityRegistryRecord,
  type RegistryLookupOutcome,
  type ManifestEntryForIdentity,
  type IdentityClassificationResult,
  type DivergentEntryClassification,
} from '../services/skill-identity-classification.js'

// ============================================================================
// Discovery-Tool Consistency (SMI-5896: Wave 3)
// ============================================================================

export {
  resolveSkillApiFirst,
  type ResolvedSkill,
  type ResolveSkillOptions,
} from '../services/skill-resolution.js'

export {
  buildEmptyStackGuidance,
  getRecommendAutoDetectedFooterText,
} from '../services/recommend-guard.js'

// SMI-5986: shared context-word extraction (CLI `recommend --context` / MCP
// `skill_recommend`'s `project_context`) so the two twins can't
// independently drift on what counts as noise vs. a real short technical
// term.
export { extractContextWords } from '../services/context-words.js'
