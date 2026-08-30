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

export { ManifestManager } from '../services/skill-manifest.js'

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
