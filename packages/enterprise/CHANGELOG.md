# Changelog

All notable changes to `@smith-horn/enterprise` are documented here.

## [Unreleased]

## v0.2.1

- **Fix**: add missing [Unreleased] stub to CHANGELOG post-0.2.0 release (SMI-5154 retro)

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
