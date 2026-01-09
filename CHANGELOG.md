# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/smith-horn-group/skillsmith/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/smith-horn-group/skillsmith/releases/tag/v0.1.2
