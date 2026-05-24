# Changelog

All notable changes to `@smith-horn/enterprise` are documented here.

## [Unreleased]

## v0.1.3

- **Cadence**: Mechanical cadence alignment (no changes since v0.1.2).
- **Chore**: SMI-5044 / SMI-5119 — `StripeWebhookHandler` class `implements
  StripeWebhookHandlerContract`, providing a compile-time assignability
  guarantee for the structural surface consumed by `@skillsmith/mcp-server`.
  The contract is now owned locally at `src/billing/webhook-contract.ts` and
  exported from `@smith-horn/enterprise/billing`. SMI-5044 briefly placed it in
  a shared `@skillsmith/billing-types` package; that package was unpublishable
  (OIDC trusted-publishing requires a pre-existing npm package) and consumed
  only via `import type`, so SMI-5119 removed it and localized the contract —
  this keeps the published `.d.ts` self-contained (no dangling external module
  reference). Belt-and-suspenders:
  `tests/billing/StripeWebhookHandler.assignability.test.ts` asserts the same
  at the test layer. No `@skillsmith/billing-types` dependency.
- **Feature**: SMI-5006 — billing module relocated from `@skillsmith/core/billing`. New subpath export `@smith-horn/enterprise/billing` ships `StripeClient`, `BillingService`, `StripeWebhookHandler`, `GDPRComplianceService`, `StripeReconciliationJob`, plus the associated types. `stripe@20.3.0` added as a runtime dep. Migration: change imports from `@skillsmith/core/billing` to `@smith-horn/enterprise/billing`. Companion CHANGELOG note in `@skillsmith/core` 0.7.0 (BREAKING — the subpath shim was not shipped, so consumers must update imports at the same time as the core bump). Three pre-existing strict-mode errors are suppressed via `exactOptionalPropertyTypes: false` / `noUncheckedIndexedAccess: false` / `noPropertyAccessFromIndexSignature: false` in `tsconfig.json`; restoration is tracked as a follow-up issue. `@skillsmith/core` dep range tightened to `^0.7.0` (consumes the new `createLogger` / `Logger` re-export).
- **Bump**: `@skillsmith/core` dep range to `^0.5.8` — pulls in SMI-4563 native SQLite driver auto-install via `optionalDependencies`. Enterprise package's own version unchanged; downstream installs will now resolve `core@0.5.8` with native better-sqlite3 by default instead of WASM fallback.
