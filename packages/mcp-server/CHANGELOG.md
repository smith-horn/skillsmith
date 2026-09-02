# Changelog

All notable changes to `@skillsmith/mcp-server` are documented here.

## [Unreleased]

- **Fix**: the bundled `varlock` skill asset (`packages/mcp-server/src/assets/skills/varlock/SKILL.md`) — shipped to every customer who installs it via Skillsmith — carried stale security guidance dated December 22, 2025: a "never do this" list naming only `cat`, `echo $VAR`, `printenv | grep`, and `cat .env | grep SECRET`, plus unqualified `varlock load` recommendations blessed as safe. Corrected as a customer-visible correction to shipped security guidance: the never-do list now also names a direct `grep <pattern> .env`, `head`, `tail`, `sed`, `awk`, `strings`, inline interpreters (e.g. `python3 -c`), and a `docker exec` wrapper around any of the above (this repo's dev container bind-mounts the repo root at `/app`, so `docker exec <container> cat /app/.env` reaches the identical file); every `varlock load` recommendation in the file is now qualified — only the default pretty format redacts, while `--format json`, `--format json-full`, `--format json-full-compact`, and `--format env` all print unmasked, raw values (SMI-6361, varlock secret-exposure defense-in-depth Wave 1).
- **Fix**: `set_team_role_permission()` closed a delegation hole where a team owner could grant
  `team:manage_rbac`/`team:manage_sso` to a non-owner role, reaching the exact escalated state
  the owner-only gate existed to prevent (SMI-6319). Two new defense layers: a table CHECK
  constraint and a typed function-level refusal, surfaced through `rbac_manage`'s error mapping
  so a customer sees an authored refusal rather than a raw database error.
- **Feature**: `install_skill`/`uninstall_skill` gain `scope`/`client`/`cwd` input parameters
  (ADR-139, SMI-6274 Wave 4) — `install_skill` previously called `getInstallPath()` directly,
  the old global-only resolution, so the MCP server could never reach a workspace-scoped
  install regardless of `SKILLSMITH_SCOPE`, contradicting the ADR's stated requirement that
  the MCP server reach the identical scope resolution the CLI already has. Both tools now
  route through `resolveScopedSkillsDir()`, with the same 5-rank precedence the CLI's
  `--scope` flag uses; `SKILLSMITH_SCOPE` remains available for callers that can only set
  process env, but a per-call `scope` parameter is also exposed since this is a long-running
  server process where one env var can't express "this install workspace-scoped, that one
  global" within a single session. `uninstall_skill` additionally gained `client` (it could
  previously only ever target the canonical client's global directory). The MCP-only conflict
  pre-flight check (`conflictAction`'s entire effect — `SkillInstallationService.install()`
  itself never reads that option) now reads the scope-resolved manifest (`loadManifest()`
  gained an optional `manifestPath` argument) instead of always the global one, so it works
  correctly for both scopes rather than being gated to global only. `uninstall_skill`'s
  `--also-link` fan-out cleanup (`removeLinks()`) is now gated to `client === CANONICAL_CLIENT`,
  matching the CLI's own `remove` command guard — that mechanism has no scope or per-destination
  client awareness, so calling it unconditionally could delete an unrelated canonical install's
  fan-out links whenever a non-canonical-client copy of the same-named skill is uninstalled.
- **Feature**: SMI-6205 Wave 4 SSO member lifecycle — JIT team provisioning on login,
  seat-limit enforcement, and license-key binding/expiry tied to SSO login freshness, plus
  dual-consent identity linking between a JIT-provisioned SSO account and a pre-existing
  account sharing the same verified email (with a self-service decline/reversal path). No new
  MCP tool surface — this is the underlying `record_sso_login`/`link_sso_account` SQL and
  website flow, not a change to `configure_sso`'s own tool schema.
- **Refactor**: split `rbac-tools.ts`/`sso-tools.ts` into thin re-export modules plus new
  `rbac-tools.action.ts`/`sso-tools.action.ts` siblings holding the action-handler
  implementations, `withTelemetry`-wrapped exports, and each service singleton (SMI-5127
  convention, same split `local-inventory.helpers.ts` got below). Every existing import site
  (`index.ts`, `tool-dispatch.ts`, all `*.test.ts` files) reaches the same exports unchanged.
- **Fix**: `rbac_create_policy`'s `create`/`delete` actions now report per-permission
  success/failure (`partialResults`) instead of a bare `success:false` when a multi-permission
  batch write partially fails — a caller can now tell exactly which permissions in the batch
  actually landed. Found and fixed during SMI-6267's synthetic RBAC UAT testing.
- **Refactor**: split the path-traversal/symlink-escape guards (`joinPath`, `isSafePathComponent`,
  `isWithinRoot`) out of `local-inventory.helpers.ts` into a new sibling file,
  `local-inventory.path-safety.helpers.ts`, to bring the original file back under the 500-line CI
  cap (it had drifted to 516 lines). Re-exported from the original module so the one consumer
  (`local-inventory.ts`) needs no changes. No behavior change (SMI-6229 follow-up).
- **Feature**: `configure_sso` is now backed by a real Supabase-backed SSO service
  (`sso-tools.live.ts`), calling the new `team-sso-manage` gateway-verified edge function instead
  of the in-memory stub. `set`/`get`/`test`/`remove` configure and query a real GoTrue SAML
  provider registration; `set`/`remove` are gated on the `team:manage_sso` permission (owner-only
  by default, per SMI-6242) resolved as the caller. `configure_sso` gains two new actions,
  `claim_domain`/`verify_domain`, for proving control of a domain via DNS TXT record before it can
  be attached to an SSO configuration — a domain must be verified before `set` will register a
  provider against it. `test` is now a real round-trip to GoTrue rather than a simulated response;
  the existing `simulated?: boolean` field stays in the type and is simply absent on the live path.
  A daily `sso-domain-reverify` job re-checks each claimed domain's DNS record and disables the
  live IdP registration after repeated verification failures (SMI-6204).

## v0.7.12

- **Feature**: live RBAC service, grant-write RPCs, permission-gated website UI (SMI-6203) (#2586)
- **Feature**: add team_permission_grants RBAC schema + widen approval-gate RLS seam (SMI-6202) (#2577)
- **Feature**: `rbac_manage`/`rbac_assign_role`/`rbac_create_policy` are now backed by a real
  Supabase RBACService (`rbac-tools.live.ts`) instead of the in-memory stub, on the caller's own
  signed-in JWT — never the shared team license key or service-role. `list_roles`/`get_role` now
  return the real two-role (`admin`/`member`) / four-permission model with per-team `allow`/`deny`
  overrides, replacing the old arbitrary custom-role shape that never matched the database.
  `rbac_assign_role` takes `memberId` (the team-membership row id) instead of `userId`/`roleId`.
  Every write is gated on the `team:manage_rbac` permission, resolved server-side — a denial
  returns a structured `{ code: 'permission_denied', permission, message }` object instead of a
  raw error string, so the CLI and website can render the reason without parsing prose (SMI-6203).
- **Fix**: `skill_inventory_audit` never scanned Claude Code plugin-installed skills
  (`~/.claude/plugins/cache/**`, gated on `enabledPlugins`) or a project's own
  project-relative `.claude/skills/` mount-point — two real blind spots that let a
  collision between a vendor plugin's skill and a project's own skill go undetected on
  both sides. Adds Source 5 (plugin scan) and Source 6 (project scan) to the scanner,
  tagging entries with a new `origin: 'native-client' | 'plugin' | 'project'` field
  rather than widening the closed `ClientId` union. Both new sources guard against
  path-traversal and symlink-escape reading outside their intended root
  (SMI-6228/SMI-6240).
- **Docs**: `readEnabledPluginIds` in `local-inventory.helpers.ts` now cross-references its build-free
  `.mjs` twin (`scripts/lib/mcp-command-guard.plugin-scan.mjs`) and the parity test enforcing
  agreement between them, per ADR-137's requirement that cross-runtime duplication of
  security-relevant logic name the divergence risk explicitly (SMI-6229).
- **Fix**: `rbac_manage`/`rbac_assign_role`/`rbac_create_policy`, `configure_sso`/`sso_settings`,
  `webhook_configure`/`api_key_manage`, and `compliance_report` reported `dataSource: 'live'`
  whenever Supabase env vars were configured, even when the underlying service was still the
  in-memory stub (RBAC and SSO have no live implementation at all today). `dataSource` now
  reflects which service is actually wired in. The SSO stub's connection-test action also
  returned a fabricated real-looking success — it now carries `simulated: true` and says so
  explicitly (SMI-6184).
- **Docs**: site-wide positioning reframe (SMI-6194) — every tool description's branding clause
  ("Skillsmith is the canonical lifecycle manager for agent skills...") replaced with a plain
  descriptive sentence ("...a registry for sharing, scanning, and tracking agent skills...")
  across all 7 tool description files plus the bundled `SKILL.md` frontmatter, to avoid
  degrading LLM tool-routing with marketing copy. Same swap applied to the README's framing
  sentence, `server.json`'s registry-listing description (kept under its 100-char limit), and
  the `package.json` keywords array (`"lifecycle"` removed, `"shared-skills"`/`"governance"`
  added). Wording-only, no behavior change.

## v0.7.11

- **Fix**: 0.7.10 was uninstallable — `npx @skillsmith/mcp-server@latest --version` threw
  `SyntaxError: The requested module '@skillsmith/core' does not provide an export named
  'SessionTierAuthError'`. Root cause: 0.7.10's source imported `getApiBaseUrl`,
  `resolveSessionTier`, `SessionTierAuthError`, and `SessionTierTransientError` from
  `@skillsmith/core`, but core's published version was never bumped past 0.11.7 — the release
  that predates those exports. This package's `@skillsmith/core` dependency floor is corrected to
  `^0.12.0`, the first core release that actually contains them (SMI-6143).

## v0.7.10

- **Fix**: remove SUPABASE_SERVICE_ROLE_KEY from registry install path (#2494)
- **Fix**: remove SUPABASE_SERVICE_ROLE_KEY from customer-facing private registry reads (#2472)
- **Security**: `private_registry_manage`'s `list`, `get`, and `namespace` actions no longer
  require `SUPABASE_SERVICE_ROLE_KEY` on the MCP host. They previously ran on the Supabase
  service-role client — the backend's most powerful credential, which bypasses row-level security
  entirely — and this package's own README instructed customers to configure it on their own
  machines and distribute it via 1Password. Both the code path and that instruction are gone.
  The three reads now run as the signed-in user (`skillsmith login`) via new audited wrappers
  (`registry-tools.live.member-reads.ts`), the same `getMemberUserClient()` pattern already proven
  by `publish`/`deprecate`/`undeprecate`/`getContent`. Every existing `team_id` /
  `approval_status = 'approved'` / `deprecated = FALSE` query predicate is preserved byte-for-byte
  — RLS does not enforce the latter two, so dropping them would have silently widened what a
  member can read. All three now also write a `recordRegistryAudit()` row, making a
  license-key-team-vs-signed-in-user mismatch observable instead of invisible. `@supabase/supabase-js`
  is now a real dependency of this package (previously only a private root devDependency, so even
  a fully-configured install failed with "Supabase client unavailable"), and the anon-key client
  paths fall back to the production Supabase URL/anon key when those env vars are unset — an
  explicit override still always wins. A new `audit:standards` Check 62 fails CI if a
  service-role dependency reappears anywhere under `packages/mcp-server/src/**` outside a named,
  justified allowlist. `install`/`getContent`'s own remaining service-role dependency (its
  Enterprise-entitlement check) is removed separately below. (SMI-6109)
- **Security**: `private_registry_manage`'s `install` action (and the MCP twin of
  `getContent()`) no longer requires `SUPABASE_SERVICE_ROLE_KEY` either — the last remaining
  service-role dependency on this package's registry surface. The entitlement check ("does the
  team that owns this row currently hold an active Enterprise subscription") now runs server-side
  via a new narrowly-scoped `SECURITY DEFINER` RPC, `check_registry_team_entitlement(p_team_id)`,
  called through the caller's own signed-in member client — no admin client exists anywhere in
  `registry-tools.live.content.ts` anymore. Deliberately not built on the existing
  `resolve_effective_entitlement()`: that function's personal-subscription fallback has no team
  correlation and would let a caller with their own personal Enterprise subscription bypass the
  entitlement check for an unrelated, non-Enterprise team they merely belong to — the new RPC has
  no such fallback. (SMI-6111)
- **Fix**: the license middleware never resolved a real subscription tier for a caller
  authenticated only via `skillsmith login` (device-session, no separately-configured
  `SKILLSMITH_API_KEY`) — SMI-1953 covered the API-key path only, so every such caller silently
  fell back to `community` regardless of real (including team-inherited) entitlement, blocking
  Enterprise-gated tools like `private_registry_manage`/`private_registry_publish`. New
  `createSessionTokenResolver` (`license.tier.ts`, SMI-6098) mirrors the API-key resolver, gated
  on a device session actually existing (a cheap local check) so a never-logged-in community user
  is unaffected. Server-side, `license-status` now accepts the session JWT as an alternate auth
  mode and resolves entitlement via `get_effective_subscription_summary` (SMI-6086) — the same
  live, team-inheritance-aware RPC the website uses — with a client scoped to the caller's own
  verified JWT, never a service-role bypass. `getExpirationWarning` moved to `license.gate.ts`
  (500-line limit).
- **Docs**: `private_registry_publish`'s description also qualified "your team namespace" to
  "your team's registry namespace", closing a gap the previous SMI-6088 wording pass missed in
  the same file. Wording-only. (SMI-6088)
- **Docs**: `private_registry_manage`'s `namespace` action, `skill_inventory_audit`, and
  `apply_namespace_rename` tool descriptions now disambiguate the three previously-conflated
  meanings of "namespace" — the private registry's per-team publish prefix vs. the local
  single-machine naming-collision audit vs. the public registry's author-prefix convention.
  Wording-only; no identifier, RPC, column, or error code renamed. (SMI-6088)
- **Fix**: the upgrade-nudge message shown to a non-Enterprise user hitting a gated feature
  (`getTierComparisonMessage`, `middleware/degradation.ts`) hardcoded the literal unpublished
  Enterprise price (`$55/user/month`) — told a prospect the number before they ever talk to
  sales, contradicting CLAUDE.md's "Custom (unpublished, 'Contact Sales')" pricing policy. Now
  `Custom pricing — Contact Sales` (SMI-6069, GH#2368-adjacent follow-up from SMI-5893)
- **Fix**: `skill_inventory_audit` scanned only `~/.claude/` — its description said so accurately,
  but the underlying scope was too narrow. Now loops every supported client's native skills
  directory (`CLIENT_NATIVE_PATHS`, the same source of truth `install_skill --client` already
  uses) via `local-inventory.ts`'s `scanSkills`, unconditionally per call rather than pre-detecting
  installed clients (matching `inventory_push`'s existing `collectDeviceSkills()` precedent).
  Commands/agents/CLAUDE.md trigger-phrase scanning stays Claude Code-only — no other client has
  an equivalent construct. Tool description updated to match (GH#2368 C-12, SMI-6077)
- **Fix**: `private_registry_publish`/`private_registry_manage` couldn't resolve a team from a
  complimentary-granted (`admin-grant-subscription`) `SKILLSMITH_API_KEY` — team resolution now
  falls back to it when `SKILLSMITH_LICENSE_KEY` is unset (`SKILLSMITH_LICENSE_KEY` still wins
  when both are set). Both credentials hash into the identical `license_keys.key_hash` lookup, so
  this isn't a broadened attack surface — just a missing fallback. (SMI-6080)
- **Feature**: `get_skill`, `search`, and `skill_recommend` now surface a partial-scan caveat
  ("Note: partial scan — some files could not be analyzed (...)") when the registry's extended
  operational-code scan (SMI-6033 Wave 2, Gap 8) couldn't cover every candidate file for a skill.
  Informational only — never affects installability or the `Security:`/`Installable:` verdict
  lines above it. Shared rendering (`scan-coverage.format.ts`) translates the machine-readable
  cause token(s) persisted on the row (`scan_coverage_note`) into a human-readable phrase, so the
  three surfaces cannot drift in wording.
- **Fix**: `formatAuthenticationError`'s 401 message corrected a stale `1,000 requests/month`
  to the actual `100`, and replaced a Claude-Code-specific "Add to your Claude settings"
  instruction with a client-neutral pointer at the docs URL already passed to the formatter
  (SMI-5893 Wave 11, GH#2368 C-19)
- **Fix**: two bundled SKILL.md pricing/quota tables corrected — the `skills/skillsmith`
  copy's whole pricing table was off by 10x (Community showed 1,000 instead of 100,
  Individual 10,000 instead of 1,000, Team 100,000 instead of 10,000) and its Enterprise
  row exposed a specific price (`$55/user/mo`) that's deliberately unpublished
  (Contact Sales) — now `Custom (Contact Sales)`. The `agent-pack` copy's quota-forecast
  guidance had the same Community/Individual numbers swapped-and-scaled — also fixed at
  its actual source (`@skillsmith/core`'s `prompt-source.ts`, which generates this copy
  and had drifted from it), so the byte-identical drift-gate test stays green. Also
  corrected: `skill_suggest`'s tool description (`Community: 1,000/mo` → `100/mo`), the
  `LicenseTier` TSDoc in `middleware/license.ts` (same 10x error plus the same unpublished
  Enterprise price), and the equivalent Cursor `npx`/pricing text in both this package's
  and the root repo's README.md (SMI-5893 Wave 11, GH#2368 C-19)
- **Fix**: the auto-update-available notification now resolves `SKILLSMITH_CLIENT` via
  `@skillsmith/core`'s new `resolveUpdateNotificationClient()` instead of the throwing
  `resolveClientId` — the notification is built inside a `.then()` whose trailing `.catch()` is
  empty, so an invalid env value previously threw and silently dropped the entire notification
  rather than degrading to the generic message (SMI-5893 Wave 10, GH#2368 C-06/C-07/C-22)
- **Feature**: `skill_validate` now runs the existing (previously unwired) typosquat-name
  detector, checking a candidate skill's name against a bundled, periodically-regenerated
  reference-list snapshot of high-trust authors and top-starred skills. Warn-tier only — this
  check cannot block validation on its own (SMI-6033 Wave 1)
- **Fix**: `ZERO_BREAKDOWN` test fixtures in `src/audit` (and the mirrored copy in
  `@skillsmith/cli`) predated SMI-6033 Wave 3's four new `RiskScoreBreakdown` fields
  (`gatekeeperBypass`, `archiveEvasion`, `pasteHostFetch`, `encodedPayload`) — a real,
  pre-existing typecheck gap only a genuinely full, cross-package `tsc --build` surfaces, not a
  scoped single-package run (SMI-6033 Wave 3)
- **Fix**: `ZERO_BREAKDOWN` test fixtures in `src/audit` predated SMI-6033 Wave 4's new
  `decoyMisdirection` `RiskScoreBreakdown` field — the same class of gap as above, only a
  genuinely full cross-package `tsc --build` surfaces it (SMI-6033 Wave 4)

## v0.7.9

- **Fix**: Cursor UAT follow-up — website onboarding, CLI/MCP parity, hooks schema (#2375)
- **Fix**: both bundled SKILL.md assets (`assets/agent-pack/SKILL.md`, `assets/skills/skillsmith/SKILL.md`) now include a "CLI Fallback" section, ported from `@skillsmith/cli`'s existing one, instead of instructing MCP tool calls with no fallback when the server isn't connected. A new parity regression test in `@skillsmith/core` guards against the three bundled copies drifting again (SMI-5893 Wave 6, GH#2368)
- **Fix**: `recommend`'s footer no longer hardcodes `~/.claude/skills` — now uses a shared `recommend-guard.ts` helper (`@skillsmith/core`) so the CLI and MCP formatters can't drift, and describes multi-harness detection accurately since `recommend`'s auto-detection scans every installed client rather than one (SMI-5893 Wave 7, GH#2368)
- **Fix**: first-run install messaging (`onboarding/first-run.ts`) now names both opt-out env vars (`SKILLSMITH_SKIP_SKILL_INSTALL`, `SKILLSMITH_TIER1_AUTOINSTALL_DISABLE`) so a silent first-connect skill install is at least explainable — still emitted via stderr only (this is a stdio MCP server; stdout is reserved for JSON-RPC) and only after the fire-and-forget Tier-1 registry install actually resolves (SMI-5893 Wave 8, GH#2368)

## v0.7.8

- **Fix**: correct integration-test CI job classification (#2345)
- **Fix**: Switch search-get-flow assertions to robust sampling (#2341)
- **Fix**: Raise agent-harness-sim connect timeout, harden cleanup (#2340)
- **Fix**: Raise cold-path search-performance threshold to 250ms (#2329)
- **Feature**: `install_skill` gains an optional `cwd` input field — an absolute path to the calling client's actual project/workspace root, threaded through to `@skillsmith/core`'s new `SkillInstallationService` `companionBaseDir` constructor param. Needed because this MCP server is long-running: its own `process.cwd()` is fixed at server launch and generally does not track the calling editor/agent's real project, which previously meant a project-scoped companion-agent output (Antigravity's `directory-package` mode) could resolve against the wrong directory. Harmless for every other client, whose companion-agent `dir` is absolute already (SMI-5982)
- **Fix**: `install_skill`'s `client`/`alsoLink` params — both the zod schema (`install.types.ts`) and the raw tool `enum` (`install.tool.ts`) hardcoded a stale 5-value literal (`claude-code | cursor | copilot | windsurf | agents`) that predated `opencode`/`hermes` (SMI-5456) and `grok` (SMI-5697). Because a hand-written `z.enum([...])`/JSON-schema `enum` isn't derived from the `ClientId` type, TypeScript never caught the drift — `install_skill` was silently rejecting `client: "opencode"`/`"hermes"`/`"grok"` over MCP even though the CLI fully supported all three. Both now derive from `CLIENT_IDS`, closing this class of drift permanently instead of re-appending a 4th literal (SMI-5982)
- **Feature**: `search`'s compatibility resolution and the MCP-config setup snippets now cover `antigravity` as a real client, alongside the `@skillsmith/core` `ClientId` addition (SMI-5982)
- **Fix (BLOCKING, PR-review follow-up)**: `install_skill`'s `cwd` field validated nothing beyond "is a string" — its own description says "Absolute path to...", but a relative path or the empty string was silently accepted and would have reached `@skillsmith/core`'s `resolveCompanionAgentPath()` unvalidated. The zod schema now rejects an empty string (`'cwd must not be empty'`) and a non-absolute path (`'cwd must be an absolute path'`) with clear messages, while staying optional. Separately, `private_registry_manage(action:"install")`'s `defaultInstaller()` has no per-call cwd/workspace input at all (existing, deliberate design — see its own doc comment) and so never passed `companionBaseDir`; `@skillsmith/core`'s companion `resolveCompanionAgentPath()` fix (same PR) now makes this fail closed automatically for `directory-package`-mode clients (Antigravity) — a graceful `{success:false, error}` naming the requirement, never a thrown exception and never a silent write to this server process's own `process.cwd()`. Deliberately NOT adding a workspace-allowlist/containment system beyond schema-level absolute-path validation for `cwd` — no such concept exists anywhere else in this codebase's install pipeline, and the residual risk (a caller-chosen absolute prefix, always suffixed with the already-validated-safe `.agents/agents/<skillName>/agent.md`, containing only scanner-passed generated content) is the same trust model the CLI's own unvalidated `process.cwd()` has always used for this exact file (SMI-5982)
- **Changed (breaking)**: `search`'s compatibility filter is now a ranking signal, not a hard
  exclusion — a result whose declared `compatibility` doesn't include the requested client is no
  longer dropped, only sorted after declared-compatible and unscoped (`[]`/absent) results. Local
  results still sort ahead of API/registry results (unchanged); compat-rank only reorders within
  each bucket. Response field `compatibilityHidden` renamed to `compatibilityDeprioritized` —
  precisely the count of other-tool-only results present on the returned page, not a corpus-wide or
  pre-page count. `search`'s API-backed path now also forwards the wanted compatibility slugs to the
  registry API (previously never sent), so ranking can happen server-side, before the page is cut to
  `limit` — a client-side re-sort after the API had already paginated could never promote a
  compatible row back onto the page, which was the actual bug (SMI-5929)
- **Fix**: the startup stderr log printed either an unexpanded `~/.skillsmith/skills.db` literal
  or the raw, unvalidated `SKILLSMITH_DB_PATH` env value — neither reflected the actual path
  `getToolContextAsync()` resolved and validated. Now logs the new
  `buildDbInitializedLogMessage()` (`context.helpers.ts`), which calls `getDefaultDbPath()`
  internally, so the logged path and the real DB path can never disagree (SMI-5981)
- **Fix**: `skill_recommend`'s `project_context` keyword extraction (`tools/recommend.ts`) no longer
  silently drops real short technical terms ("git", "ci", "aws", "sql", "k8s") via a bare
  `.filter((w) => w.length > 3)` threshold — a context consisting only of such terms previously
  derived an empty stack and tripped the SMI-5896 empty-stack guard even though usable context had
  been supplied. Now uses the shared `extractContextWords()` (`@skillsmith/core`) also adopted by
  the CLI's `recommend --context`, so the two can't independently drift on this again (SMI-5986)
- **Feature**: `private_registry_publish` now requires a genuine two-party review before a version
  becomes installable — a submission lands `pending` and is invisible on every read surface
  (`list`/`get`/`install`) until a different team admin/owner approves it via three new
  `private_registry_manage` actions (`submissions`, `approve`, `reject`); self-approval is refused.
  `publish` now runs on the signed-in user's own credentials (`skillsmith login`, in addition to
  `SKILLSMITH_LICENSE_KEY`) rather than the shared license key alone, so a submission can actually
  name who submitted it (SMI-5949 Wave 2)
- **Fix**: a deprecated private-registry skill is now genuinely excluded from `list`/`get`/`install`
  and the content-read path — previously `deprecated` was documented and messaged as hiding a
  skill, but no read path actually enforced it. `list` gains an `includeDeprecated` opt-in so a
  team admin can still see what they deprecated; `get`/`install` have no equivalent opt-in (SMI-5949
  Wave 2)

## v0.7.7

- **Cadence**: Mechanical cadence alignment (no changes since v0.7.6).
- **Fix**: `mapTrustTierFromDb` (`utils/validation.ts`) gains cases for `'official'` and `'unverified'` — previously both silently collapsed to `'unknown'` via the `default` branch, even though the sibling `mapTrustTierToDb` already round-tripped both correctly. An asymmetric miss from SMI-5205, affecting all 5 MCP tools that call this mapper (`search`, `get_skill`, `skill_recommend`, `skill_compare`, `skill_suggest`) — every `TrustTier` enum value now round-trips through `mapTrustTierToDb` → `mapTrustTierFromDb` (SMI-5897)
- **Refactor**: `mapTrustTierFromDb` (`utils/validation.ts`) rewritten from a hand-written `switch`/`default` to an exhaustive `Record<DBTrustTier, MCPTrustTier>` lookup (`DB_TO_MCP_TRUST_TIER`, exported) — a `switch`'s `default` branch silently swallows any unhandled case, which is exactly how the `'official'`/`'unverified'` miss above happened with no compiler error; a missing key in the Record literal is now a compile-time error instead. No behavior change for any currently-defined `TrustTier` value (SMI-5897)
- **Refactor**: `deriveSecuritySummaryFromApiSkill` moved to `@skillsmith/core` (`api/security-summary.ts`) so `get_skill`/`search`/`skill_recommend`'s security-summary derivation and the CLI's `SkillsmithApiClient.toSkill()` share one implementation instead of two independently-maintained copies — no behavior change for MCP tool call sites, just the import path (was `../utils/security-summary.js`, now `@skillsmith/core`) (SMI-5897)
- **Fix**: `search`'s local-DB path (`search.helpers.ts`'s `mapLocalSkillToSearchResult`) and `get_skill`'s local-DB path (`get-skill.ts`) were still building a `security: { passed: null, riskScore: null, findingsCount: 0, scannedAt: null }` placeholder object unconditionally for a never-scanned skill, instead of the contractually-required `undefined` — the same class of bug the `deriveSecuritySummaryFromApiSkill` API-path fix above already closed, just on the local-DB sibling paths. Both now derive via a new shared `deriveSecuritySummaryFromSkillRow()` (`@skillsmith/core`'s `api/security-summary.ts`), which `skill_recommend`'s local-DB fallback path already had the correct logic for inline — all three call sites now share one implementation (SMI-5897)
- **Feature**: `private_registry_manage` gains an `install` action — installs a previously-published private-registry skill to disk (`~/.claude/skills` or the resolved per-client directory), closing the publish→install gap. New `getMemberUserClient()`/`getAdminUserClient()` (`registry-tools.live.auth.ts`) replace a single defaulted-boolean `getUserClient()` with two explicitly-named getters — a defaulted `requiresAdmin: boolean` was rejected in cross-provider plan review as a durable authorization footgun (silently wrong the first time a call site omits the argument). Entitlement is resolved from the private-registry row's own `team_id` (never the caller's denormalized `profiles.tier`) against that team's `subscriptions.tier`/`status`, matching the CLI transport's independent Edge Function implementation exactly. `skillId` path-traversal (`.`/`..` segments) is rejected at both the tool schema and the install boundary (SMI-5905)
- **Fix**: `skill_compare` now uses the same API-first/local-DB-fallback resolution `get_skill` already used (shared via `@skillsmith/core`'s new `resolveSkillApiFirst`) instead of only ever querying the local SQLite cache, which is no longer kept in sync with the remote-first registry (SMI-5427) — a real, searchable registry skill was often simply absent locally and compare reported it "not found" even though `search`/`get_skill` could both resolve it fine (SMI-5896)
- **Fix**: `skill_recommend` no longer calls the recommendation API (guaranteed to 400) or silently produces `candidates_considered: 0` with no explanation when the derived stack is empty (no installed skills, no usable project context) — it now detects this client-side and returns a structured degraded result with actionable guidance, matching CLI `recommend`'s identical fix (SMI-5896)
- **Fix**: `search`'s `limit` parameter is now actually threaded through to both the API-backed and local-fallback result paths, clamped to `[1, 100]` — previously advertised in the tool's description text but silently dropped, since no `limit` field existed in the input schema or type at all (SMI-5896)
- **Fix**: `skill_updates` now bounds its check to the skills recorded in the local manifest instead of running an unfiltered `SELECT DISTINCT skill_id FROM skill_versions` — a registry-wide scan that reported `updatesAvailable: 2833` for a user with a handful of skills actually installed. The installed-skill-id derivation is shared with the sibling `skill_outdated` tool (`manifest-skill-ids.helpers.ts`), and de-duplicates the two manifest entries a skill installed under two clients produces, so the two tools can't drift apart on "which skills are installed" again (SMI-5895)
- **Fix**: `buildAuditDigestPayload` (`audit/audit-notify.ts`) now excludes findings with an active local acceptance from the pushed email-digest findings list, matching `summary.malicious` (which already excluded them) — previously a user who accepted a finding specifically to stop being bothered by it kept getting emailed about it via `--email`/the automatic daily digest, and the payload's own `malicious` count and `findings[]` length could silently disagree (SMI-5883 post-merge retro)
- **Feature**: local, per-user security-acceptance allowlist (`@skillsmith/mcp-server/audit`'s `security-acceptance*` modules) letting a user mark a reviewed `SecurityScanner` false-positive finding as accepted so it stops re-surfacing in future `sklx audit security` runs — without ever affecting the separate rug-pull/hostile-update detection path (`compareScanReports` always sees the raw, unannotated scan report). Acceptance is keyed on `(contentDigest, findingFingerprint, rulesetVersion)`, never on file path or skill name, so a moved/renamed skill keeps its acceptance and a path reused by a genuinely different threat is never silently suppressed. The store is bounded, TOCTOU-free on read, and fails open (a corrupt/oversized/unreadable store degrades to "empty, every finding shown" with a structured warning, never a crash). `runSecurityAudit`'s candidate derivation is raw and verdict-independent: every finding on every scanned skill is a resolvable accept candidate, including skills that currently pass. `SKILLSMITH_AUDIT_ACCEPT_DISABLE=1` bypasses the store entirely (SMI-5883)

## v0.7.6

- **Fix**: SMI-5882 private-registry privilege hardening (#2126)
- **Fix**: Evidence-tier severity for jailbreak/ai_defence findings (#2120)
- **Fix**: `private_registry_manage`'s `deprecate`/`undeprecate` actions now require an authenticated user JWT (the same credential `skillsmith login` already provisions) instead of falling back to the unrestricted service-role client — closes a privilege-escalation gap where any team member's shared license key could deprecate or undeprecate any skill in the team's private registry, the same access only a team admin should have. Authorization is enforced by the existing `_admin_update` RLS policy in Postgres, not reimplemented in application code (SMI-5822)
- **Fix**: `registry-tools.live.ts`'s private-registry writes now record real `audit_logs` attribution (previously none) via a new `registry-tools.live.audit.ts`, correctly distinguishing the JWT-authenticated actor from the license-key path
- **Fix**: `publish_private` (Team-tier) no longer accepts `teamId` from tool input — the license-resolved value is now the only source, matching the Enterprise `private_registry_publish` path's ADR-116 discipline; also corrects its tool description, which previously implied cross-teammate visibility this local-only, single-device feature doesn't provide
- **Removed**: dead `utils/team-resolver.ts` (zero importers, a latent unhashed-license-key-comparison bug, and a name confusingly near-identical to the real `tools/team-resolver.ts`)
- **Fix**: `runSecurityAudit`'s baseline reuse now also requires the stored entry's `rulesetVersion` to match the running scanner's `SCANNER_RULESET_VERSION` (in addition to the existing threshold match) before treating unchanged content as "already scanned" — otherwise a scanner precision fix (e.g. SMI-5876) would have no effect on any skill with an existing baseline entry, since its stale stored verdict would keep being replayed indefinitely instead of being re-scanned under the new rules. An existing baseline has no `rulesetVersion` and is therefore always treated as stale on the first run after a ruleset bump — no migration needed (SMI-5876)
- **Feature**: `private_registry_publish` gets a UX pre-check surfacing a team's private-registry namespace mismatch as a typed error before ever touching the database (the DB trigger remains the actual security boundary), and `private_registry_manage` gains a `namespace` action so a team can discover its publish namespace without attempting a publish first; `publish()`'s success response now also includes `skillNamespace` (SMI-5852)
- **Feature**: `private_registry_manage`/`private_registry_publish` (`tools/registry-tools.live.ts`) — real, live implementation of the private skill registry backed by Supabase's `private_registry_skills` table, replacing the stub. Publish computes `content_hash` via `@skillsmith/core`'s shared `sha256Hex`, enforces (team, skill, version) immutability, and scopes list/get to the resolved team; deprecate/undeprecate correctly request a PostgREST representation via `.select()` so affected-row data is actually returned instead of always reporting "not found" (SMI-5816)
- **Fix**: added process-wide `uncaughtException`/`unhandledRejection` handlers — previously, any unhandled error anywhere in the running server (not just at startup) crashed the process with only a stderr stack trace, visible solely in the MCP host's live `/mcp` panel and never persisted. Both handlers now log via the existing structured logger (disk record + stderr mirror) before exiting, matching the crash-vs-continue behavior Node already had by default (SMI-5787)

## v0.7.5

- **Cadence**: Mechanical cadence alignment (no changes since v0.7.4).
- **Fix**: `middleware/license.ts`'s `tryLoadEnterpriseValidator()` and `tools/audit-tools.ts`'s `getAuditLogger()` now dynamically import the enterprise package under its real name, `@smith-horn/enterprise` — both previously imported `@skillsmith/enterprise`, a name that has never existed, so license validation and `audit_export`/`audit_query`/`siem_export` silently failed for every Enterprise-tier install regardless of correct setup. Masked in tests by a `vitest.e2e.config.ts` resolver alias with no equivalent in a real Node.js runtime (SMI-5738)
- **Feature**: `compliance_report`'s `cyclonedx` format now emits a real CycloneDX 1.5 AI/ML-BOM (`@cyclonedx/cyclonedx-library`) instead of a hand-rolled flat JSON document — component/dependency-graph construction from `skill_dependencies`, per-skill sparse-data signaling with an opt-in `backfillDependencies` option (hard-gated to the `better-sqlite3` driver), and audit logging of export events (SMI-3140)
- **Fix**: `compliance_report`'s skill inventory (`soc2`/`cyclonedx`/`json`, all three formats) now sources the installed-skill set from `~/.skillsmith/manifest.json`, not an unfiltered scan of the entire locally-indexed `skills` table, and reports each skill's real installed version instead of a hardcoded placeholder (SMI-5675)
- **Fix**: `skill_validate`'s dependency-intelligence check (`validateDependencies`) now sees frontmatter (previously received only the post-frontmatter body) and cross-checks inferred servers against `.mcp.json`, matching the SMI-5676 hardening already applied to install-time extraction
- **Change**: `compliance_report`'s tier gate (`compliance_reports` feature) expanded from Enterprise-only to Team + Enterprise (SMI-3140)
- **Change**: the `cyclonedx` format's generated BOM now carries a `skillsmith:notice` metadata property stating the export is newly launched and not yet validated at scale, matching the same caveat in release notes, until Wave 3 UAT (design-partner validation) reports back (SMI-3140)

## v0.7.4

- **Fix**: Expose apply_namespace_rename action:'revert'
- **Fix**: Expose `apply_namespace_rename`'s `action: 'revert'` — the CLI's `sklx audit revert` was never implemented and `undo_apply` only tracks same-process session state, so a rename applied in a prior session had no reachable undo path. Also fixes a shared journal-helper bug that mislabeled every genuine revert as an idempotent no-op apply (SMI-5671) (#1878)

## v0.7.3

- **Fix**: Resolve real subscription tier via personal API key (#1870)
- **Fix**: Resolve skill directory correctly in apply_namespace_rename (#1869)

## v0.7.2

- **Fix**: shorten server.json description, fix recovery text, add field-length check (SMI-5651) (#1835)
- **Fix**: unified shutdown coordinator + awaitable sync stop (SMI-5649/SMI-5640) (#1826)
- **Fix**: backfill skill_dependencies for pre-0.7.1 installs (SMI-5645) (#1825)

## v0.7.1

- **Fix**: MCP server now persists recently-installed skills and dependency data on shutdown when running without native SQLite support (common on macOS/npx installs) — previously all writes were silently discarded on exit. The server was missing a database close() call in its shutdown handler (SMI-5639).
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
