# Changelog

All notable changes to `@smith-horn/enterprise` are documented here.

## [Unreleased]

- **Chore**: SMI-5044 — `StripeWebhookHandler` class now `implements
  StripeWebhookHandlerContract` from the new types-only
  `@skillsmith/billing-types` package, providing a compile-time assignability
  guarantee between the canonical runtime class here and the structural
  surface consumed by `@skillsmith/mcp-server`. Adds
  `@skillsmith/billing-types@^0.1.0` as a runtime dep. Belt-and-suspenders:
  `tests/billing/StripeWebhookHandler.assignability.test.ts` asserts the same
  at the test layer. Resolves the workspace cycle previously documented in
  the inline interface at `packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts`.
- **Feature**: SMI-5006 — billing module relocated from `@skillsmith/core/billing`. New subpath export `@smith-horn/enterprise/billing` ships `StripeClient`, `BillingService`, `StripeWebhookHandler`, `GDPRComplianceService`, `StripeReconciliationJob`, plus the associated types. `stripe@20.3.0` added as a runtime dep. Migration: change imports from `@skillsmith/core/billing` to `@smith-horn/enterprise/billing`. Companion CHANGELOG note in `@skillsmith/core` 0.7.0 (BREAKING — the subpath shim was not shipped, so consumers must update imports at the same time as the core bump). Three pre-existing strict-mode errors are suppressed via `exactOptionalPropertyTypes: false` / `noUncheckedIndexedAccess: false` / `noPropertyAccessFromIndexSignature: false` in `tsconfig.json`; restoration is tracked as a follow-up issue. `@skillsmith/core` dep range tightened to `^0.7.0` (consumes the new `createLogger` / `Logger` re-export).
- **Bump**: `@skillsmith/core` dep range to `^0.5.8` — pulls in SMI-4563 native SQLite driver auto-install via `optionalDependencies`. Enterprise package's own version unchanged; downstream installs will now resolve `core@0.5.8` with native better-sqlite3 by default instead of WASM fallback.
