# Changelog

All notable changes to `@skillsmith/mcp-server` are documented here.

## v0.4.8

- Version bump

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
