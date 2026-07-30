# Changelog

All notable changes to `@skillsmith/core` are documented here.

## [Unreleased]

## v0.11.4

- **Fix**: Evidence-tier severity for jailbreak/ai_defence findings (#2120)
- **Fix**: `escalateCodeExecution` (`security/scanner/SecurityScanner.exec.ts`) now only escalates a `code_execution` finding to `critical` when its corroborating jailbreak/prompt-injection finding is within 40 lines of it, matching the locality bound already applied to `escalateCorroboratedMentions` (SMI-5876) — previously it escalated on any same-file match regardless of distance, the same false-positive class SMI-5876 fixed for the sibling mechanism. Fail-closed: a missing line number on either side still escalates (SMI-5880)
- **Fix**: `AD_CRLF_INJECTION` (`security/scanner/patterns.jailbreak.ts`) no longer has catastrophic-backtracking behavior — a live, exploitable production denial-of-service reachable through the public `SecurityScanner.scan()` API with no crafted payload (an ~80-byte adversarial CRLF-repeat input hung a scan for hours). The regex is rewritten with a negative lookbehind instead of an ambiguous `(?:\r\n|\r|\n){2,}` quantified alternation, verified match-language-equivalent to the old pattern (22-case fixture table + 20,000-case randomized differential fuzz, zero mismatches). Introduces a `PatternScope` model (`patterns.scope.ts`) replacing the deleted `isMultilinePattern()` source-sniffing heuristic, which was wrong in both directions (missed genuinely cross-line patterns using a bounded `[\s\S]{0,N}` class with no literal `\r`/`\n` in its source; misclassified patterns using a negated newline-excluding class as multiline anyway) — scope is now an explicit, fail-closed, per-pattern declaration with no silent default. Also narrows two SSRF word-boundary gaps and threads a content-length cap through the multiline scan passes to bound worst-case regex cost. `SCANNER_RULESET_VERSION` bumped (SMI-5881)
- **Fix**: jailbreak/`ai_defence` findings in `SecurityScanner` now carry an evidence tier (`mention`/`role_turn_with_body`/`imperative_instruction`/`instruction_override`/`state_assertion`) instead of a flat doc-context severity pair, closing a false-positive class where a skill that *documents* jailbreak/prompt-injection patterns defensively (a security-checklist skill, Skillsmith's own bundled SKILL.md, `find-skills`) scored identically to skills containing an actual attack payload — reported via third-party UAT feedback. Bare vocabulary mentions ("jailbreak", "DAN", a role-marker with no body) are capped at `low` severity in any context; genuine imperative/override/state-assertion payloads still reach `critical`/`high` even inside a fenced documentation example (documentation context is evidence, not an exemption). `JAILBREAK_PATTERNS` gains 8 new patterns (activation/persona frames, declarative jailbroken-state assertions, an obedience-compulsion pattern) closing false-negative gaps opened by demoting the bare mentions; `AI_DEFENCE_PATTERNS` gains 4 new patterns closing an equivalent gap for role-marker-plus-injected-body attacks the prior single pattern could not match on the same line. A `mention`-tier finding can still escalate to `high` when corroborated by an allowlisted, non-documentation, high/critical instruction-bearing finding (`code_execution`/`obfuscated_directive`/`data_exfiltration`/`privilege_escalation`/`ssrf`) within 40 lines. `scan()`'s `passed` expression is unchanged — the evidence tier carries the fix, not a new veto path (SMI-5876)
- **Fix**: `scanPiiPatterns`'s author-contact-email severity exemption now recognizes a markdown list bullet/numbering/blockquote/emphasis before the `author:`/`contact:`/`support:`/`email:`/`maintainer:` label (e.g. `- Email: support@skillsmith.app`) — previously only an unbulleted `Email: ...` line qualified, so a "Getting Help" section's contact bullet scored `high` PII severity purely from markdown list syntax (SMI-5876)
- **Refactor**: `scanPrivilegeEscalation` (`security/scanner/SecurityScanner.scanners.ts`) drops an unnecessary `as RegExp[]` type assertion on its `CREDENTIAL_SUBSTITUTION_PATTERNS.includes(pattern)` check (SMI-5833/SMI-5838 pattern-identity lookup) — TypeScript already infers the correct type without it; no behavior change

- **Fix**: `scanPrivilegeEscalation` (`security/scanner/SecurityScanner.scanners.ts`) now caps severity at `medium` for the two credential-substitution `PRIVILEGE_ESCALATION_PATTERNS` entries added in SMI-5833 (split out as `CREDENTIAL_SUBSTITUTION_PATTERNS` in `patterns.ts`, identified by reference), instead of the usual `high`/`critical` — the pattern pair is purely lexical and can false-positive on benign dev/test troubleshooting text carrying both required signals (e.g. "get around the 403 in local testing... mock token instead of your expired token"). Detection is unchanged; a match still surfaces as a finding for review, it just no longer blocks a skill install the way `critical`/`high` does (SMI-5838)
- **Fix**: `PRIVILEGE_ESCALATION_PATTERNS` (`security/scanner/patterns.ts`) gains two new contextual entries detecting credential/auth-level substitution used to defeat an auth check (e.g. "use the service_role key instead of your admin JWT to bypass the 403") — closes a double-miss where this exact phrasing, grammatical and lexically benign, slipped past both the internal SecurityScanner and AIDefence during a real staged-payload hardening pass (SMI-5833)
- **Fix**: `__resetLoggingStateForTests()` (`logging/rotation.ts`, test-only helper) now awaits every surface's pending write queue before closing streams and clearing state, instead of detaching it. `writeLogLine` is fire-and-forget by design; under I/O contention a write could still be queued when a test's cleanup ran, and since `resolveStream` reads `SKILLSMITH_LOG_DIR`/in-memory state live (not snapshotted), that orphaned write could land in a *later* test's fresh temp directory — a stray record (missing that later test's own fields) could then be the first line read back, failing an unrelated assertion. Reproduced under combined CPU+disk contention; never in isolation (SMI-5837)
- **Fix**: `checkForModifications()` (`services/skill-installation.io.ts`) now tolerates up to 2 seconds of clock skew between a skill's `installDate` and its on-disk mtime, instead of a strict `mtime > installDate` comparison — closes a race where `install()`'s `writeInstallFiles()` timestamp and its later `installedAt` capture could disagree by a few milliseconds under load, causing `uninstall()` to spuriously report the skill as locally modified and fail (SMI-5828)
- **Feature**: `sha256Hex` (`journal/hash.ts`) exposed from the package root — one shared content-hash implementation for every `content_hash` computation (public inventory, private registry) instead of independent inline `createHash('sha256')` copies that could silently drift. `sync/inventory-collector.ts` switched to it (SMI-5816)
- **Feature**: `logging/types.ts`'s `Surface` union gains `'doc-retrieval'`, and `logging/rotation.ts`'s `getLogDir()` gains a `SKILLSMITH_STATE_DIR_OVERRIDE` precedence tier (checked after the existing `SKILLSMITH_LOG_DIR` test seam, before the `homedir()` fallback) — lets the doc-retrieval reindex CLI's structured logs land on a Docker-bind-mounted, host-visible path instead of the container's own throwaway filesystem (SMI-5793)

## v0.11.3

- **Chore**: Migrate remaining stale references to ruflo v3 (#1952)
- **Chore**: bump the opentelemetry group across 1 directory with 8 updates (#1862)
- **Fix**: doc-comments in `telemetry/tracer.ts`/`tracer-imports.ts` referencing the optional enterprise instrumentation dependency now name the real package, `@smith-horn/enterprise` (SMI-5738; no behavior change here, see `@skillsmith/mcp-server`/`@skillsmith/cli` for the actual runtime import fix)
- **Feature**: new `@skillsmith/core/security/scanner` export subpath, exposing `stripInvisible`/`confusableSkeleton`/`CONFUSABLES` for reuse outside the package (SMI-4703) — enables `@skillsmith/doc-retrieval-mcp`'s memory-write injection scanner to reuse the same confusable/homoglyph normalization primitives `SecurityScanner.exec.ts` uses, instead of reimplementing them
- **Feature**: new `getOrCreateInstallId()` in `config/device-identity.ts` — a stable per-install telemetry identifier (`sha256(randomUUID())`), generated and persisted unconditionally regardless of legacy telemetry env-gating (SMI-5531)
- **Fix**: `saveConfig` (`config/index.ts`) is now atomic — its read-modify-write runs under a new cross-process exclusive lock (`config/config-atomic-write.ts`) and writes via temp-file-then-rename, closing a lost-update race where two concurrent writers could silently drop each other's change. This also fixes a pre-existing, independent TOCTOU race in `getOrCreateDeviceId` that shared the same unguarded writer (SMI-5531)
- **Feature**: typosquat/impersonation detector for skill names (Wave 1) — exact-confusable-skeleton match, Levenshtein edit-distance ≤2, and an independent authority-claiming-affix check (`-official`/`-verified`/`-authentic`/`-genuine`); wired into `SecurityFindingType`/`RiskScoreBreakdown`/`CATEGORY_WEIGHTS`/`calculateRiskScore` as a new `typosquat` category, plus a `typosquatEnforcementMode` (`'off' | 'warn' | 'block'`, default `'warn'`) that caps findings at `medium` severity in shadow mode. `confusableSkeleton`/`CONFUSABLES`/`isFullwidthLatin`/`isMathAlphanumeric` extracted from `SecurityScanner.exec.ts` into a standalone `confusables.ts` (no behavior change). Live wiring into the install-time scan pipeline and the `skill_audit` MCP tool (SMI-5711) are follow-ups (SMI-595)
- **Fix**: `collectDeviceSkills()` no longer collapses a symlinked skill alias across harnesses into a single inventory row — realpath now only memoizes the expensive SKILL.md read/parse/hash (never the directory-name-derived `skill_id` fallback, which is computed per-harness to avoid one harness's directory name leaking onto another's row) and only collapses multiple aliases to the same target WITHIN one harness's own directory, while an entry is still emitted for every harness that observes the skill (SMI-5717) (GH #1912)
- **Feature**: `grok` (Grok Build, xAI's coding CLI) added as a scanned harness for cross-machine skill inventory — `CLIENT_NATIVE_PATHS`/`CLIENT_IDS` in `install/paths.ts` now include `~/.grok/skills` (SMI-5697)
- **Fix**: `extractMcpReferences` now parses frontmatter `allowed-tools`/`tools` YAML (bare-server, wildcard, and full forms), detects embedded `mcpServers` JSON-registration blocks, and cross-checks every candidate server name against the project's `.mcp.json` via a new `serverResolutions` map (`registered`/`unregistered`/`unknown`) — candidates are tagged, never excluded (SMI-5676)
- **Fix**: `extractDepIntel`/`persistDependencies` pass the project's registered MCP server list via the new `getRegisteredMcpServers()` export, which fails open (not to an empty list) when `.mcp.json` is missing or unparseable
- Exported `getBestDriver`/`DriverType` from the package root, and added a `compliance_export` `AuditEventType` (SMI-3140)

## v0.11.2

- **Fix**: Expose apply_namespace_rename action:'revert'
- **Fix**: Widen `JournalAction` to include `'revert'` and bump `JOURNAL_SCHEMA_VERSION` 1→2 — an older reader's closed-set validation would otherwise flag a legitimate revert journal record as corrupt (SMI-5671) (#1878)

## v0.11.1

- **Fix**: unified shutdown coordinator + awaitable sync stop (SMI-5649/SMI-5640) (#1826)
- **Fix**: backfill skill_dependencies for pre-0.7.1 installs (SMI-5645) (#1825)

## v0.11.0

- **Feature**: production-grade error logging and diagnostics (SMI-5615) (#1774)

## v0.10.0

- **Feature**: per-user inventory purge, hard-delete (SMI-5510, R0 Wave 1a) (#1684)
- **Feature**: quarantine-hardening balance — scanner split + chmod evasion + recheck sibling re-scan (SMI-5434/5433/5437) (#1653)
- **Feature**: telemetry marker channel for agent-mediated calls — `agent_session`/`nudge_origin`/`trigger_id` wire fields + `_meta` MCP marker extraction + harness-side attribution (SMI-5456)
- **Feature**: change journal module — hash-chained, fsync'd records; foundation for undo (SMI-5456)
- **Feature**: multi-target agent-pack generator emitting SKILL.md, Claude/Codex/OpenCode/Copilot shims, hooks (SMI-5456)
- **Feature**: agent-pack installer/uninstaller with JSON-merge, manifest, path guard, per-harness reporting (SMI-5456)
- **Feature**: paywall-triggers store for Community/Individual funnel state (SMI-5456)
- **Feature**: extend ClientIds — add `opencode` and `hermes` skill paths (SMI-5456)
- **Feature**: `runWithEmissionGate` — AsyncLocalStorage-scoped, per-call telemetry emission gate; `setEmissionGate` retained as a deprecated process-wide fallback (SMI-5479)

## v0.9.0

- **Feature**: Wave 3 — local CLI/MCP push agent (SMI-5390/5391/5392) (#1579)
- **Feature**: cross-harness skill inventory — Wave 1+2 (data plane + write path) [SMI-5382] (#1574)

## v0.8.2

- **Feature**: enrich git/plugin-recovered skills with the registry UUID (SMI-5411) (#1600)
- **Feature**: affix-tolerant registry-name matching for source recovery (SMI-5413) (#1592)

## v0.8.1

- **Feature**: recover + backfill canonical GitHub source for local skills (SMI-5407) (#1589)
- **Fix**: harden writeInstallFiles rollback against out-of-bounds delete (SMI-5359 retro) (#1586)
- **Fix**: scan optional files before write; reject malicious config (SMI-5359 Wave 4.3, Gap-1) (#1580)
- **Feature**: code_execution + obfuscated_directive scoring categories (SMI-5359 Wave 4.2, core) (#1582)
- **Feature**: wire doc-context downgrade into core scanSuspiciousPatterns (SMI-5359 Wave 4.1) (#1578)
- **Feature**: CLI install block + local-search filter + 9 missing quarantine tests (SMI-5358) (#1567)

## v0.8.0

- **Feature**: SMI-5039 — new `./embeddings/probe` subpath export. Extracts the
  `probeEmbeddingCapability()` helper (originally landed inline in
  `@skillsmith/mcp-server` under SMI-5009) into `@skillsmith/core` so MCP
  servers, CLIs, and future tooling can share a single audited probe contract.
  Hard 2 s `Promise.race` timeout, try/catch wrapper, stderr-only logging, and
  honors `SKILLSMITH_QUIET=true` (or `opts.quiet`) to suppress the operator
  warning. Minor bump (additive export, no breaking change).

## v0.7.2

- **Chore**: SMI-5008 remove stripe SDK from @skillsmith/core dependencies (#869) (#1262)
- **Chore**: SMI-5009 promote @huggingface/transformers to optionalDependency + MCP startup capability probe (#870) (#1252)
- **Chore**: SMI-5006 move billing module to @smith-horn/enterprise + remove core shim (#867, #868) (#1246)

## v0.7.1

- **Chore**: SMI-5008 — removed direct dependency on `stripe`. Billing lives in `@smith-horn/enterprise` since v0.7.0; this release completes the dependency-graph cleanup. Consumers of `@skillsmith/core` no longer pull in the ~3MB Stripe SDK or its transitive deps. (#869)
- **Chore**: SMI-5009 — `@huggingface/transformers` is now an `optionalDependency` (was a regular `dependency`). Aligns the declared graph with the actual runtime contract per ADR-009: `loadTransformersModule()` already returns `null` on import failure and `EmbeddingService` already falls back to mock embeddings (`SKILLSMITH_USE_MOCK_EMBEDDINGS=true`). Consumers installing with `npm install --no-optional` (or on hosts without prebuilt ONNX binaries) now skip the ~50 MB native install and the runtime degrades gracefully to keyword-only search. To restore real embeddings, install `@huggingface/transformers` explicitly. Companion change in `@skillsmith/mcp-server`: structured stderr warning at server boot when transformers is unavailable (was previously silent). (#870)

## v0.7.0

- **BREAKING**: SMI-5006 — billing module relocated to `@smith-horn/enterprise/billing`. The `./billing` subpath export was removed (no shim was shipped), and the 27 root-level re-exports of billing symbols (`StripeClient`, `BillingService`, `StripeWebhookHandler`, `GDPRComplianceService`, `StripeReconciliationJob`, and associated types) were removed from `services.ts`. The companion enterprise feature note lands in `@smith-horn/enterprise` Unreleased.
  - **Migration**: update imports
    - Before: `import { StripeWebhookHandler } from '@skillsmith/core/billing'`
    - After: `import { StripeWebhookHandler } from '@smith-horn/enterprise/billing'`
  - **Why no shim**: a back-compat shim was attempted but proved structurally infeasible — `services.ts` → `../billing/index` (shim) → `@smith-horn/enterprise/billing` (workspace-source) → `@skillsmith/core` (`createLogger`) created a TypeScript build cycle that prevented TS from resolving named exports through the shim during core's compile. The repository-wide audit at relocation time found exactly one consumer (`packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts`), so the consumer was migrated in the same PR rather than carry the shim.
  - **createLogger / Logger** are now exported from the core public API to support enterprise billing consumers. (Internal utility promoted to public surface.)
  - **Stripe runtime dep** remains in core for one more release cycle (removal tracked in a follow-up wave) but should be considered deprecated for direct consumption from `@skillsmith/core`.

## v0.6.3

- **Chore**: SMI-4539 — synthetic patch release to verify the npm trusted-publisher OIDC publish path end-to-end (PR #1171). No functional or API change; the only source delta from v0.6.2 is the `VERSION` constant bump in `src/index.ts` (PR #1174). Published via OIDC in run 26012688904 with SLSA build provenance.

## v0.6.2

- **Fix**: SMI-4919 — the v17 migration's `skills` table-recreate (`CREATE/INSERT/DROP/RENAME`) silently cascade-deleted every `skill_categories` row. With `foreign_keys=ON` (the driver default), `DROP TABLE skills` fires the `skill_categories.skill_id → skills(id) ON DELETE CASCADE` immediately; `SyncEngine.upsertSkills()` never repopulates `skill_categories`, so category-filtered search degraded silently after the migration. The recreate now backs `skill_categories` up into a TEMP table before the drop and restores it verbatim after the rename, inside the same transaction. The false "SQLite defers FK enforcement" header comment is corrected. (#1140)

## v0.6.1

- **Fix**: SMI-4917 — repair first-time install (search crash, sync drops all skills, no self-config) (#1132)
- **Security**: SMI-4888 bump `@opentelemetry/sdk-node` 0.217 → 0.218 (resolves protobufjs transitive chain — `otlp-transformer@0.218.0` removes protobufjs entirely, PR #6629 upstream). Companion bumps: `instrumentation-http` 0.217 → 0.218, `instrumentation-runtime-node` 0.27 → 0.31, `instrumentation-undici` 0.24 → 0.28 (aligned to OTel 0.218 release wave). Closes 1 high + 6 moderate GHSAs (GHSA-q6x5-8v7m-xcrf + chain). (#1102)

## v0.6.0

- **Feature**: SMI-4587 Wave 1 PR #4 — add `indexLocalSkill` (extracted from `executeIndexLocal` in mcp-server). New subpath export `@skillsmith/core/skills/index-local` plus a top-level barrel re-export. Pure-ish helper that returns deterministic per-skill metadata for a given SKILL.md absolute path (or its containing directory). Used by both the MCP `index_local` tool (via `LocalIndexer.indexSkillDir`) and the consumer-namespace-audit `bootstrapUnmanagedSkills` default callback (replacing the PR #3 no-op stub). Frozen-fixture regression test under `packages/core/tests/fixtures/index-local/` locks the deterministic output shape so Wave 2/3/4 callers and the mcp-server LocalIndexer continue to receive identical results after extraction.
- **Feature**: SMI-4587 Wave 1 PR #3 — new subpath export `@skillsmith/core/config/audit-mode` exposes the pure `resolveAuditMode({ tier, override }) -> AuditMode` resolver consumed by the consumer namespace audit (mcp-server's `detectCollisions`). Tier defaults: community/individual → `preventative`, team → `power_user`, enterprise → `governance`; explicit override (read by callers from `~/.skillsmith/config.json` `audit_mode` or `SKILLSMITH_AUDIT_MODE` env) wins when valid. Also re-exported from the top-level `@skillsmith/core` barrel for backwards compatibility.
- **Feature**: SMI-4590 Wave 4 PR 3/6 — audit exclusions + tier-revalidation gate. `bootstrapUnmanagedSkills` honours per-tier exclusions for managed-by-Skillsmith skills; tier revalidation enforces Free/Individual cannot select `power_user`/`governance` audit modes (the resolver clamps overrides on read). (#932)
- **Feature**: SMI-4578 multi-client install paths — new subpath export `@skillsmith/core/install` exposes `ClientId` (`claude-code | cursor | copilot | windsurf | agents`; Codex users pass `agents`), `getCanonicalInstallPath()`, `getInstallPath(client)`, `assertClientId`, `resolveClientPath()` (honours `SKILLSMITH_CLIENT` env var), plus a fan-out manifest module (`addLink`, `removeLinks`, `listLinks`) backing the new `--also-link`/`--symlink` CLI flags. Manifest persisted at `~/.skillsmith/links/manifest.json` (atomic-rename); copy-default per SMI-4287 LocalFilesystemAdapter symlink rejection. Cycle detection via realpath; Windows EPERM falls back to copy. Consumed by `@skillsmith/cli` install/uninstall and `@skillsmith/mcp-server` install_skill / uninstall_skill / skill_rescan / installed-skills detection. (#878)
- **Feature**: SMI-4577 restore HNSW (Hierarchical Navigable Small World) index for `EmbeddingService.findSimilar()` — the production semantic-search hot path that was running brute-force `O(n)` on 14k skills. `hnswlib-node@^3.0.0` promoted from a transitive (claude-flow) optional dep to a first-class `optionalDependency` on `@skillsmith/core`. Brute-force preserved as `findSimilarBruteForce()` and as automatic fallback when the optional dep is absent (Vercel build, restricted hosts). New `~/.skillsmith/cache/` artifact dir (with `pathValidation` allow-list extension) for persisted indices; atomic-rename on a 5s debounce keeps concurrent writers safe. Bench: >190x p99 speedup at 14k vectors with `recall@10 = 1.000`. Opt-out: `SKILLSMITH_USE_HNSW=false`. (#858)
- **Chore**: SMI-4575 refresh `HNSWEmbeddingStore.saveIndex()`/`loadIndex()` log messages — the legacy "Index persistence managed by V3 VectorDB backend" lines were factually wrong post-SMI-4577 (V3 was decommissioned with the claude-flow → ruflo rename). They now identify as no-op shims and point callers at `EmbeddingService` for HNSW persistence. Behaviour unchanged.
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

- **Feature**: Webhook dead-letter queue — new `WebhookDeadLetterRepository`, optional `deadLetterSink` on `WebhookQueueOptions`, and `webhook-dlq` authenticated edge function (SMI-4291, closes GitHub #601)
- **Fix**: `WebhookDeadLetterRepository` gains `markResolved(id, resolvedBy?)` for operator acknowledgement and renames `listUnretried` → `listOpen` (the in-process filter now excludes both retried and resolved rows); `listUnretried` kept as a deprecated alias, removed when SMI-4322's delivery worker lands; repository types add `resolved_at` / `resolved_by` matching migration 077; `markRetried` unchanged — dormant until SMI-4322 (SMI-4308) (#647)
- **Fix**: RLS recursion on `teams` and `team_members` that caused 500s on `/account/team*` pages once any user had a membership row — migration 072 rewrites the two legacy policies to call SECURITY DEFINER helpers (SMI-4306)
- **Feature**: tree-sitter incremental parsing for Python analyzer — WASM-backed (`web-tree-sitter@0.25.10`), LRU tree cache (100 entries), query-based extraction replaces regex fallback; unchanged file re-parse ~0ms (memoised), incremental edit ~60ms on 1955-line fixture (well under 100ms target), ~27,000× speedup on cache hits vs cold parse; regression guard ensures query extraction matches or exceeds prior regex coverage on all fixtures (SMI-4293, PR #633, closes #604)
- **Feature**: team provisioning on subscription (SMI-4307) (#646)
- **Fix**: populate UndoSnapshot.backup_path in ActivationManager (SMI-4297) (#644)

## v0.5.3

- **Fix**: add missing SMI-4240 fields to ApiSearchResultSchema (SMI-4246, SMI-4247) (#611)

## v0.5.2

- **Fix**: restore category/security/repo in skill detail view (SMI-4240) (#583)
- **Other**: SMI-4190: release cadence docs — ADR-114 + CHANGELOG backfill + CONTRIBUTING (#552)

## v0.5.1

- **Fix**: SMI-4182 suppress CodeQL false positive on telemetry hash (#550 retro).
- **Feature**: `skill_pack_audit` trigger-quality + namespace collision checks (SMI-4124, PR #505)

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
