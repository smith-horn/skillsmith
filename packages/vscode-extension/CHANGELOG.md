# Changelog

All notable changes to the Skillsmith VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## v0.6.3

- **Feature**: View Changes uses the recovered manifest source for local skills (SMI-5412) (#1599)
- **Docs**: Marketplace README de-Claude-Code-specific — the audit/install copy now reflects multi-harness support; the skills directory is configurable (default `~/.claude/skills`) (SMI-5416)
### Added

- Added `npm run test:vscode` for a worktree-local vscode test path; local typecheck/test now warn on stale `node_modules` instead of failing opaquely (SMI-5343/5344).
- **New `skillsmith.cliPath` setting** — point the extension directly at your Skillsmith CLI binary for setups that automatic detection can't cover (unusual Node version managers or custom npm prefixes). Leave it empty for automatic detection.

### Changed

- Refreshed the Activity Bar icon to the Skillsmith node-graph brand mark, replacing the previous generic stack glyph.

### Fixed

- **Create Skill, Run Validate, and skill scaffolding now work under Node version managers** — when the Skillsmith CLI was installed via fnm, nvm, volta, asdf, or mise (or a custom npm prefix), VS Code couldn't find it because GUI apps don't inherit your shell's PATH. The extension now searches the known install locations for every major version manager (including the macOS and Linux fnm data dirs) and uses the full PATH on Windows, so these features stop showing a false "CLI is not installed" error. If your setup still isn't found, set `skillsmith.cliPath`.
- **Skill details recover after reconnecting** — the skill detail panel no longer stays stuck on "Skillsmith server unavailable" once the MCP server is back (including after you change an MCP setting, which restarts the connection). The panel now reloads on its own when the connection is restored, and Retry / reopening the skill works reliably. The connection status indicator in the status bar also stays accurate after a settings change.

## [0.6.2] - 2026-06-20

### Added

- **Apply inventory-audit fixes in one click** — the Audit Skill Inventory report now has **Apply rename…** buttons on suggested renames and **Apply edit…** buttons on confirmable prose edits. Each shows a preview and a confirmation before changing anything, writes a backup, and re-scans your inventory afterward so the report stays current. Edits that need manual judgement are labelled "Review and apply manually" rather than auto-applied.

## [0.6.1] - 2026-06-20

### Added

- **Deep inventory audit** — a new setting `skillsmith.inventoryAudit.deep` (off by default) runs the slower semantic-overlap pass when you Audit Skill Inventory, surfacing near-duplicate skills beyond exact namespace clashes.
- **View full text diff** — the update advisor (Check Skill for Updates) now has a "View full text diff" button that opens your installed `SKILL.md` against the registry's latest version in VS Code's native side-by-side diff editor, alongside the structured summary.

### Fixed

- Clearer "skill not found" messaging — when a skill you compare or check for updates no longer exists in the registry (or its ID is invalid), the extension now says so directly instead of showing a generic error.

## [0.6.0] - 2026-06-19

### Added

- **Post-create authoring checklist**: after creating a skill, a notification guides your next steps with **Open folder** and **Authoring docs** quick actions.
- **Recommend Skills command** — contextual skill recommendations based on your installed skills, surfaced in a quick pick.
- **Compare Skills command** — side-by-side comparison of two skills in a panel (quality, trust tier, key differences, and a recommendation).
- **Check Skill for Updates command** — compares an installed skill against the latest registry version and advises whether to update (Individual plan or higher).
- **Security advisories** — the skill detail panel now shows published security advisories for a skill (Team plan or higher), plus a finding count on failed scans.
- **Audit Skill Inventory** command — scans your local `~/.claude/` skills, commands, and agents for namespace collisions and shows a report with suggested renames.

### Changed

- Create Skill now opens a single-page form (author, name, description, type) with live name validation, replacing the step-by-step prompts.

## [0.5.0] - 2026-06-19

### Added

- **Filter Skills button** in the Skills view title bar opens a quick pick to filter discovery results by trust tier, category, and minimum score. A **Clear Skill Filters** action (shown in the title bar when filters are active) removes all active filters. Filters reset when the window reloads.
- **Persistent status banner** in the Skills view shows what you are currently viewing — your search query and any active filters — so the context is always visible, not just a momentary toast.
- Clearer empty and offline states: when no skills match your filters, the view says so and points you to clear them; when the Skillsmith server is unavailable the view says so directly; first-time users see a hint to start searching from the title bar or Command Palette.
- **Richer sidebar rows** — each available skill shows its author, category, and score inline, plus a "✓ Installed" indicator when the skill is already installed locally. Evaluate skills at a glance without opening every detail panel.
- **Detail panel product page** — a sticky header keeps the Install/Uninstall action visible while you scroll; installed skills gain **Open SKILL.md** and **Open folder** shortcuts for quick navigation.

## [0.4.0] - 2026-06-18

### Changed

- **Unified sidebar.** Search results now appear in the **Skills** view under an **Available Skills** group instead of a separate "Search Results" view. When you search, the extension opens the Skills view and reveals your results — even if the sidebar was collapsed — and shows the newest results above your installed skills.
- Removed the redundant "Found N skills" notification after a search; results appear directly in the tree (the "server unavailable" and "no results" messages are unchanged).
- The first-run welcome now points to the Skillsmith view in the activity bar and the Command Palette ("Skillsmith: Search Skills") instead of an unassigned shortcut.

### Added

- **Keyboard shortcut for search:** `Ctrl+K Ctrl+Y` (Windows/Linux) / `⌘K ⌘Y` (macOS) opens skill search.

### Fixed

- Documentation no longer advertises trust-tier and category *filtering* that the search box does not yet provide; the registry search is keyword-based and shows a trust-tier badge on each result.

## [0.3.0] - 2026-06-18

### Added

- New `skillsmith.demoMode` setting (off by default) — when enabled, the extension shows sample skills while the server is unavailable, useful for demos and screenshots.

### Changed

- Trust tier labels (Official, Verified, Curated, Community, Unverified) are now rendered consistently in the sidebar tree, search results, and the skill detail view. Previously the same tier could appear with different wording or styling depending on where you were looking.
- When the Skillsmith server is unavailable, the extension now shows a clear "server unavailable" message rather than silently falling back to placeholder sample skills.
- Actions that require a higher plan tier now show a contextual upgrade prompt with **Open Billing** and **Learn more** options instead of a generic error message.
- The welcome view now clarifies that Skillsmith works with any agent client that supports skills, not just Claude Code.

### Note

The Marketplace keyword additions (`agent-skills`, `cursor`, `copilot`) and the welcome view update first appeared in v0.2.3 but never reached the stable Marketplace channel — they are included here as the first stable release to carry them.

## v0.2.4

- Version bump

## [0.2.3] - 2026-05-06

- Marketplace keywords: add `agent-skills`, `cursor`, `copilot` so the extension surfaces beyond the Claude Code search.
- Welcome view: clarify that Skillsmith works with any agent client that supports skills, not just Claude Code.

## v0.2.2

- Version bump

## [0.2.1] - 2026-04-17

### Fixed

- Skill detail view now shows **category**, **security scan**, and **repository link** correctly. Previously these fields could render as empty or incorrect values.
- Repository section is hidden when a skill has no repository URL (previously rendered as an empty stub).
- Security scan copy now reflects the skill's trust tier — verified skills show "Pending review" while community and experimental skills show "Pending scan" when no scan result is available.

## [0.2.0] - 2026-04-14

### Added

- **Uninstall Skill** command — remove an installed skill from the command palette or the tree view context menu. Shows a confirmation dialog with the skill id and resolved path before deleting. Works even when the MCP server is disconnected.
- **Create Skill** command — four-step wizard (author, name, description, type) that scaffolds a new skill and opens its `SKILL.md` when done. Requires the Skillsmith CLI on your `$PATH`; if it's missing, the error surface offers a one-click copy of the install command.
- **Get Started with Skillsmith** walkthrough (Discover, Install, Author) accessible from the VS Code Welcome page or the `Help: Welcome` command.
- Skills view now shows both **Search** and **Create** actions when no skills are installed.
- New setting `skillsmith.mcp.minServerVersion` (default `0.4.9`) — shows a non-blocking toast with an upgrade command when the connected MCP server is older than the configured minimum.
- Anonymous usage telemetry for the new commands. Off by default: nothing is sent unless an operator configures `skillsmith.telemetryEndpoint`. Respects VS Code's `telemetry.telemetryLevel` and a new `skillsmith.telemetry.enabled` setting. No data is tied to a user account.

### Security

- Uninstall and Create refuse to operate on paths that escape the skills directory via symlink or `..` traversal.

## [0.1.6] - 2026-04-02

### Security

- MCP server is now spawned without a shell, eliminating a command-injection surface on all platforms.
- Added an allowlist for MCP spawn arguments as defense in depth.

### Fixed

- Malformed MCP responses no longer throw cryptic errors — the extension now shows a readable message and a retry button.
- The skill detail panel no longer gets stuck on "Loading…" when the MCP server fails; it shows an accessible error with a retry button.
- The `category` completion snippet now produces valid YAML.
- Hover docs now work on every top-level frontmatter field (`name`, `description`, `version`, and others).

### Added

- Common errors (connection refused, invalid JSON, and similar) now map to plain-language messages in the UI.

## [0.1.5] - 2026-03-29

### Fixed

- The inferred GitHub URL fallback no longer produces 404s for skills whose id uses a UUID segment.
- The Community trust badge color now meets WCAG AA 4.5:1 contrast.
- Repository links in the detail panel are now keyboard focusable and activate with Enter or Space.

### Added

- Clear "No repository URL available" placeholder when a skill has no repo URL, instead of a broken link.

### Changed

- The "View Repository" button only appears when the skill declares an explicit repository URL — it's suppressed when the URL was only inferred.

## [0.1.4] - 2026-03-29

### Added

- Skill descriptions now render Markdown — headers, bullets, and links display correctly.
- Repository URLs from search results flow through to the detail panel.
- Fallback GitHub URL inference for skills published with `author/name` ids.
- Confirmation dialog before opening external links to untrusted domains.

### Changed

- Heading sizes inside descriptions are capped to prevent oversized text from breaking the layout.

### Security

- External links are restricted to a trusted domain allowlist (`github.com`, `gitlab.com`, `skillsmith.app`). Inferred URLs are validated before being rendered.

## [0.1.3] - 2026-03-28

### Changed

- First stable Marketplace release.

## [0.1.2] - 2026-03-27

### Added

- `SKILL.md` content now renders in the skill detail panel, with Markdown-to-HTML sanitization.
- Long content is truncated at 10 KB with an expandable "Show full content" button.

### Security

- Rendered skill content is sanitized to strip `script`, `iframe`, and inline event handlers.

## [0.1.1] - 2026-03-20

### Added

- Live data from the Skillsmith API via the MCP client, with an automatic fallback to mock data when the server is unreachable.

## [0.1.0] - 2026-03-15

### Added

- Activity bar icon and sidebar skill tree view.
- Skill search with trust-tier and category filters. (Note: trust-tier and category filters were not implemented in this release; the inaccurate claim is corrected in 0.4.0.)
- Skill detail panel with score breakdown and metadata.
- One-click install command.
- Automatic MCP server connection with configurable timeout and reconnection.
- Offline mock-data fallback.
