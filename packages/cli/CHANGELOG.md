# Changelog

All notable changes to `@skillsmith/cli` are documented here.

## [Unreleased]

- **Fixed**: SMI-6961 / ADR-175 § 1 -- commands no longer proceed against an empty database when
  your local one is corrupt. The shared opener caught the driver's refusal, renamed the **main file
  only** -- orphaning any `-wal` against a rebuilt database -- and returned, so the command ran to
  completion against nothing and reported success. It now surfaces the refusal, with a remedy naming
  the file and the `mv` to run.

  **No command gets a repaired database, and none proceeds against an empty one** -- including
  `search`, `info` and `remove`, each of which could have served from the remote API or the
  filesystem without a database. Uniform refusal was chosen deliberately over degrading those three:
  one code path is far harder to regress than fourteen plus three exceptions. Move the database aside
  as the message instructs and every command works again.

  What is uniform is the **refusal**, not the control flow. Most commands stop at the first failure
  and exit 1. `skillsmith update` instead reports a failure per skill and continues, then exits 1 --
  on a corrupt database that means every installed skill is reported as failed. `skillsmith list`
  degrades deliberately, showing `Unknown` for each skill rather than a count it cannot verify. An
  earlier draft of this entry said every command "aborts", which was never true of `update`.

  The message tells you to **move** the files, never delete them, and it now says why: a sync
  rebuilds the registry mirror, but it does **not** rebuild rows you created locally. Skills added
  with `skillsmith import-local` are tagged `source='local'` specifically so sync -- `--force`
  included -- will not overwrite them, and quarantine review decisions have no registry source
  either. An earlier draft of both this entry and the refusal itself claimed the database "holds no
  data that cannot be rebuilt from the registry". That was false, and it was the sentence telling
  you there was nothing to lose.

- **Fixed** (behaviour change for scripts): SMI-6961 -- `skillsmith update` now exits **1** when any
  skill failed. It previously printed a red `Failed: N` and exited **0**, so a script wrapping the
  command read total failure as success. On a corrupt database every installed skill lands in that
  bucket, which made it the same silent-success defect this release exists to remove.

  Keyed on failures only. A **skipped** skill still exits 0: a skip is a decision the command made
  on purpose (`local-drift`, `identity-mismatch`), and reporting those as a process failure would
  make a correct refusal look like a malfunction. If you have automation that tolerates partial
  update failures and checks only the exit status, this will start failing for you -- check the
  `Failed:` count in the summary instead.

- **Fixed**: SMI-6961 -- an error that no command handled used to print your absolute home path and
  a stack trace. `program.parse()` does not await an async action's promise, so a rejection escaped
  to Node, which printed the raw message -- bypassing the sanitizer that exists to replace home
  paths with `~`. Every such failure now prints one sanitized line and exits 1.

  Found in review of the change above, and newly reachable because of it: `search` opens its
  database outside any `try`, so once the opener stopped swallowing corruption refusals, a corrupt
  database on `skillsmith search` took exactly that route. The fix is at the entry point rather than
  at those two call sites, so a command added later with the same shape cannot reintroduce it.

- **Test**: SMI-6946 / ADR-175 -- coverage for the two `list` output paths a pre-merge gate showed
  were unobservable. `warnUndetermined` appeared in **zero** test files, so no mutation to it could
  be caught, and the gate named one that survived the whole suite: relocate that call one line later,
  past the `--outdated` early return, and a run against a wholly unreadable database prints **nothing
  at all** and exits 0. The green "All installed skills are up to date." is gated on
  `undetermined.length === 0` and the yellow partial line on `undetermined.length < skills.length`, so
  with the warning unreachable both are correctly suppressed and nothing replaces them -- SMI-6946's
  original defect reproduced by moving one line. A second mutation, sourcing `undetermined` from
  `filtered` rather than `skills`, restores the false green line on a fully corrupt database, because
  `--outdated`'s filter keeps only `'available'`. Both are now killed (2 and 4 respectively), and a
  paired silence control forbids the degenerate fix of warning unconditionally.

  Separately, the claim that **absence is established before the open** now has a test. It asserts
  the *mechanism* -- that no open is attempted for a path that does not exist -- rather than the
  resulting status, deliberately: the native driver re-states an absent path's `SQLITE_CANTOPEN` into
  the same `current` outcome, so an outcome assertion is blind to the gate's removal, and the
  difference shows only on the WASM driver, which the CLI suite cannot exercise. Asserting the
  mechanism holds for every driver, present and future.

- **Docs**: SMI-6946 -- `describeQueryFailure`'s docblock sat immediately above
  `resolveUpdateStatus`, which has its own. Only the nearest attaches, so the first was dangling dead
  text and `describeQueryFailure` had no documentation at all. Moved to its own signature.

- **Fix (correctness)**: SMI-6946 / ADR-175 -- `skillsmith manage` and `skillsmith list` no longer
  report **"Up to date"** for every installed skill when the local database cannot be read. They
  report **"Unknown"**, name the cause once, and say so rather than asserting currency they have no
  basis for.

  The mechanism was a `boolean`. `hasUpdates` had exactly two states, the renderer printed `false` as
  "Up to date", and a bare `catch {}` commented *"DB not available yet"* turned **five** distinct
  causes into that one `false`: a database that does not exist, one that is corrupt, one we lack
  permission to read, one locked by another process, and one whose schema is wrong. Only the first
  licenses "no updates available" -- nothing is installed that could be out of date. The other four
  leave the answer unknowable, and the command was stating it anyway.

  So `hasUpdates: boolean` becomes `updateStatus: 'available' | 'current' | 'unknown'`, **replaced
  rather than kept alongside**: a surviving boolean is a second source of truth a reader can pick up
  without noticing the distinction. `--outdated` now filters on a *confirmed* newer version and
  reports how many entries it could not determine, exiting 0 -- it did what it could and says what it
  could not. Its `"All installed skills are up to date."` line, a second false statement on the same
  fault, may now only print when every skill was actually checked.

  Introduced by SMI-6931, which made the driver throw a structured-less `Error` that this consumer
  discarded; **measured as a regression**, since a read-only open of a page-corrupt file *succeeds*,
  so the path worked before. Found by a post-merge retrospective after nine reviews missed it -- every
  one scoped to the diff, and a diff does not contain its consumers.

  Two further things the implementation turned up, neither in the original report. A **second** false
  statement lived one layer in: a per-skill lookup failure also fell back to "up to date", and it is
  now classified on SQLite's result code so query-time corruption is named rather than described
  generically. And on the **WASM driver** an *absent* database reported `unknown` for every skill
  rather than `current`, because that driver succeeds on a missing path and hands back an empty
  in-memory database -- so absence is now established before the open, where no driver's behaviour can
  mask it. That one was reachable on any `npx` install without a native build, before a first sync.

- **Docs (internal)**: SMI-6733 -- two comments in `install-skill.ts` pointed at `install.ts:299-301`
  for a `resolveClientId`/`getInstallPath` pattern. Those lines held something else entirely, and had
  before this branch started: the citation rotted at some earlier edit, and nothing noticed because
  nothing checks a line number in a comment. Both now name the construct (`install.ts`'s own
  `effectiveClient` resolution) instead. Found by sweeping every `install.ts:NNN` citation in the repo
  after a cross-family review round flagged two others that a file split had shifted by 36 lines --
  four stale citations in one sweep, which is the argument for naming constructs rather than lines.

- **Fix (crash)**: SMI-6733 / SMI-6886 -- `sklx pin`, `sklx unpin` and `sklx diff` no longer break on
  a manifest whose `installedSkills` is `null`. That is not a corrupt file: ADR-171 § 5 classifies it
  `ok`, and the reader hands it back unchanged. (ADR-171 § 5 accepts both that and an absent key; § 3
  preserves the difference between them; `installedSkillsOf` normalises either to an empty map. No
  causal clause joining those three -- earlier versions of this entry carried one, and three review
  rounds on PR #2980 each found it false. See `installedSkillsOf`'s docblock in core.) Five sites then subscripted it with no
  guard (`pin.ts:85`, `:112`, `:150`, `:165`; `diff.ts:141`), all fed by a lenient loader that
  silently substitutes an empty document on any read failure. `pin`/`unpin` surfaced a raw
  `TypeError: Cannot read properties of null`; `diff` differed, because `fetchLatestContent` catches
  it and reported "check your network connection" instead of naming the real problem. All five now
  read through `installedSkillsOf`. Each is pinned by a test asserting the command's normal
  not-installed output rather than merely the absence of a throw -- an absence assertion passes
  whenever the command silently did nothing.

- **Fix (data integrity)**: SMI-6733 -- `skillsmith update` no longer replaces a manifest it could
  not read. `getSkillDiff`'s untracked-skill adoption reached `adoptUntrackedSkillEntry`, which took
  a tolerant load unconditionally: that substitutes an empty document for a corrupt, unreadable or
  version-unsupported manifest and then saves over the original bytes. Measured against a manifest
  whose readable prefix recorded a real skill followed by trailing garbage -- one `update` left a
  valid file holding only the adopted entry, and the recorded skill was gone. `update` has no
  `force` in its option surface, so nothing authorised that overwrite. Tolerance is now an explicit
  `tolerateDegradedRead` argument defaulting to refuse, and this call site passes nothing; a refused
  adoption returns a distinct outcome rather than a hard error.

- **Test**: SMI-6358 post-merge retro -- the `audit sources` already-tracked overlay's own client
  keying is now pinned. Reverting it to a bare-name lookup previously left all five audit-sources
  test files green; what pins it is the THREE-test set, not the two added here. Both new tests use
  a non-canonical client, so an always-suffixed implementation satisfies both; the arm that rules
  that out is the pre-existing default-client test, which is therefore load-bearing and must not be
  deleted as redundant. Also pins the telemetry hook script's `0o755` mode, which
  a fully-faked `chmodSync` had made invisible -- a dropped executable bit would have registered a
  hook that could not run. Corrections to comments that described mechanisms the code does not
  have. (#2920 follow-up)

- **Fix (data integrity)**: SMI-6358 -- `pin` and `unpin` gained `--client` and key through
  `manifestKeyFor(name, client)`. They previously read and wrote the bare name whatever client you
  asked for, so pinning a non-canonical install either silently did nothing or modified the
  canonical client's record instead. Client resolution matches `update`/`remove`/`install`:
  explicit flag, then `SKILLSMITH_CLIENT`, then canonical. (#2920)

- **Fix (concurrency)**: SMI-6358 -- `updateManifestEntry()` takes the same cross-process lock as
  every other manifest writer in the repo, via `ManifestManager.updateSafely()`, instead of doing an
  unlocked read-modify-write. It also reads fail-closed and returns the post-update manifest, so a
  caller needing the fresh value does not take a second unlocked read. It accepts an optional
  explicit manifest path, mirroring `loadManifest()`. (#2920)

## v0.8.12

- **Cadence**: Mechanical cadence alignment (no changes since v0.8.11).

## v0.8.11

- **Fix**: SMI-6530 -- stop recommending bulk `skillsmith update` until the safety gate ships (#2801)
- **Fix (data loss)**: `skillsmith update` writes only into the directory it compared and refuses
  otherwise, so a skill can no longer be written into a differently named directory. Skills marked
  local, and skills Skillsmith didn't install, are skipped before any source recovery or registry
  lookup instead of being resolved and overwritten. `--dry-run` no longer writes the manifest. The
  "no recorded registry source" hint no longer suggests `install --force` and names the skill by
  its directory (SMI-6529).

- **Security**: `skillsmith update --all` in CLI 0.8.8-0.8.10 can overwrite local edits in skill
  directories that are git clones and can write into the wrong directory (SMI-6528). On those
  versions, preview with `--dry-run` and update skills one at a time. This release includes the
  install-layer fix (SMI-6529).

## v0.8.10

- **Fixed**: SMI-6472 -- `src/utils/skill-name.ts`'s re-export of `VALID_SKILL_NAME_RE`/`validateSkillName` now imports from the narrow `@skillsmith/core/utils/skill-name` subpath instead of the `@skillsmith/core` package barrel. The barrel import transitively pulled in `skill-installation.io.ts` -> `safe-fs.ts`'s `fs/promises` needs (`open`/`lstat`/`constants`), breaking `tests/create.test.ts`'s narrow `fs/promises` mock (`mkdir`/`writeFile`/`stat` only) with `[vitest] No "constants" export is defined on the "fs/promises" mock`. No behavior change — only the import path.

## v0.8.9

- **Feature**: SMI-6343 Wave 3 -- tamper-check classification (#2710)
- **Added**: `skillsmith update` now refuses to force-install over an already-corrupt manifest
  entry — before overwriting the currently-installed skill, it runs the same shared tamper-
  check classification `skill_outdated` uses and skips (rather than updates) any entry
  classified `local-drift`, `identity-mismatch`, or `unknown`, naming the reason in a new
  `Skipped` bucket in the update summary (SMI-6343 Wave 3). `sklx list --outdated` similarly
  no longer reports `hasUpdates: true` for a `local-drift`/owner-mismatch/path-unresolved
  entry — only the two signals that don't require a network call (this scan is offline by
  design); a signal-2-only (front-matter) corruption still surfaces through `skill_outdated`.
- **Fix**: `skills-directory.ts`'s `hasUpdates` computation (read by `sklx list --outdated`)
  previously read a nonexistent `contentHash`/`originalContentHash` field off the *parsed
  SKILL.md* object instead of the manifest entry, so it always fell back to comparing a fresh
  on-disk hash against `skill_versions`' pre-fix metadata-proxy hash and could not correctly
  report `hasUpdates: true` (SMI-6343 Wave 2). Now reads the manifest's real recorded install
  hash and compares it via the shared `compareSkillContentHashes()` comparator, matching the
  MCP server's `skill_outdated`/`skill_updates` tools.
- **Fix**: `utils/manifest.ts`'s `saveManifest()` — a homedir-derived manifest write with no
  path-override parameter — now refuses to touch a manifest inside the real user home while
  running under vitest, via `@skillsmith/core`'s newly-exported `assertNotRealUserHome()`
  (SMI-6343 Wave 1 follow-up, adversarial review). Previously the test-run `$HOME` sandbox
  was this write path's only protection.
- **Fix**: `skillsmith registry --help` now states that publishing and listing are MCP-only
  today (`private_registry_publish`/`private_registry_manage`), pointing at those tools and
  the private-registry docs page — matching already-shipped website copy. Two external
  testers had each independently read the silent absence of `registry publish`/`list` as an
  accidental gap; no new CLI subcommands (full CLI parity is tracked separately) (SMI-6266
  Wave 8, SMI-6278)
- **Fix**: The MCP config snippet for Google Antigravity now sets `SKILLSMITH_CLIENT: "antigravity"`,
  so copying it verbatim installs skills to AntiGravity's own directory instead of silently
  falling back to Claude Code's default — the same fix Cursor got earlier. `command`/`args`
  stay plain `npx` (AntiGravity has no known `npx`-resolution problem, unlike Cursor) (SMI-6266
  Wave 7, SMI-6277)
- **Feature**: `skillsmith whoami` now shows your live effective license tier (and, when the
  live check returns one, your per-minute API rate limit) alongside the existing masked-key/
  session display, resolved via the same credential-aware `resolveEffectiveTier()` live check
  `audit advisories`/`diff`/`pin`/`audit-collisions` already use (SMI-6271) — previously
  `whoami` showed no tier information at all. Reuses the existing `formatTierBadge()` tier-badge
  formatting rather than reimplementing it. Unlike those gating commands, a transient live-check
  failure here does not block the command (this is a display command, not a gate) — it shows a
  "could not verify" message instead of ever displaying a fabricated tier, since a single-shot
  CLI invocation has no cached last-known tier to fall back to (SMI-6266 Wave 2, SMI-6272)
- **Feature**: `install`/`update`/`remove` gain a new `--scope <global|workspace>` flag
  (ADR-139, SMI-6274 Wave 4) — `workspace` resolves against the nearest ancestor workspace
  marker or `.git` root instead of the client's home-anchored global directory, creating the
  workspace skills directory if none exists yet (the only path allowed to create one implicitly).
  Precedence: `--scope` > `SKILLSMITH_SCOPE` env var > per-client `~/.skillsmith/config.json`
  default > auto-detecting an EXISTING workspace directory > global (unchanged default — no
  existing install moves, nothing changes for anyone who doesn't opt in). `remove`/`update` now
  resolve against the exact `(scope, client, name)` triple rather than "whichever scope happened
  to match by name." `list` now scans every client's workspace directory (not just Claude Code's
  repo-local one) alongside every global directory, labels each row's scope, and marks a skill
  present on disk with no manifest entry `[untracked]` instead of silently omitting it —
  `remove`/`update` now adopt such a skill (reconstructing a manifest entry from disk) instead of
  requiring `--force`. `agent install --scope workspace` can bootstrap AntiGravity as a target in
  a fresh repo by creating `.agents/skills`. `getLocalSkillsDir()` is now a deprecated thin
  wrapper delegating to the new resolver (also fixing a real bug: it previously never walked up
  from `cwd`, so `list` run from a repo subdirectory silently missed the repo-root
  `.claude/skills`)

- **Fix**: `skillsmith diagnose` now checks whether your Cursor MCP registration (both the
  global `~/.cursor/mcp.json` and any project-scoped copy) is on the current, working config
  shape and tells you how to fix it if not — previously nothing detected this at all once the
  MCP server failed to even start, since the CLI's own update-nudge only fires from inside a
  running MCP process (GH#2368, SMI-6279)

- **Fix**: `audit advisories`, `diff`, `pin`, `config get/set audit_mode`, and `audit-collisions`
  now correctly recognize a personal `SKILLSMITH_API_KEY` or a logged-in `skillsmith login`
  session — previously they only ever checked `SKILLSMITH_LICENSE_KEY` (an offline license key
  almost nobody uses), so an Enterprise customer using either of the two common auth methods was
  always reported as Community tier (GH#2508, GH#2509, SMI-6271). Live tier verification now
  fails closed on a network/timeout error rather than silently passing or downgrading a real
  paying customer

- **Fix**: `skillsmith login` (device-code flow) now refuses cleanly for SSO-provisioned users
  instead of silently logging into the wrong account. Prints the server's refusal message and
  points to the personal-API-key alternative (`/account/cli-token/` + `SKILLSMITH_API_KEY`).
  Server-supplied error text is sanitized (control characters, bidi-override characters) before
  being written to the terminal. Part of SMI-6206.

- **Breaking**: `sync` (and `sync config --enable`) now require Team+ tier — Community and
  Individual tiers can no longer bulk-download the skill registry. The registry has grown far
  larger than this feature was designed for (hundreds of thousands of records, still growing),
  with no size warning or cost boundary until now. Enforced both client-side (fast, friendly
  failure) and server-side (a new `registry-sync` Edge Function, so a direct API call or an
  older CLI can't bypass the gate). Before syncing, the CLI now shows a live record count
  fetched from the registry and asks for confirmation — pass `-y`/`--yes` to skip the prompt for
  scripted/automated use (`--json` implies `--yes`). No deprecation window; see ADR-136 for the
  full rationale (SMI-6236). Adversarial security review before merge found and fixed a real
  regression in the client-side gate: it originally resolved tier from `SKILLSMITH_LICENSE_KEY`
  only, which a user authenticated via the documented `skillsmith login` flow never has set —
  such a user would have been incorrectly blocked as "community" even on a real Team plan. The
  gate now resolves tier from whichever credential the sync request actually authenticates
  with, deferring to the server's own response when it can't be resolved offline

## v0.8.8

- **Fix**: logout/whoami now detect JWT device-code sessions (#2578)
- **Fix**: `skillsmith logout` and `skillsmith whoami` now detect a JWT device-code session
  (`skillsmith login`'s default flow, SMI-4402) — previously they only checked the legacy
  API-key store, so `login` would report "Already authenticated" while `logout` immediately
  after reported "Not authenticated. Nothing to log out.", a stuck loop with no way to
  actually end the session. `logout` now clears both credential stores on confirm. (SMI-6235)
- **Docs**: README's framing sentence updated from the "lifecycle layer" tagline to a plain
  descriptive sentence ("a registry for sharing, scanning, and tracking agent skills across
  teams") as part of the site-wide positioning reframe. Wording-only. (SMI-6194)
- **Fix**: `skillsmith update` no longer force-installs an unrelated same-named registry skill
  over a locally-authored one it was never asked to replace. `getSkillDiff()` now reads the
  installed skill's own claimed author from its `SKILL.md` front-matter (`readClaimedAuthor()`)
  and only trusts a local-registry-cache bare-name match when it agrees with the cache row's
  author — scanning every same-name cache row for the matching author, not just the first one
  found — otherwise it falls through to the existing confidence-gated manifest/`SourceRecoveryService`
  path instead of silently substituting the wrong author's skill. Confirmed real incident: two
  personal, unclaimed skills were overwritten with unrelated registry content this way (SMI-6103)
- **Fix**: the CLI's tier-gating messages (`require-tier.ts`) and `ab-test`'s upgrade prompt
  (console and JSON `price` field) hardcoded the literal unpublished Enterprise price
  (`$55/user/month`) — now `Custom pricing — Contact Sales`, matching the documented "unpublished"
  pricing policy (SMI-6069, GH#2368-adjacent follow-up from SMI-5893)

- **Fix**: The Cursor MCP snippet (root README, `@skillsmith/mcp-server`'s README, and the website) no longer defaults to `npx`, which failed inside Cursor on two separate live UAT passes (a real Cursor-bundled-Node ENOENT). The copied `command` is now a resolved-path placeholder (`which`/`where skillsmith-mcp`) that can never point at a wrong path; `npx` stays documented as an explicit, clearly-labeled fallback. Also fixed in the canonical CLI snippet matrix (`templates/mcp-server.template.snippets.ts`, used to scaffold non-Skillsmith MCP servers via `skillsmith author mcp-init`): its Cursor placeholder was hardcoding the literal binary name `skillsmith-mcp` instead of deriving it from the scaffolded server's own package name, and `{{name}}` was never interpolated in a snippet's `notes` text at all — either bug would leak Skillsmith-specific text into a scaffolded (non-Skillsmith) server's generated README (SMI-5893 Wave 11, GH#2368 C-01)
- **Fix**: Community-tier quota corrected from a stale `1,000` to the actual `100` API calls/month in `displayLicenseStatus` (SMI-5893 Wave 11, GH#2368 C-19)
- **Fix**: `list`/`manage`'s footer "local: ..." segment, and `inventory status`'s
  "Local skills: ..." line, both hand-typed the literal `./.claude/skills`
  independent of `getLocalSkillsDir()`'s own path segments — now sourced from a
  new `getLocalSkillsDirDisplay()` (`utils/local-skills-dir.ts`), which derives
  from `getLocalSkillsDir()`'s actual return value via `path.relative()` rather
  than reconstructing it from a separately-shared constant, so the two genuinely
  can't drift apart (the `inventory status` instance was found as a sibling gap
  during review — same bug class, second call site this wave hadn't touched
  yet). Displayed text is unchanged in both places — SMI-1630's repo-local
  convention still applies regardless of `--client`. `local-skills-dir.ts` is a
  small new module split out of `utils/skills-directory.ts`, which was
  approaching (not over — corrected from an earlier miswritten changelog entry)
  the 500-line standard (SMI-6060)

## v0.8.7

- **Fix**: Cursor UAT follow-up — website onboarding, CLI/MCP parity, hooks schema (#2375)
- **Chore**: removed 3 confirmed-dead exports flagged by the new `code-health-auditor` skill's first real dogfooding run (SMI-6023) — `displayQuotaProgressBar`/`displayQuotaWarning` (`utils/license.ts`, superseded by inline rendering in `displayLicenseStatus`) and `getTrustTierColor` (`commands/search-formatters.ts`, a one-line wrapper — real call sites already index `TRUST_TIER_COLORS` directly), plus the now-dead re-export of `getTrustTierColor` from `commands/search.ts`. No public API surface change — `packages/cli` ships as a bin-only bundle with no `exports`/`main`/`types` field. 3 other candidates the scan flagged were verified as false positives (same-file callers the tool's coverage check missed) and kept.
- **Fix**: `list --client cursor`'s footer no longer hardcodes `~/.claude/skills` — it now names the resolved client's actual install path, via `manage.action.ts` reusing the existing `getInstallPath(client)` pattern (SMI-5893 Wave 7, GH#2368)
- **Fix**: `recommend`'s footer no longer hardcodes `~/.claude/skills` either — since `recommend`'s auto-detection scans across every installed client rather than one, the footer now describes multi-harness detection accurately instead of naming one client path. `recommend --context` also dedupes duplicate rows by `skill.id` (client-side mitigation; the schema-level root cause stays with the separately-tracked SMI-5898) (SMI-5893 Wave 7, GH#2368)
- **Feature**: `skillsmith setup` (`install-skill.ts`) gains `--client <id>` support, installing to the resolved client's path instead of always `~/.claude/skills/skillsmith/` (SMI-5893 Wave 7, GH#2368)
- **Fix**: `--quiet`/`SKILLSMITH_QUIET` is now wired once via a commander `preAction` hook at the CLI root instead of being duplicated per-command, and reuses the shared `isQuietModeEnabled()` check instead of a narrower literal-`'true'` comparison. Fixes a real bug where the new root `--quiet` flag was silently shadowing `install`/`registry-install`/`merge`'s own pre-existing local `--quiet` flags (SMI-5893 Wave 7, GH#2368)

## v0.8.6

- **Fix**: Harden manifest concurrency (uninstall lock, temp-file races) (#2331)
- **Feature**: `antigravity` (Google Antigravity) is now a supported `--client` value across install/list/remove/update/sync and the generated MCP-server config snippet (`skillsmith install --client antigravity` / `SKILLSMITH_CLIENT=antigravity`) — companion-subagent output uses Antigravity's own directory-package convention (`.agents/agents/<name>/agent.md`), not the flat file every other client gets. `VALID_CLIENT_HINT` also picks up `grok`, which was a pre-existing gap (SMI-5697 added the client but never updated this help text) (SMI-5982)
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
