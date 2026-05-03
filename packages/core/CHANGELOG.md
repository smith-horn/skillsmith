# Changelog

All notable changes to `@skillsmith/core` are documented here.

## v0.5.9

- **Other**: docs+chore: SMI-4575 global rebrand sweep — Agent Skills, not Claude Skills (#857)
- **Feature**: SMI-4578 + SMI-4580 — multi-client install paths + per-client MCP config snippets (#878)
- **Fix**: SMI-4640 make closeDatabase tolerate undefined to surface real test-setup errors (#863)

## [Unreleased]

- **Chore**: SMI-4575 refresh `HNSWEmbeddingStore.saveIndex()`/`loadIndex()` log messages — the legacy "Index persistence managed by V3 VectorDB backend" lines were factually wrong post-SMI-4577 (V3 was decommissioned with the claude-flow → ruflo rename). They now identify as no-op shims and point callers at `EmbeddingService` for HNSW persistence. Behaviour unchanged.
- **Feature**: SMI-4578 multi-client install paths — new subpath export `@skillsmith/core/install` exposes `ClientId` (`claude-code | cursor | copilot | windsurf | agents`; Codex users pass `agents`), `getCanonicalInstallPath()`, `getInstallPath(client)`, `assertClientId`, `resolveClientPath()` (honours `SKILLSMITH_CLIENT` env var), plus a fan-out manifest module (`addLink`, `removeLinks`, `listLinks`) backing the new `--also-link`/`--symlink` CLI flags. Manifest persisted at `~/.skillsmith/links/manifest.json` (atomic-rename); copy-default per SMI-4287 LocalFilesystemAdapter symlink rejection. Cycle detection via realpath; Windows EPERM falls back to copy. Consumed by `@skillsmith/cli` install/uninstall and `@skillsmith/mcp-server` install_skill / uninstall_skill / skill_rescan / installed-skills detection. (#878)
- **Feature**: SMI-4587 Wave 1 PR #4 — add `indexLocalSkill` (extracted from `executeIndexLocal` in mcp-server). New subpath export `@skillsmith/core/skills/index-local` plus a top-level barrel re-export. Pure-ish helper that returns deterministic per-skill metadata for a given SKILL.md absolute path (or its containing directory). Used by both the MCP `index_local` tool (via `LocalIndexer.indexSkillDir`) and the consumer-namespace-audit `bootstrapUnmanagedSkills` default callback (replacing the PR #3 no-op stub). Frozen-fixture regression test under `packages/core/tests/fixtures/index-local/` locks the deterministic output shape so Wave 2/3/4 callers and the mcp-server LocalIndexer continue to receive identical results after extraction.
- **Feature**: SMI-4587 Wave 1 PR #3 — new subpath export `@skillsmith/core/config/audit-mode` exposes the pure `resolveAuditMode({ tier, override }) -> AuditMode` resolver consumed by the consumer namespace audit (mcp-server's `detectCollisions`). Tier defaults: community/individual → `preventative`, team → `power_user`, enterprise → `governance`; explicit override (read by callers from `~/.skillsmith/config.json` `audit_mode` or `SKILLSMITH_AUDIT_MODE` env) wins when valid. Also re-exported from the top-level `@skillsmith/core` barrel for backwards compatibility.
- **Feature**: SMI-4577 restore HNSW (Hierarchical Navigable Small World) index for `EmbeddingService.findSimilar()` — the production semantic-search hot path that was running brute-force `O(n)` on 14k skills. `hnswlib-node@^3.0.0` promoted from a transitive (claude-flow) optional dep to a first-class `optionalDependency` on `@skillsmith/core`. Brute-force preserved as `findSimilarBruteForce()` and as automatic fallback when the optional dep is absent (Vercel build, restricted hosts). New `~/.skillsmith/cache/` artifact dir (with `pathValidation` allow-list extension) for persisted indices; atomic-rename on a 5s debounce keeps concurrent writers safe. Bench: >190x p99 speedup at 14k vectors with `recall@10 = 1.000`. Opt-out: `SKILLSMITH_USE_HNSW=false`. (#858)
- **Fix**: pin `web-tree-sitter` to 0.25.10 (revert dependabot bump #682). 0.26.x's WASM loader rejects the Python grammar binary published by `tree-sitter-wasms@0.1.13` — `getDylinkMetadata` throws inside `Language.load()`. Upstream `tree-sitter-wasms` has not been rebuilt against tree-sitter 0.26.x yet. (SMI-4556, closes #821)
- **Test**: cover `src/analysis/tree-sitter/**/*.test.ts` in `packages/core/vitest.config.ts` so PR matrix catches future tree-sitter dep-bump regressions before merge — small carve-out from the SMI-3502 split (SMI-4557)

## v0.5.8

- **Fix**: SMI-4563 native SQLite driver now installs automatically via npm `optionalDependencies` (was: silent WASM fallback on every fresh `npx` consumer). `better-sqlite3@11.10.0` is now declared optional so npm attempts native install on supported platforms; the WASM path remains a true fallback for hosts without a C toolchain.
- **Feature**: SMI-4463 monthly quota enforcement (community 100% behind ENFORCE_COMMUNITY_QUOTA flag) (#773)
- **Fix**: SMI-4531+4533 unify collision rules + forbid local-fallback npm publish (#828)

## v0.5.7

- **Fix**: map curated trust tier through MCP surface (SMI-4520) (#822)
- **Fix**: batch close 4 GitHub security alerts (SMI-4499/4501/4502/4504) (#805)

## v0.5.6

- **Fix**: SMI-4486 `initializeSchema()` now runs migrations after creating base tables; previously recorded SCHEMA_VERSION up front, causing `runMigrations` to skip every migration and leave fresh DBs missing v5+ tables (skill_versions, skill_advisories, etc.) (#795)

## v0.5.5

- Version bump

## v0.5.4

- **Fix**: rename webhook-dlq /retry → /resolve with migration 077 (SMI-4308) (#647)
- **Feature**: team provisioning on subscription (SMI-4307) (#646)
- **Fix**: populate UndoSnapshot.backup_path in ActivationManager (SMI-4297) (#644)

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
