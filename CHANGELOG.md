# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: This project is in alpha (0.x). All packages use 0.x versioning.

## [Unreleased]

### Changed

- **Node.js floor bumped to >=22.22.0** (SMI-4489): root + every workspace
  now require Node 22.22.0+. The host install previously failed with
  EBADENGINE on Node 22.0–22.21 because `posthog-node@5.29.2` (transitive
  via `@skillsmith/core`) requires `>=22.22.0`. Tightening our own
  `engines` makes the constraint visible at our package boundary instead
  of at the deeper transitive resolution. Node 22 stays in Maintenance LTS
  until 2027-04-30; SMI-4491 tracks the eventual Node-24 evaluation.
  `.npmrc` (which contains `engine-strict=true`) is excluded from all
  published tarballs, so consumer EBADENGINE remains a warning rather
  than a hard install failure.
- **Removed `SKILLSMITH_MEMORY_DIR_OVERRIDE` doc-retrieval workaround**
  (SMI-4451 Followup-4): with the host Node bump, `homedir()` derivation
  resolves correctly and the `.tmp/host-memory/` staging path shipped in
  SMI-4473 is no longer needed.
- **Bumped `actions/setup-node` to v6 SHA in two more workflows**
  (`e2e-usage-counter.yml`, `deploy-edge-functions.yml`) to match the
  rest of the repo. SMI-4488's `device-login-roundtrip.yml` was bumped
  separately in PR #793.

### Added (SMI-4489)

- **`scripts/audit-standards.mjs` rule 37**: asserts every
  `actions/setup-node` step's `node-version` either references
  `${{ env.NODE_VERSION }}` or matches the workflow-local env declaration.
  Prevents future drift like the kind that motivated SMI-4488 + SMI-4489.

### Added

- **Team Tier-Gate** (2026-04-20, SMI-4321): Server-side tier-gate on
  `/account/team/**` pages. Downgraded or expired Team users are now
  redirected to `/account/subscription` with a contextual banner rather
  than retaining access until session invalidation. New `/account/team/analytics`
  stub page + Analytics nav tab. Backed by `check_team_tier_access` RPC
  (migration 078) reading live `profiles` / `subscriptions` / `team_members`
  state; includes `past_due` in the active whitelist to preserve Stripe's
  retry grace window (#663).
- **JWT Authentication for Website Users**: Logged-in users now automatically
  receive their subscription tier rate limits without needing to configure an API key.
  This provides a seamless experience where your subscription benefits apply immediately.
- **X-Auth-Method Header**: API responses now include the authentication method used
  (`jwt`, `api_key`, `anon_key`) for debugging and monitoring purposes.
- **Realtime Tier Updates**: Subscription tier upgrades now take effect within 5 seconds
  instead of waiting for cache expiration.
- **SubscriptionBadge Component**: New visual indicator for subscription tiers with
  WCAG AA accessible colors (purple for Individual, green for Team, gold for Enterprise).
- **Supply Chain Hardening** (2026-04-03): Pinned all external dependency versions
  across 14 CI workflows and Supabase edge functions for reproducible builds (#437).
- **PII Detection** (2026-04-04): New PII detection module with configurable pattern
  matching for emails, phone numbers, API keys, and credentials (#455).
- **Quality Scoring with Risk Trends** (2026-04-04): Quality scoring service with
  risk trend tracking and anomaly detection (20pt warning, 35pt critical thresholds) (#455).
- **Skill Config Validation** (2026-04-04): Schema validation for skill configuration
  files using Zod (#455).
- **Pre-Install Security Gate** (2026-04-04): Skills with high-severity security
  findings now require explicit user confirmation before installation (#450).
- **Supabase Staging Environment** (2026-04-03): Deploy scripts and validation
  tooling for staging environment (#448).
- **Two-Scanner Security Model** (2026-04-04): AIDefence (prompt injection, behavioral
  threats) and SecurityScanner (SSRF, jailbreak, structural) now both run on every
  skill assessment (#451).
- Indexer now indexes addyosmani/agent-skills as high-trust source (SMI-4122, PR #499).
- **Skill pack audit trigger-quality + namespace checks** (SMI-4124, PR #505): `skill_pack_audit` MCP tool now detects low-quality trigger phrases and namespace collisions in installed skill packs. Surfaces actionable findings before publish.
- **VS Code extension MCP feature parity Wave 1** (SMI-4194, PR #562): `skillsmith.uninstallSkill` command (palette + tree-view context menu, modal confirmation, symlink-escape protection via `assertInsideRoot`, MCP-first with `fs.rm` fallback); `skillsmith.createSkill` 4-step wizard (delegates to `@skillsmith/cli`, actionable error if CLI absent); anonymous usage telemetry with 3-gate opt-out (`vscode.env.isTelemetryEnabled`, `skillsmith.telemetry.enabled`, no hardcoded endpoint); non-blocking MCP server min-version check with copy-to-clipboard action; Get Started walkthrough (Discover / Install / Author steps); `audit:standards` Checks 27 (skillNameValidation codegen drift) and 28 (command–test pairing) added to CI. `events` edge function `ALLOWED_EVENTS` allowlist and `sanitizeMetadata` extended for VS Code telemetry keys.

### Fixed

- **Webhook DLQ `/retry` → `/resolve`** (SMI-4308): the `webhook-dlq` edge function's `POST /:id/retry` handler was cosmetic (no outbound delivery worker exists). Renamed to `/resolve` with explicit operator-acknowledgement semantics. Migration 077 adds `resolved_at`/`resolved_by` columns, replaces `idx_dlq_unretried` with a compound `idx_dlq_open` partial index, and back-populates rows touched by the old handler. `handleList` now filters both `retried_at IS NULL` and `resolved_at IS NULL` — resolved rows no longer appear in the DLQ view. Operator resolutions emit a team-scoped `webhook:dlq_resolved` audit log (non-fatal).
- Restored webhook_endpoints and api_keys tables via migrations 065+066 (SMI-4123, PRs #501/#503/#504). Production deployment tracked in SMI-4135.
- **Audit log telemetry via pooler** (SMI-4118, PR #508): added `SUPABASE_POOLER_URL` to env schema for audit-logs queries that bypass PostgREST's 8s statement timeout. Contributors can now run pooled validation SQL against production without timing out on `audit_logs` LIKE filters.
- **audit-standards Check 11 false positives** (2026-04-08, SMI-3987): npm overrides
  targeting exact-pinned transitive deps are no longer flagged as "ineffective" when
  npm's dedup machinery actually applied the override. Cross-references `npm ls <dep>`
  to verify. Eliminated 6 false-positive warnings on current `main`. See PR #492.
- **audit-standards Check 23 cite-in-body false positives** (2026-04-08, SMI-3987):
  contextual `SMI-NNNN` citations in commit bodies (e.g., "per SMI-3099 doc") are no
  longer counted as completion claims. Only subject-line refs and body refs after
  `closes:`/`fixes:`/`resolves:` markers count. Also extended `NON_SOURCE_PREFIXES`
  to recognize `fix(deps):`/`chore(deps):` commits as legitimately deps-only (no
  source-file requirement). See PR #492.
- **audit-standards Check 23 worktree bug** (2026-04-08, SMI-3986): Check 23 no longer
  emits `fatal: not a git repository` inside git worktrees. Resolved via
  `git rev-parse --git-common-dir` for worktree-aware `.git` resolution. See PR #492.

### Changed

- Rate limits now apply based on your authenticated session tier, not just API key.
- Improved circuit breaker resilience for authentication service.
- Vitest globals removed for better test isolation (#453).
- Dependabot lockfile regeneration automated via script (#453).
- Shallow clone guard added to audit-standards CI check (#456).

### Removed

- **SMI-1537 V3 migration benchmark + A/B reporter workflow** (2026-04-20, SMI-4378):
  removed the synthetic V3 migration benchmark (`scripts/benchmark-v3-migration.ts`,
  `benchmark:v3` npm script, `benchmark:` CI job, optimization-report integration,
  hive-mind perf-validation wave, dev docs) — introduced during the claude-flow v2
  → v3 (ruflo) migration in Phase 5 (Jan 2026), now obsolete post-migration.
  Removed the weekly homepage A/B reporter workflow (`ab-results.yml`) — experiment
  never reached 500/cohort significance in 9+ weeks. Follow-up SMI-4379 tracks
  winding down the live variant-assignment infrastructure on skillsmith.app.

### Security

- Removed `X-Tier` header from public API responses to protect subscription privacy.
- Added percentage-based feature flag (`JWT_AUTH_PERCENTAGE`) for gradual, safe rollout.
- **Dependabot Alert Review** (2026-02-02): All 18 dependency vulnerabilities resolved.
  - 12 alerts dismissed (packages updated via npm overrides to patched versions)
  - 6 alerts auto-fixed by Dependabot
  - Patched: eslint@9.39.2, fast-xml-parser@5.3.4, diff@8.0.3, tar@7.5.7, hono@4.11.7
- **CVE-2026-33768 Patch** (2026-03-29): Patched `@astrojs/vercel` path override bypass
  vulnerability (CVSS 6.5). Upgraded 9.0.3 → 9.0.5 (backported fix for Astro 5
  compatibility). No evidence of exploitation. See [GHSA-mr6q-rp88-fx84](https://github.com/withastro/astro/security/advisories/GHSA-mr6q-rp88-fx84).
- **CI Workflow Hardening** (2026-03-29): Added explicit `permissions: contents: read`
  to `publish-vscode.yml`, restricting default GITHUB_TOKEN scope (CodeQL #75/#76).
- All external dependency versions pinned across CI workflows and edge functions (#437).
- AIDefence threat re-assessment: hardened CLI commands (`audit`, `author/init`,
  `author/mcp-init`, `info`) and MCP tools (`analyze`, `index-local`, `suggest`,
  `skill-audit`, `skill-rescan`) against identified attack vectors (#449).
- **npm vulnerability remediation** (2026-04-08, SMI-3984): Cleared 33 `npm audit`
  findings (1 high + 7 moderate in production deps; 10 high + 23 moderate total
  including dev deps). Pre-push hook now passes without `--no-verify`. Changes
  applied via 4 waves: (W1) direct bumps of `vite ^7.3.2`, `hono ^4.12.12`,
  `@hono/node-server ^1.19.13`; (W2) scoped `srvx ^0.11.13` override for
  `@vercel/backends`; (W3) scoped `yaml ^2.8.3` override for
  `yaml-language-server`; (W4) scoped `ajv ^8.18.0` overrides for
  `@modelcontextprotocol/sdk`, `agentdb`, `yaml-language-server`,
  `@vercel/routing-utils`, and `@vercel/static-config`. See PR #490.

### Dependencies

- vitest 3.2.4 → 4.1.2, turbo 2.5.4 → 2.9.3, typescript-eslint 8.53.1 → 8.58.0,
  jose 5.10.0 → 6.2.2, globals 15.15.0 → 17.4.0, @types/node 20.19.30 → 25.5.2,
  ora 8.2.0 → 9.3.0 (#439–#447).

## [0.4.12] - 2026-02-23

### Changed

- **Migrated `@xenova/transformers` → `@huggingface/transformers` in `@skillsmith/core`** (SMI-2719):
  Removes the `sharp@0.32.x` → `prebuild-install@7.1.3` deprecation warning that appeared for all
  `@skillsmith/cli` users at install time. `@huggingface/transformers` is the official successor
  and exposes the same `pipeline()` API. The `Xenova/all-MiniLM-L6-v2` model ID is unchanged.
  The `quantized: true` pipeline option has been replaced with `dtype: 'q8'` to match the v3 API.
- **Packages**: `@skillsmith/core@0.4.12`, `@skillsmith/cli@0.4.2`, `@skillsmith/mcp-server@0.4.1`

---

## [0.3.6] - 2026-01-18

### CLI Hotfix Release (SMI-1575)

Critical bug fixes for CLI v0.3.0 that was non-functional for new users.

**Packages**: @skillsmith/cli@0.3.1, @skillsmith/core@0.4.0

#### Bug Fixes

- **Database Initialization** (SMI-1576)
  - Fixed "no such table: skills" error on fresh installations
  - Changed `openDatabase()` to `createDatabase()` in sync command
  - Ensures tables are created when database doesn't exist

- **API Schema Validation** (SMI-1577)
  - Fixed Zod validation failures on partial API responses
  - Added `.optional()` and `.default()` to handle missing fields
  - Uses epoch timestamp sentinel for missing date fields

- **Import Rate Limiting** (SMI-1578)
  - Increased default delay from 100ms to 150ms
  - Added `SKILLSMITH_IMPORT_DELAY_MS` environment variable
  - Added verbose logging for SKILL.md fetch failures
  - Improved failure statistics reporting

- **Python Language Detection** (SMI-1579)
  - Added `.py`, `.pyi`, `.pyw` to `SUPPORTED_EXTENSIONS`
  - `analyze` command now detects Python files in codebases

#### Documentation

- Added "Updating the CLI" section to README
- Added `--version` usage documentation
- Updated environment variables table

---

## [0.3.5] - 2026-01-17

### Website Integration: Stripe Checkout Flow

This release completes the frontend integration for Stripe billing, enabling users to sign up for paid tiers directly from the website.

#### Checkout Flow (SMI-1071)

- **Checkout Edge Function** (`supabase/functions/checkout`)
  - Creates Stripe checkout sessions for Individual, Team, Enterprise tiers
  - Supports monthly and annual billing periods
  - Seat count selection for Team/Enterprise (1-1000 seats)
  - Returns Stripe-hosted checkout URL

- **Signup Page** (`/signup`)
  - Tier selection with order summary
  - Billing period toggle (monthly/annual with 17% savings)
  - Seat count selector for team plans
  - Stripe checkout redirect

- **Success Page** (`/signup/success`)
  - Post-payment confirmation
  - Getting started guide with next steps
  - Links to documentation

#### Pricing Page Enhancements

- Added billing period toggle (monthly/annual)
- Dynamic price display based on selected period
- Standardized query parameters (`?tier=` instead of `?plan=`)

#### API Configuration

- Added `API_PATHS` constants for REST vs Edge Function URLs
- Removed hardcoded API URLs across website
- Environment variable support via `PUBLIC_API_BASE_URL`

#### Stripe Products Created

| Tier | Monthly | Annual |
|------|---------|--------|
| Individual | $9.99 | $99.90 |
| Team | $25/user | $250/user |
| Enterprise | $55/user | $550/user |

---

## [0.3.4] - 2026-01-17

### Milestone: Phase 6 Billing Backend Complete

This release implements the complete Stripe billing backend for subscription management, automatic license key delivery, and customer self-service billing.

#### Stripe Integration (SMI-1062 to SMI-1070)

- **StripeClient Wrapper** (SMI-1062)
  - Type-safe Stripe SDK wrapper for customers, subscriptions, checkout
  - Checkout session creation with tier-based pricing
  - Customer portal session management
  - Invoice listing and retrieval

- **Subscription API** (SMI-1063)
  - `BillingService` for database operations
  - Subscription upsert with conflict resolution
  - Status tracking and period management
  - Seat count updates with proration

- **Team & Enterprise Flows** (SMI-1064, SMI-1065)
  - Checkout flows for team and enterprise tiers
  - Adjustable seat quantities (1-1000 seats)
  - Tier-specific metadata and pricing

- **License Key Delivery** (SMI-1066)
  - Automatic JWT license generation on subscription creation
  - License key storage with hash indexing
  - Revocation on subscription cancellation or tier change

- **Seat-Based Billing** (SMI-1067)
  - Seat count management with Stripe sync
  - Proration support for mid-cycle changes
  - Audit logging for seat updates

- **Customer Portal** (SMI-1068)
  - Stripe Customer Portal session creation
  - Self-service subscription management
  - Invoice history access

- **Invoice Management** (SMI-1069)
  - Invoice storage with PDF URLs
  - Payment status tracking
  - Period-based invoice retrieval

- **Webhook Handlers** (SMI-1070)
  - Idempotent webhook processing with event deduplication
  - Signature verification with rate limiting
  - Event routing for subscription and invoice lifecycle

#### GDPR Compliance

- **Data Export** (Article 20)
  - Complete customer data export in JSON format
  - Subscriptions, invoices, license keys, webhook events
  - Excludes sensitive JWT tokens from export

- **Data Deletion** (Article 17)
  - Cascading deletion of all customer data
  - Stripe customer deletion integration
  - Dry-run mode for deletion preview

#### Reconciliation

- **StripeReconciliationJob**
  - Periodic sync between local DB and Stripe
  - Discrepancy detection for status, tier, seat count
  - Auto-fix mode for automatic corrections

#### Database Schema (ADR-021)

- Extended `user_subscriptions` with `stripe_price_id`, `seat_count`, `canceled_at`
- Added `stripe_webhook_events` table for idempotent processing
- Added `license_keys` table for subscription-linked JWT storage
- Added `invoices` table for payment history

#### Security

- Stripe ID validators and sanitizers in `sanitization.ts`
- `STRIPE_WEBHOOK` rate limiter preset (100 req/min, fail-closed)
- Webhook signature verification with timing-safe comparison

### Documentation

- [ADR-021: Billing Schema Approach](docs/adr/021-billing-schema-approach.md)

---

## [0.3.3] - 2026-01-17

### Milestone: Claude-Flow V3 Migration Complete

This release completes the migration from Claude-Flow V2 to V3, bringing significant performance improvements and new neural learning capabilities.

#### Core Migration (SMI-1517 to SMI-1524)

- **V3 Alpha Upgrade** (SMI-1517)
  - Upgraded claude-flow from 2.7.x to 3.0.0-alpha.83
  - Updated all imports to V3 module paths
  - Backward-compatible wrapper for V2 API consumers

- **SessionManager V3 Memory API** (SMI-1518)
  - Migrated to V3's `MemoryInitializer` and `MCPClient`
  - Persistent session context with automatic recovery
  - Session metrics and telemetry integration

- **HNSW + SQLite Hybrid Storage** (SMI-1519)
  - Hierarchical Navigable Small World graph for vector search
  - SQLite backing store for persistence and ACID compliance
  - **150x faster** embedding search (from 500ms to ~3ms for 10K vectors)

- **ReasoningBank Integration** (SMI-1520)
  - Trajectory-based learning for skill recommendations
  - Installation/dismissal signal recording
  - Verdict judgment system for recommendation quality

- **SONA Routing** (SMI-1521)
  - Self-Organizing Neural Architecture for MCP tool optimization
  - Mixture-of-Experts routing for tool selection
  - Adaptive load balancing across tool providers

- **EWC++ PatternStore** (SMI-1522)
  - Elastic Weight Consolidation for catastrophic forgetting prevention
  - Fisher information matrix computation
  - Pattern importance weighting and decay

- **Multi-LLM Provider** (SMI-1523, SMI-1524)
  - Support for OpenAI, Anthropic, Gemini, and Ollama backends
  - Automatic failover with circuit breaker pattern
  - Health monitoring and provider selection

#### Security Hardening (Phase 4: SMI-1532 to SMI-1534)

- **AI Defence Patterns** (SMI-1532)
  - 16 CVE-hardened patterns for prompt injection protection
  - Content policy enforcement
  - Token limit validation

- **Trust-Tier Sensitive Scanning** (SMI-1533)
  - Differentiated scanning by skill trust level
  - Enhanced scrutiny for experimental/unknown skills
  - Automatic quarantine for policy violations

- **E2B Sandbox Execution** (SMI-1534)
  - Isolated code execution for untrusted skills
  - Network isolation and resource limits
  - Timeout enforcement and graceful cleanup

#### Testing & Performance (Phase 5: SMI-1535 to SMI-1537)

- **V3 Unit Tests** (SMI-1535)
  - Updated test mocks for V3 API
  - Session lifecycle tests
  - Memory persistence validation

- **Neural Integration Tests** (SMI-1536)
  - 61 new tests across 5 test suites
  - Signal collection, preference learning, personalization
  - GDPR compliance and data wipe verification

- **V3 Performance Benchmarks** (SMI-1537)
  - Memory operations: **40x faster** (200ms → 5ms)
  - Embedding search: **150x faster** (500ms → 3ms)
  - Recommendation pipeline: **4x faster** (800ms → 200ms)
  - CI benchmark integration for regression detection

### Security

- Fixed high-severity vulnerability in `tar` package (GHSA-8qq5-rm4j-mr97)

### Documentation

- [ADR-020: Phase 4 Security Hardening](docs/adr/020-phase4-security-hardening.md)
- [Phase 5 Neural Testing Guide](docs/execution/phase5-neural-testing.md)
- [V3 Migration Status](docs/execution/v3-migration-status.md)

---

## [0.3.0] - 2026-01-09

### Multi-Language Codebase Analysis

**Packages**: @skillsmith/core

#### Added

- **Multi-Language Codebase Analysis** (SMI-776)
  - Support for TypeScript, JavaScript, Python, Go, Rust, and Java
  - Unified `ParseResult` format across all languages
  - Language-agnostic framework detection

- **Language Router** (SMI-1303)
  - `LanguageRouter` class for dispatching files to appropriate adapters
  - Dynamic adapter registration and extension mapping
  - Aggregated framework detection rules from all adapters

- **Language Adapters**
  - `TypeScriptAdapter` - Wraps existing TypeScript compiler API (SMI-1310)
  - `PythonAdapter` - Django, FastAPI, Flask, pytest detection (SMI-1304)
  - `GoAdapter` - Gin, Echo, Fiber, GORM, Cobra detection (SMI-1305)
  - `RustAdapter` - Actix, Rocket, Axum, Tokio, Serde detection (SMI-1306)
  - `JavaAdapter` - Spring Boot, Quarkus, JUnit, Hibernate detection (SMI-1307)

- **Parse Caching** (SMI-1303)
  - `ParseCache` class with LRU eviction and content hash validation
  - Memory-based eviction to prevent OOM
  - Pattern-based cache invalidation

- **Incremental Parsing** (SMI-1309)
  - `TreeCache` for caching parsed AST trees
  - `IncrementalParser` coordinator for efficient re-parsing
  - Edit tracking utilities: `calculateEdit`, `indexToPosition`, `findMinimalEdit`
  - Performance target: <100ms for incremental parses

- **Performance Optimization** (SMI-1308)
  - `ParserWorkerPool` for parallel file parsing using worker threads
  - `MemoryMonitor` for memory pressure detection and cleanup
  - Memory-efficient file streaming: `streamFiles`, `batchReadFiles`
  - Performance target: <5s for 10k files

- **Dependency Parsers**
  - `parseGoMod` - Parse go.mod files for Go dependencies
  - `parseCargoToml` - Parse Cargo.toml for Rust dependencies
  - `parsePomXml` - Parse pom.xml for Maven dependencies
  - `parseBuildGradle` - Parse build.gradle for Gradle dependencies

- **Extended Type Definitions**
  - `SupportedLanguage` type: `'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java'`
  - Extended `ImportInfo` with `language` and `line` fields
  - Extended `ExportInfo` with `visibility` and `line` fields
  - Extended `FunctionInfo` with `receiver`, `decorators`, `attributes` fields
  - Extended `CodebaseContext.stats` with `filesByLanguage`
  - Extended `CodebaseContext.metadata` with `languages` and `cacheHitRate`

#### Changed

- `CodebaseAnalyzer` now supports multi-language analysis while maintaining backward compatibility
- Default exclude directories extended: `__pycache__`, `.pytest_cache`, `target`, `vendor`, `venv`

#### Documentation

- **Migration Guide** - `docs/guides/migration-v2.md` for upgrading from v1.x
- **API Reference** - `docs/api/analysis.md` with complete type and class documentation
- **Architecture Document** - `docs/architecture/multi-language-analysis.md`

#### Performance

- 10k file analysis: <5 seconds (3x improvement)
- Incremental parse: <100ms
- Cache hit rate target: >80%
- Memory efficiency: ~30% reduction with LRU caching

---

## [0.2.0] - 2026-01-08

### API Client & Analytics

**Packages**: @skillsmith/core

#### Added

- **API Client Module** (SMI-1244)
  - `SkillsmithApiClient` class with retry logic and exponential backoff
  - Configurable timeout and max retries
  - Non-blocking telemetry via `recordEvent()`
  - Factory functions: `createApiClient()`, `generateAnonymousId()`

- **API Response Caching** (SMI-1245)
  - `ApiCache` class with LRU eviction
  - Endpoint-specific TTLs (24h for skills, 1h for search)
  - Cache statistics and hit rate tracking
  - Global cache singleton via `getGlobalCache()`

- **PostHog Analytics** (SMI-1246)
  - Product analytics integration with PostHog SDK
  - Event tracking: `trackSkillSearch()`, `trackSkillView()`, `trackSkillInstall()`
  - Feature flag support via `isFeatureFlagEnabled()`
  - Privacy-first: anonymous IDs only, no PII

- **GitHub Indexer Edge Function** (SMI-1247)
  - Automated skill discovery from GitHub
  - Rate limit handling with exponential backoff
  - Audit logging to Supabase
  - Dry-run mode for testing

- **Indexer Scheduling** (SMI-1248)
  - pg_cron support for database-level scheduling
  - GitHub Actions workflow alternative
  - Daily runs at 2 AM UTC

- **k6 Performance Tests** (SMI-1235)
  - Load test scripts for all API endpoints
  - Smoke, load, and stress test scenarios
  - Custom metrics: latency, error rate, rate limit hits
  - Threshold-based pass/fail criteria

#### Changed

- **CORS Cleanup** (SMI-1236)
  - Removed deprecated wildcard `corsHeaders` export
  - Updated `jsonResponse()` and `errorResponse()` to accept origin parameter
  - Dynamic CORS headers based on request origin

#### Infrastructure

- **Upstash Redis** (SMI-1234)
  - Rate limiting for Edge Functions
  - REST API integration
  - Varlock-secured credentials

- **Supabase CLI** (SMI-1249)
  - Updated from v2.33.9 to v2.67.1

---

## [0.1.2] - 2026-01-07

### Initial Release

**Packages**: All packages at 0.1.x

#### Added

- Initial public release
- Core skill discovery functionality
- MCP server integration
- CLI tool
- VS Code extension

---

[0.3.6]: https://github.com/smith-horn/skillsmith/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/smith-horn/skillsmith/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/smith-horn/skillsmith/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/smith-horn/skillsmith/compare/v0.3.0...v0.3.3
[0.3.0]: https://github.com/smith-horn/skillsmith/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/smith-horn/skillsmith/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/smith-horn/skillsmith/releases/tag/v0.1.2
