# Changelog

All notable changes to `@skillsmith/mcp-server` are documented here.

## [Unreleased]

- **Fix**: reduced local quota-enforcement limits 10x (SMI-5558) — Community was 1,000/mo now 100/mo, Individual was 10,000/mo now 1,000/mo, Team was 100,000/mo now 10,000/mo. Added a `SKILLSMITH_ENFORCE_MCP_QUOTA` kill-switch (defaults to enforcing, matching prior unconditional-block behavior) so hard-blocking can be disabled without a redeploy.

## v0.7.0

- **Fix**: launcher dep-integrity preflight + zod runtime dep (SMI-5451) (#1664)
- **Feature**: `SKILLSMITH_TOOL_PROFILE=agent` curated tool listing (~15 tools) for harness integration (SMI-5456)
- **Feature**: `undo_apply` tool — session-scoped undo of apply_namespace_rename/apply_recommended_edit via journal (SMI-5456)
- **Feature**: extract `_meta` marker (`agent_session`, `nudge_origin`, `trigger_id`) from MCP tool calls (SMI-5456)
- **Fix**: dispatch-routing for skill_inventory_audit/apply_namespace_rename/apply_recommended_edit (now callable over MCP CallTool) (SMI-5456)
- **Feature**: inventory-audit dual-path dedup + self-exemption for agent pack (SMI-5456)
- **Feature**: committed agent-pack assets (shims, hooks) + `generate:agent-pack` build script (SMI-5456)
- **Feature**: consent-gated telemetry emission wired into the CallTool dispatch path for all 18 previously-never-emitting direct-dispatch tools, live-ing the agent-mediation denominator (SMI-5479)
- **Feature**: flush-on-shutdown for buffered telemetry — bounded PostHog flush on `SIGTERM`/`SIGINT`/transport close (SMI-5479)
- **Refactor**: extract `CallToolRequestSchema` handler from `index.ts` into `call-tool-handler.ts` to stay under the 500-LOC file-size gate (SMI-5479)

## v0.6.0

- **Feature**: Wave 3 — local CLI/MCP push agent (SMI-5390/5391/5392) (#1579)

## v0.5.5

- **Feature**: enrich git/plugin-recovered skills with the registry UUID (SMI-5411) (#1600)
- **Fix**: tighten get_skill quarantine-block message + local id fallback (SMI-5360 Wave 5 PR1 retro) (#1598)
- **Fix**: get_skill installable:false for quarantined skills + run the SSRF e2e suite in CI (SMI-5360 Wave 5 PR1) (#1597)
- **Feature**: affix-tolerant registry-name matching for source recovery (SMI-5413) (#1592)

## v0.5.4

- **Feature**: recover + backfill canonical GitHub source for local skills (SMI-5407) (#1589)
- **Fix**: scan optional files before write; reject malicious config (SMI-5359 Wave 4.3, Gap-1) (#1580)
- **Fix**: key rescan quarantine on frontmatter name + idempotency (SMI-5358 retro) (#1569)
- **Feature**: CLI install block + local-search filter + 9 missing quarantine tests (SMI-5358) (#1567)
- **Feature**: SMI-5178 — `search` and `skill_recommend` MCP tools now default to
  installable-only results. Discovery-only entries (no `repo_url`, cannot be resolved
  by `install_skill`) are hidden by default (~71% of the registry). Pass
  `installable_only: false` to restore the previous inclusive behavior. The
  `discoveryOnlyHidden` field on search responses and `discovery_only_hidden` on
  recommend responses report how many entries were hidden. The `skills-search` edge
  function adopts the same default via the `installable_only` query param.

## v0.5.3

- **Refactor**: SMI-5036 split oversized billing test files (#1282)
- **Fix**: SMI-5012 retro — resolve audit:standards findings
- **Feature**: SMI-5012 PR-2 — W2 in-process instrumentation (HOF + consent + MCP wraps) (#1251)
- **Feature**: SMI-5012 PR-1 — W1 cloud foundations (migration + edge function + MCP read path) (#1245)
- **Fix**: SMI-5056 bump startup-probe.test.ts spawn budget 10s → 30s (#1269)
- **Chore**: SMI-5039 — `probeEmbeddingCapability()` migrated from inline
  helper in `src/index.ts` to the new shared `@skillsmith/core/embeddings/probe`
  export. Behavior is bit-for-bit identical (same 2 s `Promise.race`
  timeout, same structured stderr message, same stdio invariant); the only
  change is that doc-retrieval-mcp + cli now share the same audited probe
  instead of carrying drift-prone copies. Bumps `@skillsmith/core` dep range
  to `^0.8.0` to pick up the new subpath export. No runtime change.

- **Chore**: SMI-5044 / SMI-5119 — the `StripeWebhookHandler` structural
  interface in `src/webhooks/stripe-webhook-endpoint.ts` is declared inline and
  re-exported. SMI-5044 briefly moved it to a shared `@skillsmith/billing-types`
  package; that package was unpublishable (OIDC trusted-publishing requires a
  pre-existing npm package) and consumed only via `import type`, so SMI-5119
  removed it before this version's first publish. No runtime change; consumers
  continue to `import type { StripeWebhookHandler } from '@skillsmith/mcp-server'`
  (the re-export is preserved). No `@skillsmith/billing-types` dependency.

## v0.5.2

- **Chore**: SMI-5008 remove stripe SDK from @skillsmith/core dependencies (#869) (#1262)

- **Chore**: SMI-5006 — bump `@skillsmith/core` dependency range to `^0.7.0` (BREAKING in core: billing moved to `@smith-horn/enterprise/billing`). The standalone Stripe webhook endpoint no longer imports from `@skillsmith/core/billing`; it now declares a local structural type for `StripeWebhookHandler` so production wiring (and tests) can pass in the canonical `@smith-horn/enterprise/billing` class without a workspace cycle. No runtime change for downstream MCP consumers.
- **Feature**: SMI-5009 — startup capability probe. `main()` now calls `probeEmbeddingCapability()` before connecting the stdio transport. Probe runs `EmbeddingService.checkAvailability()` inside a `Promise.race` with a hard 2 s `Symbol` timeout sentinel and a try/catch wrapper — it can neither block nor crash server boot. On success the probe is silent; when the mock fallback is engaged (`@huggingface/transformers` absent or `SKILLSMITH_USE_MOCK_EMBEDDINGS=true`), the probe emits a single structured stderr line including a remediation hint: `[skillsmith] embeddings: mock (transformers unavailable: <reason>; install @huggingface/transformers or set SKILLSMITH_USE_MOCK_EMBEDDINGS=true to silence)`. Logs are stderr-only to avoid corrupting the MCP stdio protocol frame. Companion to the `@skillsmith/core` optional-dep promotion in the same PR. (#870)
- **Chore**: SMI-4539 — track `@skillsmith/core` dependency range to `^0.6.3` (synthetic patch release verifying the npm trusted-publisher OIDC publish path, PR #1171). No functional change.

## v0.5.1

- **Feature**: SMI-4790 lifecycle-tagged tool descriptions + skill auto-install (#1022)
- **Fix**: SMI-4795 thread errorCode + trustTier through install telemetry (#1014)

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
