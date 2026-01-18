# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] - 2026-01-17

### 🎉 Milestone: Phase 6 Billing Backend Complete

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

## [2.2.0] - 2026-01-17

### 🎉 Milestone: Claude-Flow V3 Migration Complete

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

## [2.0.0] - 2026-01-09

### Added

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

### Changed

- `CodebaseAnalyzer` now supports multi-language analysis while maintaining backward compatibility
- Default exclude directories extended: `__pycache__`, `.pytest_cache`, `target`, `vendor`, `venv`

### Documentation

- **Migration Guide** - `docs/guides/migration-v2.md` for upgrading from v1.x
- **API Reference** - `docs/api/analysis.md` with complete type and class documentation
- **Architecture Document** - `docs/architecture/multi-language-analysis.md`

### Performance

- 10k file analysis: <5 seconds (3x improvement)
- Incremental parse: <100ms
- Cache hit rate target: >80%
- Memory efficiency: ~30% reduction with LRU caching

## [0.2.0] - 2026-01-08

### Added

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

### Changed

- **CORS Cleanup** (SMI-1236)
  - Removed deprecated wildcard `corsHeaders` export
  - Updated `jsonResponse()` and `errorResponse()` to accept origin parameter
  - Dynamic CORS headers based on request origin

### Infrastructure

- **Upstash Redis** (SMI-1234)
  - Rate limiting for Edge Functions
  - REST API integration
  - Varlock-secured credentials

- **Supabase CLI** (SMI-1249)
  - Updated from v2.33.9 to v2.67.1

## [0.1.2] - 2026-01-07

### Added
- Initial public release
- Core skill discovery functionality
- MCP server integration
- CLI tool
- VS Code extension

[2.0.0]: https://github.com/smith-horn-group/skillsmith/compare/v0.2.0...v2.0.0
[0.2.0]: https://github.com/smith-horn-group/skillsmith/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/smith-horn-group/skillsmith/releases/tag/v0.1.2
