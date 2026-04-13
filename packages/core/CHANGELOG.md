# Changelog

All notable changes to `@skillsmith/core` are documented here.

## v0.5.1

- Version bump

## v0.4.18

- **Fix**: SMI-4182 suppress CodeQL false positive on telemetry hash
- **Feature**: SMI-4120 response caching + Cache-Control (#516)

## [Unreleased]

- **Indexer registers addyosmani/agent-skills as high-trust source** (SMI-4122, PR #499).

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
