# Changelog

All notable changes to `@skillsmith/cli` are documented here.

## [Unreleased]

- **Fix**: `saveManifest()` (`utils/manifest.ts`) computed its temp filename from just the process
  id, so two concurrent saves in the same process could collide on the same temp path and corrupt
  one of them. The temp filename now includes a random UUID suffix, with best-effort cleanup of
  only that invocation's own temp file on failure (mirrors the same fix in
  `@skillsmith/core`'s `ManifestManager.save()`) (SMI-6007).
- **Changed**: bumps `@skillsmith/core` for the SMI-5929 compatibility-ranking change —
  `SearchResponse.compatibilityHidden` is renamed to `compatibilityDeprioritized` and
  `SearchOptions` gains an optional `compatibility` field. `skillsmith search` does not currently
  expose a compatibility filter of its own (no `--compatible-with` flag, and `searchRemoteOrLocal`
  never read the old field), so this has no CLI-visible behavior change today — the entry is here
  because both renamed/added members are part of `@skillsmith/core`'s public type surface this
  package depends on (SMI-5929)
- **Fix**: `skillsmith author subagent`/`transform` now write companion-subagent files to the
  target client's own agent directory (via `@skillsmith/core`'s new `COMPANION_AGENT_TARGETS`)
  instead of always hardcoding `~/.claude/agents/` — fixes generated subagents landing in the
  wrong client's directory for `--client cursor`/`copilot`/etc (GH #2161)
- **Fix**: `recommend --context`'s keyword extraction (`commands/recommend.ts`) no longer silently
  drops real short technical terms ("git", "ci", "aws", "sql", "k8s") via a bare
  `.filter((w) => w.length > 3)` threshold — a context consisting only of such terms previously
  derived an empty stack and tripped the SMI-5896 empty-stack guard even though usable context had
  been supplied. Now uses the shared `extractContextWords()` (`@skillsmith/core`) also adopted by
  the MCP server's `skill_recommend`, so the two can't independently drift on this again (SMI-5986)
- **Fix**: `license-types.ts`'s `TIER_FEATURES` was silently missing `version_tracking`
  (individual/team/enterprise) and `skill_security_audit` (team/enterprise) versus the canonical
  `@smith-horn/enterprise` package's own feature membership — this file has no compiler backstop
  (`Record<LicenseTier, string[]>`, not `Record<FeatureFlag, ...>`), so the drift went undetected
  until a new regression test comparing the two caught it. Also adds the new `registry_approval`
  flag to the `enterprise` tier (SMI-5949 Wave 2)

## v0.8.5

- **Cadence**: Mechanical cadence alignment (no changes since v0.8.4).
- **Changed**: `skillsmith --help`'s top-level description now reads "Publish versioned agent skills to a team-scoped registry, catch drift across installs, and deprecate what's gone stale. (alias: sklx)" — part of the repo-wide messaging reframe from "skill discovery" to "agent skill lifecycle management" (SMI-5948)
- **Fix**: `search-formatters.ts`'s security-status coloring (`formatSecurityStatus`, `displaySkillDetails`) no longer renders bright green purely from `securityPassed === true` — a skill scoring just under the quarantine threshold (`DEFAULT_RISK_THRESHOLD`, 40 — lower is safer) rendered identically to one scoring near 0, misleadingly implying "very safe" for a borderline pass. Green is now reserved for a comfortably-safe pass (risk score under half the threshold, or no numeric score); a borderline pass renders yellow instead. Text ("PASS"/"PASSED") is unchanged — this is a color-only fix (SMI-5897)
- **Feature**: new `skillsmith registry install <skillId>` command (optional `--version`) — pulls a skill previously published to your team's Enterprise private registry and installs it locally, closing the publish→install gap (previously the registry could only be published to and browsed). Talks to the new `private-registry-get` Edge Function under your signed-in user JWT (`skillsmith login`) — the CLI never carries Supabase credentials directly. `403` maps to "Enterprise subscription required for your team's private registry"; a cross-team or nonexistent `skillId` both map to a non-leaking "not found", matching the Edge Function's own contract (SMI-5905)
- **Fix**: `registry-install`'s `skillId` validation rejects `.`/`..` path segments (e.g. `"team/.."`) before any network call or disk write — the same guard added at every layer of this feature's stack (SMI-5905)
- **Fix**: `skillsmith recommend --installed <ids...>` now actually feeds those IDs into the recommendation query — previously an explicit `--installed` list was reported back in the output but never fed into the empty-derived-stack guard, so a codebase where analysis detects nothing (non-Node stack, all-devDeps) still hit the guard's degraded response even though the user had already supplied exactly the escape-hatch information the guard's own guidance text asks for (SMI-5896)
- **Fix**: `skillsmith update <name>` now resolves an installed skill's registry source from `~/.skillsmith/manifest.json` — the entry `install` already writes on every successful install, looked up by the `(name, client)` key so a same-named skill installed under two clients resolves the copy the caller asked about — instead of a `SKILL.md` front-matter `id:` read that `SkillParser` never populated. `update` therefore no longer reports `"<name>" has no recorded registry source` for a normally-installed skill. When the manifest genuinely has no entry, it falls back to `SourceRecoveryService` and auto-applies only `exact`/`high`/`user-specified` matches; a speculative medium/low name match fails safe with a pointer to `sklx audit sources` rather than silently updating from a guessed source (SMI-5895)
- **Fix**: `skillsmith search -i`'s "Install this skill" action now honors `SKILLSMITH_CLIENT` — previously it always installed to the canonical Claude Code directory regardless of the environment variable, the same class of bug SMI-5894 fixed for `install`/`list`/`remove`/`update`/`sync` (SMI-5894 post-merge retro)
- **Fix**: `--accept`/`--revoke` are now rejected outright (a new `accept_disabled` validation code, before any audit/lock/file touch) while `SKILLSMITH_AUDIT_ACCEPT_DISABLE=1` is set, instead of writing a real but dormant record and printing a false "OK Accepted"/"OK Revoked" success message (SMI-5883 post-merge retro)
- **Feature**: `sklx audit security` gains `--accept <key> --reason "<why>"` / `--revoke <key>` / `--candidates` / `--list-accepted` for the new local security-acceptance allowlist — a reviewed false-positive finding can be marked accepted so it stops re-surfacing, without ever affecting rug-pull/hostile-update detection. `--accept` re-runs the real audit before matching a key (a stale key from changed content is rejected as `key_not_found`, never blindly trusted); `--revoke` resolves against the stored ledger, not the current run's candidates, since the records most worth revoking are often ones that no longer match live content. `--json` candidate output is paginated (`--page`/`--page-size`, or `--all-candidates` for the complete uncapped array) with a deterministic total ordering so no candidate is skipped or duplicated across pages (SMI-5883)

## v0.8.4

- **Cadence**: Mechanical cadence alignment (no changes since v0.8.3).
- **Fix**: `sklx logs --tail` now watches the doc-retrieval reindex CLI's structured log surface — added `'doc-retrieval'` to `commands/logs.ts`'s `TAIL_SURFACES` array (SMI-5793)

## v0.8.3

- **Chore**: bump the opentelemetry group across 1 directory with 8 updates (#1862)
- **Fix**: `utils/license-validation.ts`'s `tryLoadEnterpriseValidator()` now dynamically imports the enterprise package under its real name, `@smith-horn/enterprise` — previously imported `@skillsmith/enterprise`, a name that has never existed, so license validation silently failed for every Enterprise-tier install regardless of correct setup (SMI-5738)
- **Fix**: `getSkillsFromDirectory()` now discovers an individually symlinked skill directory (`ln -s ~/.claude/skills/foo ~/.cursor/skills/foo`) — previously `entry.isDirectory()` alone silently skipped it, since `readdir(..., { withFileTypes: true })` reports a symlinked directory as a symlink, not a directory. `getInstalledSkillsPerHarness()` also no longer collapses a symlinked skill alias across harnesses into a single row — realpath is now used only to memoize the expensive `readSkillMd()` parse and to collapse multiple aliases WITHIN one harness's own directory, while a row is still returned for every harness that observes the skill, matching the function's own "two distinct rows" docstring contract (SMI-5717) (GH #1912)
- **Change**: `compliance_reports`' displayed tier requirement expanded from Enterprise-only to Team + Enterprise (SMI-3140)
- **Feature**: per-client MCP config snippet for Grok Build (`~/.grok/config.toml`) added to `CLIENT_SNIPPETS`/`SNIPPET_DISPLAY_ORDER` in `templates/mcp-server.template.snippets.ts`, matching the new `grok` harness added to `@skillsmith/core`'s inventory scanner (SMI-5697)

## v0.8.2

- **Cadence**: Mechanical cadence alignment (no changes since v0.8.1).

## v0.8.1

- **Cadence**: Mechanical cadence alignment (no changes since v0.8.0).
- **Fix**: reduced displayed tier quota constants 10x (SMI-5558) — Community was 1,000/mo now 100/mo, Individual was 10,000/mo now 1,000/mo, Team was 100,000/mo now 10,000/mo. Display-only; actual enforcement is in `@skillsmith/mcp-server`.

## v0.8.0

- **Feature**: per-user inventory purge, hard-delete (SMI-5510, R0 Wave 1a) (#1684)
- **Fix**: 0.7.4 security hotfix — interactive-search quarantine bypass (SMI-5447) (#1656)
- **Feature**: `sklx agent install` / `uninstall` command group — installs portable agent pack (SKILL.md + shims + hooks) to detected harnesses with per-harness MCP registration (SMI-5456)

## v0.7.4

- **Security**: fix an interactive-search install path that bypassed the quarantine gate — `skillsmith search -i` → "Install this skill" no longer installs a quarantined skill (consolidated onto the quarantine-aware registry lookup shared with `install`) (SMI-5447).

## v0.7.3

- **Feature**: 0.7.3 — esbuild bundle + remote-default search + skills-search safety filters (SMI-5427) (#1651)
- **Feature**: SMI-5442 — provenance + matching fix (Local / source-identified / Pending) (#1650)

## v0.7.2

- **Fix**: tolerate EISDIR when SKILL.md is a directory in skills scan (SMI-5440) (#1640)

## v0.7.1

- **Fix**: login authenticate-only + quiet banner on machine-readable subcommands (SMI-5427) (#1628)

## v0.7.0

- **Feature**: Wave 3 — local CLI/MCP push agent (SMI-5390/5391/5392) (#1579)

## v0.6.5

- **Fix**: View-Changes accepts install's `github:owner/repo` source + main->master fallback (SMI-5408) (#1602)
- **Feature**: enrich git/plugin-recovered skills with the registry UUID (SMI-5411) (#1600)
- **Feature**: affix-tolerant registry-name matching for source recovery (SMI-5413) (#1592)

## v0.6.4

- **Feature**: recover + backfill canonical GitHub source for local skills (SMI-5407) (#1589)
- **Feature**: CLI install block + local-search filter + 9 missing quarantine tests (SMI-5358) (#1567)

## v0.6.3

- **Refactor**: SMI-5036 split oversized billing test files (#1282)
- **Feature**: SMI-5012 PR-3 — W3 Claude Code hook + CLI subcommands + manifest schema (#1255)
- **Feature**: SMI-5039 — lazy embedding-capability probe on `skillsmith
  search` (and `sklx search`). Surfaces a structured stderr warning when the
  `@huggingface/transformers` stack is unavailable so the operator knows that
  search has degraded to FTS-only. Probe is hard-bounded at 2 s and never
  throws — boot is never blocked. `--version` / `--help` short-circuit before
  the probe runs; only the `search` action triggers it. `SKILLSMITH_QUIET=true`
  suppresses the warning line for scripted use. Bumps `@skillsmith/core`
  dep range to `^0.8.0` to pick up the new `./embeddings/probe` export.

## v0.6.2

- **Chore**: SMI-5008 remove stripe SDK from @skillsmith/core dependencies (#869) (#1262)

- **Chore**: SMI-5006 — bump `@skillsmith/core` dependency range to `^0.7.0` (BREAKING in core: billing moved to `@smith-horn/enterprise/billing`). No CLI surface change; CLI does not consume the billing module directly.
- **Chore**: SMI-4539 — track `@skillsmith/core` dependency range to `^0.6.3` (synthetic patch release verifying the npm trusted-publisher OIDC publish path, PR #1171). No functional change.

## v0.6.1

- **Fix**: SMI-4917 — repair first-time install (search crash, sync drops all skills, no self-config) (#1132)

## v0.6.0

- **Feature**: SMI-4590 Wave 4 PR 5/6 — new `sklx audit collisions` subcommand runs the consumer namespace audit (mirrors the `skill_inventory_audit` MCP tool); new `sklx config get audit_mode` / `sklx config set audit_mode <preventative|power_user|governance|off>` for managing audit verbosity. Tier-revalidated: Free/Individual cannot select `power_user`/`governance`. (#950)
- **Feature**: SMI-4590 Wave 4 PR 1/6 — new `sklx audit advisories` subcommand for legacy security-advisory checks (the original `audit` semantic). Step 0b extracts shared audit-tool-dispatch into a reusable module. (#899)
- **Feature**: SMI-4590 Wave 4 PR 2/6 — `FrameworkAdapter`/`claudeCodeAdapter` plumbing wired through the CLI to support multi-framework audits in future. (#913)
- **Chore**: SMI-4575 npm keywords add `agent-skills`, `cursor`, `copilot` — unblocks discovery beyond the `claude-code` keyword as the rebrand sweep generalises to multi-client. No CLI behaviour change.
- **Bump**: `@skillsmith/core` dep range to `^0.6.0` — pulls in the new audit subpath exports and multi-client install paths.
- **Bump**: `@skillsmith/mcp-server` dep range to `^0.5.0` — required because `audit-collisions.ts` imports from `@skillsmith/mcp-server/audit`, which gained new types and exports in mcp-server 0.5.0.
- **Bump**: minor version (0.5.12 → 0.6.0) signals new CLI subcommand surface — `audit collisions`, `audit advisories`, `config set audit_mode`.

## v0.5.12

- **Bump**: requires `@skillsmith/core` ≥ 0.5.6 to pick up the SMI-4486 schema-init fix that finally lets fresh installs run `skillsmith sync` without missing-table errors (#795).

## v0.5.11

- **Fix**: SMI-4486 call initializeSchema after createDatabaseAsync in sync + audit (#791)

## v0.5.10

- **Fix**: SMI-4474 auto-load JWT so logged-in CLI commands count toward quota (#786)
- **Fix**: SMI-4454 post-login hint — 'skills list' → 'search mcp' (cli 0.5.9) (#759)

## v0.5.9

- Version bump

## v0.5.8

- **Feature**: SMI-4454 CLI login UX — paste feedback + device context on /device (#751)
- **Fix**: SMI-4447 /account/cli-token auto-detect existing key + SMI-4441 error copy (#749)
- **Feature**: SMI-4402 Wave 3 — RFC 8628 device-code OAuth flow (CLI/MCP/website) (#740)

## v0.5.7

- **Refactor**: initSkill throws InitSkillError instead of process.exit (SMI-4314) (#642)
- **Fix**: `skillsmith author init` now reports a friendly error and cleans up
  partial output when a file operation fails. When an init is run against a
  pre-existing directory that the user confirms to overwrite, the existing
  directory is preserved on mid-scaffold failure instead of being removed
  (SMI-4289, closes #602).

## v0.5.6

- Version bump

## v0.5.5

- **Other**: SMI-4190: release cadence docs — ADR-114 + CHANGELOG backfill + CONTRIBUTING (#552)

## v0.5.4

- **Fix**: Version bump to align with core 0.5.1 and mcp-server 0.4.9 floors (#548).

## v0.5.3

- **Docs**: bump internal submodule for SMI-4181/4184 GSC audit plan (#539).

## v0.5.2 (2026-03-24)

- **Unified Install Command**: `skillsmith install` now supports both registry names and GitHub URLs (SMI-3484).

## v0.5.1 (2026-03-21)

- **Fix**: npm registry regression — core dependency version gap resolved (SMI-3537).
- **Security**: Remediated 14 identified security gaps across CLI commands (SMI-3506).

## v0.5.0 (2026-03-06)

- **Skill Scaffolding**: `skillsmith create <name>` scaffolds new Claude Code skills with SKILL.md template, README, CHANGELOG, and optional scripts directory (SMI-3083).
- **Version Diff**: `skillsmith diff` compares installed skill versions with change classification.
- **Version Pinning**: `skillsmith pin` / `skillsmith unpin` to lock skills to specific versions.
- **Security Audit**: `skillsmith audit` checks installed skills against security advisories.
- **Skill Name Validation**: Names must match `/^[a-z][a-z0-9-]*$/`.

## v0.4.3 (2026-03-06)

- **Security**: Remediated 14 security gaps across CLI commands including path traversal, shell injection, and ANSI escape injection (SMI-3506).
- **WASM migration**: Migrated to `createDatabaseAsync` and deprecated synchronous schema exports (SMI-2721 Wave 2).

## v0.4.2 (2026-02-23)

- **Fix**: Updated core dependency to v0.4.12 for @huggingface/transformers migration.

## v0.4.1 (2026-02-23)

- **Fix**: Credential storage exports — pins core@0.4.11 for `storeApiKey`, `clearApiKey`, `getAuthStatus`.

## v0.4.0

- **CLI Authentication**: `skillsmith login` opens your browser, you copy the API key and paste it — done. Stored securely in your OS keyring.
- **Session Commands**: `skillsmith logout` clears stored credentials; `skillsmith whoami` shows your current auth status and key source.
- **Headless/CI Support**: `skillsmith login --no-browser` prints the URL for environments without a display. Use `SKILLSMITH_API_KEY` env var for fully non-interactive auth.

## v0.3.1

- **Database Fix**: Fixed "no such table: skills" error on fresh installations
- **API Resilience**: Improved handling of partial API responses
- **Import Improvements**: Better rate limiting (150ms default, configurable via `SKILLSMITH_IMPORT_DELAY_MS`)
- **Python Support**: Added Python file detection (`.py`, `.pyi`, `.pyw`) to `analyze` command

## v0.3.0

- **Registry Sync**: Keep your local skill database up-to-date with `sync` command
- **Auto-Sync**: Configurable daily/weekly background sync during MCP sessions
- **Sync History**: Track sync operations with `sync history`

## v0.2.7

- **MCP Server Scaffolding**: Generate TypeScript MCP servers with `author mcp-init`
- **Custom Tool Generation**: Auto-generates stub implementations for specified tools
- **Decision Helper Integration**: Seamless flow from evaluation to scaffolding
- **Subagent Generation**: Generate companion specialist agents for parallel execution (37-97% token savings)
- **Skill Transform**: Upgrade existing skills with subagent configuration
- **Dynamic Version**: Version now reads from package.json automatically
- **Tool Detection**: Automatic analysis of required tools from skill content
- **Live Skills**: Search and install from 14,000+ real skills
- **Faster Search**: Full-text search with quality ranking
- **Privacy First**: Opt-out telemetry, no PII collected
