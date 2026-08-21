# Changelog

All notable changes to `@skillsmith/core` are documented here.

## [Unreleased]

- **Feature**: new `resolveSessionTier` client (`sync/license-status-client.ts`, SMI-6098) —
  authenticates the stored device-login session against `/license-status` (proactively refreshing
  via the existing `resolveAccessToken` helper) so the MCP server can resolve a real subscription
  tier for a `skillsmith login` session with no separately-configured `SKILLSMITH_API_KEY`.
  Throws `SessionTierAuthError` (no session / refresh failed) or `SessionTierTransientError`
  (network error, HTTP 429/5xx, unexpected response) so callers never conflate "couldn't check"
  with a definitive `community` result.
- **Fix**: `analyzeMarkdownContext`'s indented-code-block heuristic (4+ spaces or a tab = a
  markdown documentation example) was being applied unconditionally to every scanned file,
  including the new Gap 8 extended siblings — real, non-markdown source files. Since virtually all
  indented Python/Ruby/Perl/etc. control-flow bodies match this pattern, it silently downgraded
  `sensitive_path` findings from `high` to `medium` and blocked `escalateCodeExecution`'s
  co-signal escalation path in those files, discovered via a genuine multi-signal backdoor fixture
  (a `~/.ssh` read next to a `curl|bash`) that failed to escalate to `critical` purely because its
  containing function body was indented. `analyzeMarkdownContext`/`scanSkillContent` (both edge
  twins) and core's `SecurityScanner.scan()` now take an `isMarkdown` parameter (default `true`,
  byte-identical behavior for every existing caller) that the indexer's extended-sibling scan path
  and `bundled-sibling-scan.ts`'s executable-code candidates now pass `false` for.
- **Feature**: scoped bundled-file scan expansion to operational code (SMI-6033 Wave 2, Gap 8) —
  the final wave of the ClawHavoc scanner-gap remediation initiative. The indexer previously only
  ever read `SKILL.md` plus 7 fixed sibling filenames, never `scripts/`, `src/`, or `bin/`, so a
  backdoor buried mid-function in otherwise-working operational code was structurally invisible to
  the scanner. New `fetchRepoTreeEntries` (run-scoped memoized, budgeted via
  `MAX_TREE_FETCHES_PER_RUN`/`SKILLSMITH_MAX_TREE_FETCHES_PER_RUN`, default 300) fetches the
  repo's git tree once per repo per run; `enumerateExtendedSiblingTargets` deterministically ranks
  and caps (`MAX_EXTENDED_SIBLING_FILES = 20`) executable-code candidates (`.sh .py .js .mjs .cjs
  .ts .rb .php .ps1 .pl`) by SKILL.md-reference, entry-point naming, path depth, then lexicographic
  order. Two new `skills` columns (`scan_coverage_incomplete`/`scan_coverage_note`) record — never
  silently — when the extended selection couldn't cover everything (count cap, size cap, a
  transient sibling-fetch failure, a Trees API fetch failure, a truncated tree response, or a
  spent per-run fetch budget); a clean 404 does not count. Surfaced in `get_skill`, `search`, and
  `skill_recommend` output as a plain informational caveat (never a rejection signal). Local
  `skill_rescan`/`skill_validate` gets the same ranked, capped selection via
  `bundled-sibling-scan.ts`'s `collectExecutableCodeFiles` (replacing the narrower `.sh`-only
  `collectShFiles`), closing that module's own documented Phase-3 follow-up — this narrows its
  existing local scan-file cap from 50 to 20 to match the registry-side cap, an intentional
  behavior change, not a pure addition.
- **Fix**: adversarial review of the above (2026-08-16) found that applying the existing
  sibling-rejection rule (any `code_execution`/`obfuscated_directive` finding on a non-doc sibling
  standalone-quarantines) unchanged to the new extended surface would have quarantined ordinary
  installer scripts — a `scripts/install.sh` using the industry-standard `curl | bash` idiom
  (rustup, Homebrew, nvm, bun) scores the SAME `code_execution:medium` finding as an actual
  backdoor, and the plan's own policy is explicit that a bare `curl | bash` must never
  standalone-quarantine. `mergeSiblingScans`/`isExecutionThreat` now require `critical` severity
  for a `code_execution` finding to drive rejection specifically on an extended-surface sibling
  (reached only via the existing co-signal escalation model, i.e. a real secondary signal like a
  `~/.ssh` read nearby) — the original 7 fixed siblings' rejection rule is completely unchanged.
  `obfuscated_directive` remains rejectable at any severity on both surfaces (delta-gated against a
  real decode step, no legitimate-installer shape). The Deno edge indexer's Trees-API memoization
  and per-run fetch budget, previously documented as "run-scoped" on the (incorrect) assumption
  that each invocation is a fresh process, are now actually reset at the top of every
  `Deno.serve` invocation (`index.ts`) — left unreset, a warm isolate could silently report a stale
  scan as fully covered.
- **Fix**: `prompt-source.ts`'s `agent-pack` T2 quota-forecast job body still had the stale
  `1,000-call`/`10,000 calls` quota numbers, while the committed `packages/mcp-server` bundled
  SKILL.md output was hand-corrected to `100-call`/`1,000 calls` — generator and committed
  artifact had drifted, which `agent-pack.assets.test.ts`'s byte-identical drift-gate test would
  have failed on merge. Fixed at the actual generator source so the two stay in sync
  (SMI-5893 Wave 11, GH#2368 C-19)
- **Fix**: `formatUpdateNotification` (`utils/version-check.ts`) now includes `result.updateCommand`
  again — an earlier draft dropped the "how do I get the new npm version" instruction entirely
  in favor of on-disk-artifact-refresh commands, which run against the still-old installed
  binary and never upgrade anything; both instructions are necessary and neither substitutes the
  other. The message also now names the artifact-refresh commands (`setup --force[--client]`,
  `agent install`) needed to pick up hooks/SKILL.md/agent-pack changes, since upgrading the npm
  package alone never rewrites those. New `resolveUpdateNotificationClient()` resolves
  `SKILLSMITH_CLIENT` for this message without ever throwing (the only call site awaits it inside
  a `.then()` with an empty `.catch()`, so an uncaught throw on an invalid env value silently
  dropped the entire notification) and without guessing `'claude-code'` when unset (only Cursor's
  generated config sets this env var; defaulting would point every other client at the wrong
  install path) (SMI-5893 Wave 10, GH#2368 C-06/C-07/C-22)
- **Fix**: Cursor `hooks.json` installation (`agent-pack-installer.cursor-hooks.ts`) now cleans up
  dead legacy `hooks.SessionStart`/`hooks.SessionEnd` keys a pre-Wave-8a install wrote before this
  file's key-casing was corrected — those never got removed once the correct keys started being
  written, so a re-merge left both the correct entries and the orphaned legacy ones in the same
  file. Skips the cleanup entirely when either wire call reports a top-level-default conflict
  (`ensureTopLevelDefaults`), since the real installer deliberately wrote nothing in that case and
  running cleanup regardless would still silently delete the user's legacy hooks with nothing
  installed to replace them. `hookEntryCommand` (`agent-pack-installer.harness.ts`) and
  `writeBackup` (`agent-config-merge.json-array.ts`) are now exported for reuse by this cleanup
  instead of being duplicated (SMI-5893 Wave 10, GH#2368 C-07)
- **Fix**: PR #2375 post-merge review follow-up (three findings). `recommend`'s shared footer text no longer claims detection "across all clients" — each surface (CLI, MCP) scans exactly one client per call, never a union. Cursor `hooks.json` installation's `ensureTopLevelDefaults` now fails closed (`status: 'conflict'`, no write) instead of silently preserving an existing incompatible top-level value (e.g. a wrong `version`) while still merging hook entries in (SMI-5893)
- **Fix**: Restored two verified drift points between the core and edge (production) security
  scanners — the edge co-signal escalation set now includes `sensitive_path` (matching core), and
  the edge `escalateCodeExecution` gained the SMI-5880 locality gate so a co-signal elsewhere in a
  long document can no longer escalate a distant, unrelated `code_execution` finding. Exported
  `AUTHORITY_CLAIMING_AFFIXES` from `typosquat.ts` (previously module-private) for reuse by a
  planned decoy-URL detector (SMI-6033 Wave 1)
- **Feature**: two new security scanner detectors (SMI-6033 Wave 3). `gatekeeper_bypass`
  (`SecurityScanner.compound.ts`) fires standalone-critical on an `xattr -c` (clear all extended
  attributes) or `xattr -d com.apple.quarantine` command when the target basename correlates with
  a fetch destination elsewhere in the content — uncorrelated usage stays medium; a later fix in
  this wave also adds a trust-tier carve-out (see below). `archive_evasion` (new
  `SecurityScanner.archive.ts`) detects password-protected archive usage via two sub-signals — CLI
  invocation syntax (`unzip -P`, `unrar x -p<pw>`, `7z x -p<pw>`, `zip -P <pw> ... -e`) and prose
  co-occurrence (an archive noun + a password noun within a bounded ±2-line window) — and reaches
  standalone-critical only when the CLI form carries an inline literal (not `$VAR`, not a
  placeholder) password AND the archive's target basename correlates with a fetch destination
  elsewhere in the content; every other shape (out-of-band password, uncorrelated CLI usage, or
  prose-only mention) stays medium/advisory. Both new finding types share the top-tier
  weight/coefficient (2.0/0.40) already used by `code_execution`/`obfuscated_directive` — severity
  alone (not a second weight tier) produces the two-outcome split. Both are wired into
  `SecurityScanner.scan()` and mirrored byte-for-byte into the edge twins
  (`supabase/functions/_shared/` and `scripts/indexer/_shared/`).
- **Feature**: paste/snippet-host reputation detector (SMI-6033 Wave 3, Gap 4). Two reputation
  tiers (`patterns.ts`): `ANON_PASTE_HOSTS` + `URL_SHORTENER_DOMAINS` require real execution
  evidence (direct pipe to an interpreter, npx direct-exec, or a later chmod/exec/source
  correlation) to reach standalone-critical; `TRANSIENT_TRANSFER_HOSTS` (transfer.sh, file.io,
  tmpfiles.org, temp.sh) is always medium, never critical — a deliberate exception for legitimate
  debugging/incident-response fetches of ephemeral reproducers. `extractUrls` is promoted from a
  private `SecurityScanner.ts` method to a shared `SecurityScanner.urls.ts` export so the existing
  `scanUrls` detector and the new one (`SecurityScanner.paste-host.ts`, finding type
  `paste_host_fetch`) share a single URL-extraction implementation. A paste-host URL that is merely
  linked/mentioned, or fetched-but-not-executed, gets no new finding — it stays covered by the
  existing `scanUrls` `url`:medium finding, unchanged. Shares the same top-tier weight/coefficient
  (2.0/0.40) as `gatekeeper_bypass`/`archive_evasion`. Wired into `SecurityScanner.scan()` and
  mirrored byte-for-byte into the edge twins (`supabase/functions/_shared/` and
  `scripts/indexer/_shared/`).
- **Feature**: encoded-payload decode-and-recursively-rescan detector (SMI-6033 Wave 3, Gap 2).
  Rather than a heuristic "this looks suspicious" flag, the new detector (`SecurityScanner.encoding.ts`,
  finding type `encoded_payload`) finds a contiguous base64-alphabet run (`[A-Za-z0-9+/]{120,}={0,2}`
  — the character class's deliberate exclusion of `-`/`_` is what keeps base64url-encoded JWTs out,
  not a separate check), skips a candidate immediately preceded by a `data:image/`, `data:font/`, or
  `data:audio/` prefix (benign data-URI blobs) or larger than ~200KB, attempts exactly one base64
  decode, and — only when the result is valid UTF-8 with a plausible-text printable-character ratio —
  recursively invokes the SAME scanner's full detector suite against the decoded text, folding its
  findings into the outer `findings` array. This reuses the entire pattern arsenal instead of
  duplicating it: a decoded `curl|bash` natively trips `code_execution` at its own top-tier severity,
  exactly as if the attacker had shipped it undecoded. Recursion is bounded to depth 1 STRUCTURALLY,
  not by convention — `SecurityScanner.ts`'s new private `runDetectors(content, lineContexts,
  skipEncodedPayload)` method is what both the outer scan and the encoded-payload detector's own
  recursive rescan call, and the rescan callback always passes `skipEncodedPayload: true`, so a base64
  blob discovered inside already-decoded content can never itself be decoded. Two resource bounds cap
  the cost of a single document scan: `MAX_BASE64_CANDIDATES = 8` per document and an aggregate
  `MAX_DECODED_TOTAL_BYTES = 256_000` across all candidates. Each finding folded in from decoded
  content carries a new `decodedFrom` field (`types.ts`) set to the OUTER document line the blob was
  found on — the same provenance-marker role `filePath` already plays for a sibling-file finding. The
  wrapper `encoded_payload` finding itself is deliberately advisory-tier only (weight 1.2 / coefficient
  0.04 — the `sensitive_path`/`typosquat` tier, NOT the 2.0/0.40 tier the other three Wave 3 detectors
  use), since the escalation this gap achieves comes for free from whatever the decoded content's own
  findings already are. Wired into `SecurityScanner.scan()` and mirrored byte-for-byte into the edge
  twins (`supabase/functions/_shared/` and `scripts/indexer/_shared/`).
- **Fix**: `SecurityScanner.archive.ts` and `SecurityScanner.paste-host.ts` (SMI-6033 Wave 3) each
  had a direct `.match(...)`/`.test(...)` call that bypassed this scanner's established
  `safeRegexTest`/`safeRegexCheck` ReDoS-safe wrappers, flagged by CodeQL as a polynomial regular
  expression on uncontrolled data. Routed all 8 call sites through the wrappers, matching the
  convention already used everywhere else in the scanner, and mirrored the same fix into both edge
  twins (`supabase/functions/_shared/` and `scripts/indexer/_shared/`), adding a local
  `safeRegexCheck` helper alongside the existing local `safeRegexTest` in each Node-port file
  (the edge twins can't share an import across the git-crypt boundary)
- **Feature**: `decoy_misdirection` URL-misdirection detector (SMI-6033 Wave 4, Gap 6). Catches a
  skill fetching from a domain that doesn't match a vendor brand/authority claim made nearby in
  the skill's own prose (e.g. "the official Anthropic toolkit" fetched from an unrelated domain).
  Reuses `BRAND_ALIASES`/`AUTHORITY_CLAIMING_AFFIXES` from the existing typosquat detector, plus a
  new `BRAND_CANONICAL_DOMAINS` map (`BRAND_ALIASES`' values are GitHub owner slugs, not DNS
  domains — a gap not present in the plan's literal text, resolved during implementation).
  Advisory-tier only (weight 1.2/coefficient 0.04, matching `typosquat`/`sensitive_path`/
  `encoded_payload`) — never standalone-critical, per the plan's reconciliation table. Extracted
  `calculateRiskScore` out of `SecurityScanner.helpers.ts` (which crossed the 500-line file gate
  once this detector's breakdown wiring landed) into a new sibling `SecurityScanner.risk-score.ts`.
  Wired into `SecurityScanner.scan()` and mirrored byte-for-byte into the edge twins
  (`supabase/functions/_shared/security-scanner-edge.decoy.ts` +
  `security-scanner-edge.brand-data.ts`, `scripts/indexer/_shared/` twins).
- **Feature**: `CO_SIGNAL_MIN_SEVERITY` escalation model replaces the flat
  `CODE_EXECUTION_CO_OCCURRENCE` co-signal set (SMI-6033 Wave 4, Gap 1 + Gap 6). Path (a) — one
  co-signal at or above its type's "high" minimum — is byte-identical to the pre-existing
  behavior for the original four types (`data_exfiltration`, `privilege_escalation`,
  `sensitive_path`, `obfuscated_directive`). Path (b) is new: at least two DISTINCT advisory-tier
  types (`decoy_misdirection`, `archive_evasion`, `paste_host_fetch`, `gatekeeper_bypass`), each
  non-documentation-context and within the existing 40-line locality window, escalate a weak
  `code_execution` finding to critical — the direct fix for skills combining several individually
  sub-threshold signals. Also lands Gap 1: a new `IMPERATIVE_FETCH_EXEC_PROSE` pattern set catches
  natural-language install-and-run imperatives with no shell syntax ("download the installer from
  thisurl.com and run it"), strengthening (not replacing) the precise low-FP literal-syntax
  detector. Bumps `SCANNER_RULESET_VERSION` to `2026-08-15.1` (local MCP audit baseline scope
  only).
- **Fix**: two real false-positive bugs found by a cross-model (GPT-5.6-Sol) adversarial review of
  the `CO_SIGNAL_MIN_SEVERITY` model and the `decoy_misdirection` detector above, both reproduced
  and pinned with regression tests before fixing. (1) Path (b)'s confidence gate was originally
  relaxed to `confidence !== 'low'` for ALL eligible types, but `archive_evasion`'s prose-only
  sub-signal and `decoy_misdirection`'s no-authority-affix form are both `confidence: 'medium'` by
  construction — same as `paste_host_fetch`, the type the relaxation was actually meant to unblock
  — so two fuzzy medium-confidence signals could co-escalate a weak `code_execution` finding on
  completely benign content (reproduced: a benign vendor mention + a real vendor `curl|bash` + an
  unrelated archive-password prose mention scored 51/quarantined before the fix, 23/clean after).
  Narrowed the confidence carve-out to ONLY `paste_host_fetch`; every other type now requires
  `confidence: 'high'`, matching the plan's literal text. (2) `escalateCodeExecution` never
  checked the `code_execution` finding's OWN documentation context, only the co-signal's — a
  finding inside a fenced security-research example could still be escalated by genuine non-doc
  co-signals elsewhere in the document. (3) Two detector-precision fixes in `decoy_misdirection`
  itself: a URL merely mentioned in prose on the same line as an unrelated fetch-verb usage (e.g.
  `curl --version; see mirror docs at <url>`) was wrongly treated as the fetch target — fixed with
  a strict `isActualFetchTarget` tokenization check; and the authority-affix search scanned the
  entire ±5-line correlation window instead of the brand token's own line, letting an unrelated
  nearby "official"/"authorized" phrase wrongly inflate confidence to `high` — scoped to the brand
  token's own line. All four fixes applied identically to both edge twins.

## v0.11.7

- **Fix**: Cursor UAT follow-up — website onboarding, CLI/MCP parity, hooks schema (#2375)
- **Feature**: SMI-5879 Wave 1 -- implement G-5 fixture-corpus corroboration (#2354)
- **Fix**: Cursor's `hooks.json` is now written in Cursor's actual native schema (`{ version: 1, hooks: { sessionStart: [{ command }] } }`) instead of Claude Code's entry shape (`{ matcher, hooks: [{ type, command }] }`) — the prior shape was silently invalid, and Cursor drops all hooks when the required top-level `version` key is missing. New `install/agent-pack-installer.cursor-hooks.ts` builder, split out from the shared Claude/generic JSON-hooks installer since the two schemas are structurally different, not just differently-keyed (SMI-5893 Wave 8, GH#2368)
- **Feature**: bundled agent-pack SKILL.md generation (`services/agent-pack/skill-md.ts`) now includes a "CLI Fallback" section, matching the pattern already shipped in `@skillsmith/cli`'s bundled skill, so an agent with a disconnected MCP server has a documented fallback instead of instructing dead tool calls (SMI-5893 Wave 6, GH#2368)
- **Feature**: new `services/recommend-guard.ts` shared helper (footer-text + dedup-by-`skill.id`) used by both `@skillsmith/cli` and `@skillsmith/mcp-server`'s `recommend` implementations, replacing two independent hardcoded-footer implementations (SMI-5893 Wave 7, GH#2368)

## v0.11.6

- **Fix**: Harden manifest concurrency (uninstall lock, temp-file races) (#2331)
- **Fix**: code-review follow-up on the Antigravity `directory-package` companion-agent path (two BLOCKING findings). (1) `resolveCompanionAgentPath()` gains an explicit 3rd `baseDir` param (default `process.cwd()`) instead of letting Antigravity's relative `dir` resolve implicitly against whatever `process.cwd()` happens to be at the exact `fs` call that consumes the path — wrong for the long-running MCP server, whose cwd is fixed at launch and does not track the calling editor/agent's real project. `writeInstallFiles()` gains a matching optional `companionBaseDir` param, threaded through both its callers (`SkillInstallationService.install()` via a new `companionBaseDir` constructor param, and `installFromContent()`); the MCP `install_skill` tool gains an optional `cwd` input field passed through as `companionBaseDir` so a caller can supply its real project root. (2) `resolveCompanionAgentPath()`'s `directory-package` branch now rejects an unsafe `skillName` (`''`, `'.'`, `'..'`, or containing `/`/`\`) before building the path — `skillName` becomes its own path segment in this mode, so `'..'` would otherwise `path.join`-normalize outside the intended companion-agent directory. Not exploitable through either current caller (both already sanitize `skillName` upstream), but the function is exported/reusable with no validation of its own, so it now enforces the same "last line of defense" standard already applied to `skillNameFromSkillId()` (SMI-5982)
- **Feature**: `antigravity` is now a real `ClientId` (`install/paths.ts`) — `CLIENT_NATIVE_PATHS['antigravity'] = ~/.gemini/config/skills`, un-deferred from `compatibility/slugs.ts`'s `BROWSE_ONLY_SLUGS` (which now only contains `gemini`), and given its own `CLIENT_TO_COMPATIBILITY_SLUG` entry. `CompanionAgentTarget.fileMode` gains a second value, `'directory-package'` (Antigravity only today) — a per-skill subdirectory `<dir>/<skillName>/agent.md`, instead of every other client's flat `<dir>/<name>-suffix.md`; `resolveCompanionAgentPath()` is now mode-aware. Antigravity's companion-agent output is project-scoped (`.agents/agents/<name>/agent.md`, relative to the invocation directory) — this CLI has no existing global-vs-project install-mode distinction to hook into, confirmed by grep, so global scope (`~/.gemini/config/agents/`) is a fast-follow, not implemented here (SMI-5982)
- **Fix**: `writeInstallFiles()`'s rollback path could leave behind an orphaned, empty per-skill companion-agent directory when a new `directory-package`-mode install (Antigravity) failed partway through — every other client's agents dir is shared and pre-existing, so this hazard never applied to them. Cleanup uses a non-recursive `rmdir`, a safe no-op when the directory was never created or holds unexpected surviving content (SMI-5982)
- **Fix (BLOCKING, PR-review follow-up)**: the prior `resolveCompanionAgentPath()` fix's `baseDir: string = process.cwd()` default only closed the cwd-dependence bug for the ONE call site that happened to pass it explicitly (the MCP `install_skill` tool) — every other production `SkillInstallationService`/`installFromContent()` call site (7 more, audited via `grep -rn "new SkillInstallationService(" packages/`) still silently fell back to `process.cwd()`, including the private-registry `install` MCP action, which has no per-call cwd input to source a correct value from at all. `baseDir` is now **structurally required** (no default) whenever the target client's `CompanionAgentTarget.fileMode === 'directory-package'` — closing the bug class by construction for every current and future caller rather than by chasing individual call sites. `writeInstallFiles()`'s `companionBaseDir` param, `SkillInstallationService`'s constructor param, and `installFromContent()`'s param all lost their own `?? process.cwd()` fallbacks to match — an omitted value now flows through as `undefined` and fails closed with a diagnosable error (`sanitizeInstallError()`'s allowlist extended to surface it) instead of resolving against the wrong directory. The 4 CLI call sites that relied on the implicit default (`install`, `registry-install`, interactive `search`, `update`) now pass `companionBaseDir: process.cwd()` explicitly, restoring their exact prior behavior (SMI-5982)
- **Fix**: `ManifestManager` (`services/skill-manifest.ts`) had two concurrency gaps in the skill
  manifest write path. `performUninstall()` (`skill-installation.helpers.ts`) loaded the manifest,
  mutated an in-memory snapshot, and saved it back directly, bypassing the lock/`updateSafely()`
  mechanism the install path uses — a concurrent update to an unrelated entry in that window could
  be silently overwritten. `save()` also computed its temp filename from just the process id, so
  two concurrent saves in the same process could collide on the same temp path. Uninstall now
  routes its final mutation through `updateSafely()`, and both `save()` and the CLI's separate
  manifest writer now suffix the temp filename with a random UUID, with best-effort cleanup on
  failure. `load()` also now distinguishes a missing manifest file (returns empty, expected) from
  one that exists but is corrupt/unreadable (throws, instead of silently returning empty and
  risking a subsequent save erasing real state) (SMI-6007).
- **Fix**: `runMigrations()`/`runMigrationsSafe()` (`db/migration-runner.ts`) had an unguarded
  concurrent-migration race — two processes opening the same fresh DB at the same time could both
  read the same `currentVersion`, both apply the same migration, and the loser's plain
  `INSERT INTO schema_version` throw `UNIQUE constraint failed: schema_version.version`. Both now
  use `INSERT OR IGNORE`, matching the existing v1-stamp hardening in `initializeSchema()`
  (`schema.ts`, SMI-4486) that was never extended to per-migration inserts. Found via a flaky
  `startup-probe.test.ts` failure traced to a real production race, not test-only flakiness
  (SMI-6003).
- **Changed (breaking)**: `SearchResponse.compatibilityHidden` renamed to
  `compatibilityDeprioritized` — the compatibility filter is now a ranking signal, not a hard
  exclusion (SMI-5929), so results are never actually "hidden" by it anymore; the renamed field is
  precisely the count of other-tool-only results present on the *returned page*, not a corpus-wide
  or pre-page count. `SearchOptions` gains a new optional `compatibility?: string[]` field —
  `SkillsmithApiClient.search()` forwards it to the `skills-search` edge function as a
  `compatibility` CSV query param (previously never sent by any caller), letting the API rank
  results server-side, before the page is cut to the requested `limit`.
- **Fix**: companion-subagent files (the `-specialist.md` shim generated alongside an installed
  skill) were always written to `~/.claude/agents/`, regardless of which client the skill itself
  was installed for — a skill installed with `--client cursor` or `SKILLSMITH_CLIENT=cursor`
  still got its companion subagent dropped into Claude Code's own agent directory instead of
  Cursor's. New `COMPANION_AGENT_TARGETS` map (`@skillsmith/core/install/paths`) plus
  `getCompanionAgentTarget()`/`resolveCompanionAgentDir()`/`resolveCompanionAgentPath()` give each
  `ClientId` its own companion-agent directory and filename pattern, sourced from the same
  evidence table already used for skill install paths; clients with no independently-verified
  agents-dir convention default to today's existing `~/.claude/agents/` behavior rather than
  guessing (GH #2161)
- **Fix**: new shared `extractContextWords()` (`services/context-words.ts`, exported from the package root) replaces a `.filter((w) => w.length > 3)` threshold both `@skillsmith/mcp-server`'s `skill_recommend` and `@skillsmith/cli`'s `recommend --context` used independently — it was silently dropping real short technical terms ("git", "ci", "aws", "sql", "k8s") from the recommendation stack, tripping the empty-stack guard even when usable context was supplied (SMI-5986)
- **Fix**: `SqlJsDatabaseAdapter.persist()` (`db/drivers/sqljsDriver.ts`) now writes the exported database buffer atomically — to a temp file, then `renameSync` over the target — instead of a direct `writeFileSync` that truncates the file before the new bytes land. A process kill mid-write (OOM, SIGKILL, machine sleep) could previously leave a 0-byte `skills.db` on disk. `openDatabaseAsync()` (`db/schema.ts`) also now distinguishes a genuinely empty/corrupt database (zero tables) from a real legacy import (has tables, just missing `schema_version`), failing loudly with remediation for the former instead of silently stamping `schema_version=1` and running every migration against a schema that was never created — which previously crashed server startup with an opaque `no such table: skills`/`no such table: cache` error and no actionable diagnostic (SMI-5997)

## v0.11.5

- **Cadence**: Mechanical cadence alignment (no changes since v0.11.4).
- **Fix**: `SkillsmithApiClient.toSkill()` (`api/client.ts`) no longer hardcodes `riskScore: null, securityFindingsCount: 0, securityScannedAt: null, securityPassed: null` for every API-sourced skill — it now derives real values from the same `security_score`/`quarantined`/`last_scanned_at`/`security_findings` fields already present on the API response, via a new shared `deriveSecuritySummaryFromApiSkill()` (`api/security-summary.ts`, exported from the package root). This was why CLI `info`/`search` could show "Not scanned" for a skill MCP correctly reported as passed — both surfaces now derive from one implementation instead of two independently-maintained copies (formerly `packages/mcp-server/src/utils/security-summary.ts`, moved here so it can't re-diverge) (SMI-5897)
- **Fix**: two local-DB-path call sites in `@skillsmith/mcp-server` (`search.helpers.ts`'s `mapLocalSkillToSearchResult`, `get-skill.ts`'s local-DB branch) were still building a `security: { passed: null, riskScore: null, findingsCount: 0, scannedAt: null }` placeholder object unconditionally for never-scanned skills, instead of returning `undefined` — violating the same never-scanned contract the API-path fix above already enforced. New sibling `deriveSecuritySummaryFromSkillRow()` (`api/security-summary.ts`, exported from the package root) covers the pre-computed local-DB field shape (`securityPassed`/`riskScore`/`securityFindingsCount`/`securityScannedAt`, as opposed to the API row's raw `last_scanned_at`/`quarantined`/`security_score`/`security_findings` columns); `recommend.helpers.ts`'s pre-existing correct-but-duplicated inline ternary for this same shape now also calls it, so all three call sites share one implementation (SMI-5897)
- **Fix**: `SKILLSMITH_QUIET` now also suppresses `db/createDatabase.ts`'s WASM-SQLite-driver fallback notice (previously printed unconditionally, at least once per process, regardless of the env var) — this was a second, unguarded warning path in the same class C-18/C-19 fixed for the embedding-load-failure warning. The shared `isQuietModeEnabled()` guard moved from an embeddings-internal module to `utils/quiet-mode.ts` (not part of the package's public export surface) so the db layer doesn't reach into the embeddings layer for a generic env-var check; `probeEmbeddingCapability()` (`embeddings/probe.ts`) and `EmbeddingService.loadModel()`'s fallback warning (`embeddings/index.ts`) continue to share the same implementation from its new location (SMI-5897)
- **Feature**: `SkillInstallationService.installFromContent()` — installs a skill from already-resolved `{skillId, version, content}` (no GitHub fetch), reusing the existing disk-write path (`writeInstallFiles()`) so private-registry-sourced skills go through the same scan/write/manifest pipeline as a GitHub-fetched install. Scans at `community` trust tier. `writeInstallFiles()` also gains `ensureDirNoFollow()`/`mkdirNoFollow()`: every intermediate path segment of a nested sub-skill filename (e.g. `scripts/run.sh`) is now created symlink-safely, closing a path where a pre-existing symlinked intermediate directory could redirect a write outside the install path, and fixing a prior functional gap where a nested filename's parent directory was never created at all (SMI-5905)
- **Feature**: `resolveFreshAccessToken()` (`api/client.token-refresh.ts`) — shared JWT-refresh helper extracted for reuse by both the MCP server and CLI's private-registry transports (SMI-5905)
- **Feature**: `getPrivateRegistrySkillContent()` (`api/client.private-registry.ts`) — the CLI's only transport to `private_registry_skills` content, calling the new `private-registry-get` Edge Function under the signed-in user's own JWT; never carries Supabase credentials directly (SMI-5905)
- **Feature**: new `resolveSkillApiFirst()` (`@skillsmith/core/services/skill-resolution`) extracts the API-first/local-DB-fallback skill resolution `get_skill` already used into a shared helper, now also used by MCP's `skill_compare` — which previously only ever queried the local SQLite cache and, per SMI-5427, that cache is no longer kept in sync with the remote-first registry, so a real, searchable skill was often reported "not found" by compare alone. Also adds `buildEmptyStackGuidance()` (`@skillsmith/core/services/recommend-guard`), the shared empty-derived-stack guidance text used by both CLI `recommend` and MCP `skill_recommend` (SMI-5896)
- **Change**: `hashContent` and `manifestKeyFor` are now re-exported from the package root (`@skillsmith/core`) alongside the existing `@skillsmith/core/services/skill-installation-helpers` subpath, so callers outside `core` can reach them through the specifier they already import. Additive — the subpath export is unchanged (SMI-5895)
- **Feature**: new two-level owned-lock primitive at `@skillsmith/core/config/owned-lock` (`acquireOwnedLock`) replacing the single-level, age-based `acquireConfigLock` (which `config-atomic-write.ts` now implements as a thin wrapper over it). The single-level design was unsound under review: it turned "I inspected this path and concluded the holder is dead" into an unconditional destructive unlink with no mutual exclusion against another reclaimer doing the same. The new design adds a second, strict-never-auto-reclaimed reclaim lock that serializes every reclaim decision, so the authorization to reclaim can no longer go stale between being computed and being consumed. Ownership is verified on release (a token, not just file presence); ships with `StuckLockError` naming a stable `reason` for mechanical triage plus the manual-unstick procedure. Opt-out: `SKILLSMITH_LOCK_NO_AUTO_RECLAIM=1` (SMI-5883)

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
