# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
