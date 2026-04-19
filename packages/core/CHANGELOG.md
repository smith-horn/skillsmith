# Changelog

All notable changes to `@skillsmith/core` are documented here.

## v0.5.3

- **Fix**: add missing SMI-4240 fields to ApiSearchResultSchema (SMI-4246, SMI-4247) (#611)

## v0.5.2

- **Fix**: restore category/security/repo in skill detail view (SMI-4240) (#583)
- **Other**: SMI-4190: release cadence docs — ADR-114 + CHANGELOG backfill + CONTRIBUTING (#552)

## [Unreleased]

- **SMI-4308**: `WebhookDeadLetterRepository` gains `markResolved(id, resolvedBy?)` for operator acknowledgement and renames `listUnretried` → `listOpen` (the in-process filter now excludes both retried and resolved rows). `listUnretried` kept as a deprecated alias; removed when SMI-4322's delivery worker lands. Repository types add `resolved_at` / `resolved_by` matching migration 077. `markRetried` unchanged — dormant until SMI-4322.
- **SMI-4306**: Fix RLS recursion on `teams` and `team_members` that caused 500s on `/account/team*` pages once any user had a membership row. Migration 072 rewrites the two legacy policies to call SECURITY DEFINER helpers.
- **SMI-4293**: tree-sitter incremental parsing for Python analyzer — WASM-backed (`web-tree-sitter@0.25.10`), LRU tree cache (100 entries), query-based extraction replaces regex fallback. Unchanged file re-parse ~0ms (memoised); incremental edit ~60ms on 1955-line fixture (well under 100ms target); ~27,000× speedup on cache hits vs cold parse. Regression guard ensures query extraction matches or exceeds prior regex coverage on all fixtures (PR #633, closes #604).
- **SMI-4291**: Webhook dead-letter queue — new `WebhookDeadLetterRepository`, optional `deadLetterSink` on `WebhookQueueOptions`, and `webhook-dlq` authenticated edge function. Closes GitHub #601.
- **SMI-4124**: `skill_pack_audit` trigger-quality + namespace collision checks (PR #505).

## v0.5.1

- **Fix**: SMI-4182 suppress CodeQL false positive on telemetry hash (#550 retro).

## v0.4.18

- **Fix**: SMI-4182 suppress CodeQL false positive on telemetry hash.
- **Feature**: SMI-4120 response caching + Cache-Control (#516).
- **Feature**: Indexer registers addyosmani/agent-skills as high-trust source (SMI-4122, PR #499).

## v0.4.17

- **PII Detection**: New PII detection module with configurable pattern matching for emails, phone numbers, API keys, and credentials.
- **Quality Scoring with Risk Trends**: Quality scoring service with risk trend tracking and anomaly detection thresholds (20pt warning, 35pt critical, 40pt boundary crossing).
- **Risk Score History**: `RiskScoreHistoryRepository` for tracking risk score changes over time with `RiskScoreSnapshot` type.
- **Skill Config Validation**: Schema validation for skill configuration files using Zod.
- **AIDefence Feedback**: Security feedback integration for AIDefence threat assessment.
- **Dependency Quarantine Checks**: Enhanced dependency quarantine validation.
- **Pre-Install Security Gate**: `SkillInstallationService` enhanced with security confirmation flow — skills with high-severity findings require user approval.

## v0.4.16

- **Skill Dependency Intelligence**: `DependencyDeclaration` type for declaring skill dependencies.
- **Dependency Repository**: `SkillDependencyRepository` for dependency graph queries.
- **Database Migration v10**: Schema version 10 with dependency tracking tables.

## v0.4.15

- **Co-install recommendations**: `CoInstallRepository` and `AlsoInstalledSkill` types for tracking skills frequently installed together.
- **Compatibility tags**: Skills can declare compatibility frontmatter (LLMs, IDEs, platforms).
- **Repository and homepage links**: New `repository_url` and `homepage_url` fields on skill records.
- **Database migration v9**: SCHEMA_VERSION 9 with migrations for co-install and compatibility features.

## v0.4.7

- **Multi-language support**: Analyze TypeScript, JavaScript, Python, Go, Rust, and Java codebases with improved dependency management.
