# Changelog

All notable changes to `@skillsmith/mcp-server` are documented here.

## v0.4.13

- **Fix**: map curated trust tier through MCP surface (SMI-4520) (#822)
- **Fix**: batch close 4 GitHub security alerts (SMI-4499/4501/4502/4504) (#805)
- **Fix**: rotate KEY_HMAC_SECRET to env var (SMI-4503, CodeQL #81) (#807)

## v0.4.12

- **Fix**: team-workspace uses service-role client post-license-resolution (SMI-4312) (#650)

## v0.4.11

- Version bump

## v0.4.10

- **Fix**: restore category/security/repo in skill detail view (SMI-4240) (#583)
- **Other**: SMI-4190: release cadence docs — ADR-114 + CHANGELOG backfill + CONTRIBUTING (#552)

## [Unreleased]

- **Bump**: `@skillsmith/core` dep range to `^0.5.8` — pulls in SMI-4563 native SQLite driver auto-install via `optionalDependencies`. mcp-server's own version unchanged; consumers picking up `core@0.5.8` will get the native driver on `npx` install instead of silently falling back to WASM.
- **Feature**: SMI-4124 `skill_pack_audit` trigger-quality + namespace collision checks (PR #505).
- **Feature**: SMI-4587 Wave 1 PR #1 — local-inventory scanner across 4 sources (skills/commands/agents/CLAUDE.md), ULID-based audit-history writer at `~/.skillsmith/audits/<auditId>/`, and exact-name collision detector. Adds `ulid@3.0.1` dependency. Internal scaffolding for the consumer namespace audit; no user-visible MCP tool changes yet (gated on Wave 1 completion). PR #2 wires the generic-token pass via the existing `detectGenericTriggerWords` helper from `skill-pack-audit.helpers.ts`, sharing the curated `GENERIC_TRIGGERS` stoplist and `derivePackDomain` mode-of-tags inference; results surface as `genericFlags` (severity `warning`) on the same `InventoryAuditResult`. PR #3 wires the semantic-overlap pass via existing `OverlapDetector` (gated by `audit_mode`), adds `bootstrapUnmanagedSkills` plumbing, and ships the `audit_mode` resolver under new subpath export `@skillsmith/core/config/audit-mode`. Latency invariant: in `preventative` mode no `EmbeddingService` is touched (zero ONNX model load on the cheap critical path); `power_user` / `governance` invoke `OverlapDetector.findAllOverlaps` once per audit run; `off` short-circuits to an empty result. PR #4 ships the audit-report writer (`packages/mcp-server/src/audit/audit-report-writer.ts` — atomic markdown render with conditional CLAUDE.md scan caveat per D-ANTI-1), aggregate-only server telemetry (`packages/mcp-server/src/tools/namespace-audit/telemetry.ts` — emits `event: namespace_audit_complete` with collision counts and resolution counters; never auditId/path/identifier per decision #7), the `index.ts` barrel re-export at `@skillsmith/mcp-server/audit` (Step 9), and refactors `LocalIndexer.indexSkillDir` (and the `bootstrapUnmanagedSkills` default) to delegate to the new `indexLocalSkill` core helper extracted from the existing per-skill metadata path (NEW-E-2 surface grounding).

## v0.4.9

- **Feature**: SMI-4183 emit `webhook:subscription_tier_changed` audit events from subscription edge function (#538).

## v0.4.8

- **Docs**: bump internal submodule for SMI-4181/4184 GSC audit plan (#539).
- **Docs**: sync website api.astro + mcp-server CHANGELOG (SMI-4140, SMI-4142) (#518).
- **Docs**: SMI-4122/4123 sync — mcp-server README + CHANGELOGs (#514).
- **Fixed**: `webhook_configure` and `api_key_manage` backing tables restored (SMI-4123, PRs #501/#503/#504). In preview until production migration (SMI-4135).

## v0.4.7

- **Fix: startup crash for new installs** — Bumped `@skillsmith/core` dependency floor from `^0.4.16` to `^0.4.17` to ensure `SkillInstallationService` export is available. Users with cached `core@0.4.16` saw a fatal `SyntaxError` on startup.

## v0.4.6 (2026-03-24)

- **README updates**: Updated npm README to reflect current features and usage.
- **SDK compatibility**: Bumped `@modelcontextprotocol/sdk` to `^1.27.1` for compatibility improvements.
- **Security**: Remediated security gaps across MCP tools as part of SMI-3506 security sweep.

## v0.4.5 (2026-03-19)

- **Fix: broken SkillDependencyRepository export** — Hotfix for missing barrel export that caused `SyntaxError` on startup when dependency intelligence tools were invoked (SMI-3468).

## v0.4.4 (2026-03-06)

- **Dependency intelligence tools**: `skill_outdated` tool checks installed skills against latest registry versions with dependency status reporting (SMI-3138).
- **Skill pack audit**: `skill_pack_audit` tool detects version drift between installed and registry skills (SMI-2905).
- **Semver validation**: `skill_validate` now requires a `version` field and validates semver format (SMI-2902).
- **Encrypted skill detection**: `install_skill` detects git-crypt encrypted skills and provides unlock guidance (SMI-3221).
- **Core dependency fix**: Fixed exact-pinned `@skillsmith/core` dependency to use caret range.

## v0.4.3

- **Co-install recommendations**: `get_skill` responses now include an `also_installed` array — skills frequently installed alongside this one, surfaced once ≥5 co-installs are observed. Also shown on skill detail pages at [www.skillsmith.app/skills](https://www.skillsmith.app/skills).
- **Repository and homepage links**: `search` and `get_skill` responses now include `repository_url` and `homepage_url` when declared by the skill author.
- **Compatibility tags**: Skills can declare `compatibility` frontmatter (LLMs, IDEs, platforms). Tags surface in search results and skill detail pages.

## v0.4.0

- **Quota-based throttling**: `skill_suggest` now counts against your monthly API quota instead of an undocumented per-session rate limit. Community (1,000/mo), Individual (10,000/mo), Team (100,000/mo), Enterprise (unlimited). See [www.skillsmith.app/pricing](https://www.skillsmith.app/pricing).
- **Graceful license degradation**: If the enterprise license check is unavailable, `skill_suggest` falls back to community-tier defaults rather than returning a hard error.

## v0.3.18

- **Async Initialization**: Server initializes asynchronously for faster startup
- **WASM Fallback**: Automatic fallback to sql.js when native SQLite unavailable
- **Robust Context Loading**: Graceful handling of initialization edge cases
