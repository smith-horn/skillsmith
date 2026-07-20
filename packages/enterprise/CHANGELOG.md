# Changelog

All notable changes to `@smith-horn/enterprise` are documented here.

## [Unreleased]

## v0.3.3

- **Chore**: bump @aws-sdk/client-cloudwatch-logs (#1858)
- **Chore**: bump the smithy group across 1 directory with 8 updates (#1860)
- **Chore**: bump the opentelemetry group across 1 directory with 8 updates (#1862)
- **Fix**: `@module` JSDoc tags across `src/audit/*.ts` and `src/index.ts` now name the package's real, published name, `@smith-horn/enterprise` — previously self-referenced `@skillsmith/enterprise`, a name that has never existed (SMI-5738; doc-comments only, see `@skillsmith/mcp-server`/`@skillsmith/cli` for the actual runtime import fix)
- **Change**: `compliance_reports` moved from `EnterpriseFeatureFlag`/`ENTERPRISE_ONLY_FEATURES` to `TeamFeatureFlag`/`TEAM_FEATURES` (`FeatureFlags.ts`, `TierMapping.ts`, `types.ts`) — expanded from Enterprise-only to Team + Enterprise (SMI-3140)

## v0.3.2

- **Cadence**: Mechanical cadence alignment (no changes since v0.3.1).

## v0.3.1

- **Cadence**: Mechanical cadence alignment (no changes since v0.3.0).
- **Fix**: reduced tier quota constants 10x (SMI-5558) — Community was 1,000/mo now 100/mo, Individual was 10,000/mo now 1,000/mo, Team was 100,000/mo now 10,000/mo. Not currently wired into shipped CLI/MCP runtime; kept in lockstep with the other tier-quota constants.

## v0.3.0

- **Cadence**: Mechanical cadence alignment (no changes since v0.2.0).

## [0.2.0] — 2026-06-02

### Added

- **Quota module** (SMI-5120 / new): new top-level `@smith-horn/enterprise` export now includes `QuotaEnforcementService`, `createQuotaEnforcementService`, `QuotaCheckResult`, `UsageSummary` from the new `src/quota/` module. Enforces per-tier API call limits at runtime.
- **Billing module relocated from `@skillsmith/core/billing`** (SMI-5006): new subpath export `@smith-horn/enterprise/billing` ships `StripeClient`, `BillingService`, `StripeWebhookHandler`, `GDPRComplianceService`, `StripeReconciliationJob`, and associated types. `stripe@20.3.0` added as a runtime dependency. Migration: update imports from `@skillsmith/core/billing` to `@smith-horn/enterprise/billing`. Companion note in `@skillsmith/core` 0.7.0 (BREAKING — no shim shipped; consumers must update imports at the same time as the core bump).
- **Audit scheduled-scan exports** (SMI-4590): `runScheduledScan`, `ScheduledScanError`, `stripUrlSecrets`, `ScheduledScanOptions`, `ScheduledScanOutput`, `ScheduledScanResult`, `ScheduledScanErrorCode` exported from `@smith-horn/enterprise/audit`. Enterprise governance runner for scheduled security scans.
- **CloudWatch exporter** (SMI-959): `CloudWatchExporter` and helpers added to audit module, enabling streaming of audit events to AWS CloudWatch Logs.
- **License quota utilities**: `TIER_QUOTAS`, `WARNING_THRESHOLDS`, `WARNING_CONFIG`, `DORMANT_ACCOUNT_DAYS`, `BILLING_PERIOD_DAYS`, `getQuotaLimit`, `isUnlimited`, `getWarningLevel`, `getWarningConfig`, `getTierPriceDisplay`, `getQuotaDisplay`, `getUpgradeRecommendation`, `buildUpgradeUrl`, `TierQuotaConfig`, `WarningThreshold`, `WarningConfig` re-exported from `@smith-horn/enterprise/license`.
- **New license types and constants**: `IndividualFeatureFlag`, `LicenseQuotas`, `INDIVIDUAL_FEATURES` added to `@smith-horn/enterprise/license` exports.

### Changed

- **`StripeWebhookHandler` implements `StripeWebhookHandlerContract`** (SMI-5044 / SMI-5119): compile-time assignability guarantee for the structural surface consumed by `@skillsmith/mcp-server`. Contract now owned locally at `src/billing/webhook-contract.ts` and exported from `@smith-horn/enterprise/billing`. `StripeWebhookHandlerContract` and `StripeWebhookResult` are now public API. No `@skillsmith/billing-types` dependency (that package was unpublishable via OIDC trusted-publishing and has been removed).
- **`@skillsmith/core` dep range widened to `^0.8.0`** (was `^0.7.2`): the previous ceiling (`<0.8.0`) blocked resolution of `core@0.8.0` already published to GitHub Packages.

### Fixed

- **`@skillsmith/core` dep range history**: bumped through `^0.5.8` (SMI-4563 native SQLite driver auto-install via `optionalDependencies`) then `^0.7.0` (consumes `createLogger` / `Logger` re-export from core 0.7.0). All accumulated intermediate bumps now reflected in this published release.
