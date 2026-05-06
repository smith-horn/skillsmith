# Changelog

All notable changes to `@skillsmith/mcp-server` are documented here.

## [Unreleased]

## v0.5.0

This release ships the consumer namespace-audit feature end-to-end (SMI-4587 → SMI-4590, Waves 1–4). Three new MCP tools, an install-time pre-flight gate, an apply-with-confirmation edit-suggester, a session-start audit hook (Team/Enterprise), and an Enterprise scheduled-scan path.

### New MCP tools (Team+ tier)

- **Feature**: `skill_inventory_audit` — audits the local `~/.claude/` inventory across skills/commands/agents/CLAUDE.md for namespace collisions; returns rename + edit suggestions. Three pass-modes (`preventative` / `power_user` / `governance`) controlled by `~/.skillsmith/config.json` `audit_mode` or `SKILLSMITH_AUDIT_MODE` env. ULID-based audit-history at `~/.skillsmith/audits/<auditId>/`. Privacy-gated for Free/Individual (returns typed error). (SMI-4587 / SMI-4590 PR #940)
- **Feature**: `apply_namespace_rename` — applies a rename suggestion from an audit result with three modes (`apply` / `custom` / `skip`); persists overrides via the namespace-overrides ledger. (SMI-4588 / SMI-4590 PR #940)
- **Feature**: `apply_recommended_edit` — applies a recommended prose edit (e.g. `add_domain_qualifier`); gated behind `APPLY_TEMPLATE_REGISTRY` allow-list with `apply_with_confirmation` UX from the edit-suggester pipeline. (SMI-4589 / SMI-4590 PR #940)

### Install-time + session-time gates

- **Feature**: SMI-4588 install pre-flight + mode gate — `runNamespaceGate` runs before `install_skill` to surface name conflicts ahead of disk write; mode-aware behaviour (block in `preventative`, warn in `power_user`, audit-only in `governance`, skip in `off`). (PR #881)
- **Feature**: SMI-4590 Wave 4 PR 6/6 — tier-gated session-start audit hook (`scripts/session-start-audit.sh` → `scripts/lib/session-start-audit-helper.ts`). Debounced 24h via `~/.skillsmith/last-audit.json`. Free/Individual emit zero output (audit is a paid feature); Team gets a one-line collapsed summary on stderr; Enterprise gets a path-only pointer on stderr. Bounded 5-second wall clock; fail-soft (helper always exits 0). Disable via `SKILLSMITH_SESSION_AUDIT_DISABLE=1`. Logs at `~/.skillsmith/logs/session-audit-<date>.log`. (#956)
- **Feature**: SMI-4590 Wave 4 — Enterprise scheduled-scan via `runScheduledScan`. Idempotent within `SKILLSMITH_SCHEDULED_AUDIT_CACHE_MIN` (default 5 min); emits deep + un-filtered findings.

### Detection passes + plumbing

- **Feature**: SMI-4587 Wave 1 — local-inventory scanner across 4 sources (skills/commands/agents/CLAUDE.md), ULID-based audit-history writer at `~/.skillsmith/audits/<auditId>/`, and exact-name collision detector. Adds `ulid@3.0.1` dependency. PR #2 adds the generic-token pass via the existing `detectGenericTriggerWords` helper (results surface as `genericFlags`, severity `warning`). PR #3 adds the semantic-overlap pass via existing `OverlapDetector` (gated by `audit_mode`), adds `bootstrapUnmanagedSkills` plumbing. Latency invariant: in `preventative` mode no `EmbeddingService` is touched (zero ONNX model load on the cheap critical path). PR #4 ships the audit-report writer (atomic markdown render with conditional CLAUDE.md scan caveat per D-ANTI-1), aggregate-only server telemetry (`namespace_audit_complete` event with collision counts and resolution counters; never auditId/path/identifier per decision #7), the `index.ts` barrel re-export at `@skillsmith/mcp-server/audit`, and refactors `LocalIndexer.indexSkillDir` to delegate to the new `indexLocalSkill` core helper.
- **Feature**: SMI-4588 Wave 2 — namespace overrides ledger + shared audit types (PR #877); rename engine + suggestion chain + 3 apply paths (PR #880); install pre-flight + mode gate (PR #881); integration tests + audit-report rename section + backup-gc (PR #884).
- **Feature**: SMI-4589 Wave 3 — edit-suggester (`apply_with_confirmation` for `add_domain_qualifier`). (PR #886)
- **Feature**: SMI-4590 Wave 4 PR 1/6 — `sklx audit advisories` tool routing + audit-tool-dispatch extraction. (#899)
- **Feature**: SMI-4590 Wave 4 PR 2/6 — `FrameworkAdapter` interface + `claudeCodeAdapter` + package wiring. Allows the audit pipeline to address agent frameworks beyond Claude Code in future. (#913)

### Other

- **Bump**: `@skillsmith/core` dep range to `^0.6.0` to pick up the new audit subpath exports (`@skillsmith/core/config/audit-mode`, `@skillsmith/core/skills/index-local`) and multi-client install paths (`@skillsmith/core/install`).
- **Bump**: minor version (0.4.13 → 0.5.0) signals new MCP tool surface — three new tools added to the Team+ tier.
- **Feature**: SMI-4124 `skill_pack_audit` trigger-quality + namespace collision checks (PR #505).

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
