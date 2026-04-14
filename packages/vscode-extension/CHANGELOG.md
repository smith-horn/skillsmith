# Changelog

All notable changes to the Skillsmith VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@vscode/test-electron` integration test harness. Integration tests run on host (not Docker) per ADR-113. New script: `npm run test:integration`. (SMI-4194)
- Shared `assertInsideRoot` path-containment helper with realpath + `path.relative` and symlink-escape protection. Used by forthcoming uninstall and create commands. (SMI-4194)
- `skillNameValidation` utility — codegen'd from `@skillsmith/cli` via `scripts/sync-skill-name-validation.mjs`; `audit:standards` enforces drift. (SMI-4194)
- `src/mcp/McpClient.patterns.md` — wrapper conventions doc for Wave 2–4 tool additions. (SMI-4194)
- `SkillTreeDataProvider.getInstalledSkills()` and `refreshAndWait()` public API, consumed by forthcoming uninstall command quickPick. (SMI-4194)
- `viewsWelcome` entry for the skills view now offers both Search and Create actions. (SMI-4194)
- `skillsmith.uninstallSkill` command — uninstalls an installed skill via the command palette quickPick or the tree view context menu. Destructive action requires modal confirmation showing the skill id and resolved path. Uses shared `assertInsideRoot` to refuse traversal and symlink-escape. Falls back to `fs.rm` when the MCP server is disconnected. (SMI-4195, closes #485)
- `skillsmith.createSkill` command — 4-step wizard (author → name → description → type) that delegates to the `@skillsmith/cli` via `cross-spawn`. If the CLI is not on `$PATH`, surfaces an actionable error with a one-click copy of the install command and a docs link. Opens the new `SKILL.md` on success and refreshes the installed-skills tree. (SMI-4196, closes #484)
- Anonymous usage telemetry for parity commands. Respects VS Code's `telemetry.telemetryLevel` and a new `skillsmith.telemetry.enabled` setting (default `true`). Anonymous cohort UUID stored in extension `globalState` — never tied to user accounts. Fire-and-forget POST to `skillsmith.telemetryEndpoint` with a 2s timeout; no endpoint configured by default, so telemetry is a no-op until an operator sets one. Events emitted: `vscode_create_{start,complete,failed,cancelled}` and `vscode_uninstall_{start,complete,failed,cancelled}`. (SMI-4194)

## [0.1.6] - 2026-04-02

### Security

- **Shell injection fix**: Removed `shell: true` from MCP server spawn, replaced with `cross-spawn` for safe cross-platform execution (SMI-3805, GitHub #423)
- Added `validateSpawnArgs()` allowlist in `utils/security.ts` for defense-in-depth input validation

### Fixed

- `callTool` no longer throws cryptic errors on malformed MCP responses — defensive JSON.parse with try/catch and response shape validation (SMI-3801, GitHub #433)
- Detail panel no longer stuck on "Loading..." forever when MCP fails — shows accessible error HTML with retry button (SMI-3802, GitHub #432)
- Category completion snippet now produces valid YAML with closing quote (SMI-3803, GitHub #425)
- Hover provider now works on all top-level frontmatter fields (`name`, `description`, `version`, etc.) (SMI-3804, GitHub #424)

### Added

- `getErrorHtml()` with CSP nonce, `aria-live="polite"`, `role="alert"`, and retry button with "Retrying..." feedback
- `mapErrorToUserMessage()` maps common errors (ECONNREFUSED, JSON parse, etc.) to user-friendly messages
- 37 new tests across 5 test files

## [0.1.5] - 2026-03-29

### Fixed

- Inferred GitHub URL fallback no longer produces 404s for `claude-plugins/UUID` skill IDs
- Community trust badge color meets WCAG AA 4.5:1 contrast ratio (`#ffc107` → `#b8960a`) (SMI-3707)
- Repository link spans now keyboard-focusable with `tabindex`, `role="link"`, and Enter/Space handler (SMI-3724)

### Added

- "No repository URL available" placeholder when no repo URL exists (SMI-3723)
- Extracted `inferRepositoryUrl()` to `skill-panel-helpers.ts` with UUID rejection and GitHub name validation
- 10 unit tests for `inferRepositoryUrl`, 6 integration tests for new UX behaviors

### Changed

- "View Repository" button only appears for explicit repository URLs (suppressed for inferred)

## [0.1.4] - 2026-03-29

### Added

- Markdown rendering for skill descriptions (headers, bullets, links now display correctly)
- Repository URL carried through from search results (SMI-3722)
- Inferred GitHub URL fallback for author/name skill IDs with hostname validation
- Delegated link click handler for markdown content with trusted domain allowlist
- Confirmation dialog for external links to untrusted domains
- New test file: skill-panel-html.test.ts (22 tests)

### Changed

- Extracted shared `SANITIZE_OPTIONS` constant and `renderMarkdown` helper
- Description section uses `<div>` with markdown rendering instead of plain `<p>`
- Heading sizes capped at 14px inside description to prevent accidental inflation

### Security

- Trusted domain allowlist (github.com, gitlab.com, skillsmith.app) for external links
- Inferred URLs validated via `new URL()` + hostname check before rendering

## [0.1.3] - 2026-03-28

### Changed

- Promoted to first stable Marketplace release
- Added Marketplace publishing infrastructure (README, CHANGELOG, icon, CI workflow)

## [0.1.2] - 2026-03-27

### Added

- SKILL.md content rendering in skill detail panel with markdown-to-HTML sanitization (SMI-3672)
- 10KB content truncation with expandable "Show full content" button
- XSS prevention via sanitize-html allowlist (strips script, iframe, event handlers)

## [0.1.1] - 2026-03-20

### Added

- MCP client integration for live Skillsmith API data
- SkillService layer with MCP-first and mock fallback pattern
- Content mapping from API response to detail panel

## [0.1.0] - 2026-03-15

### Added

- Activity bar icon and sidebar skill tree view
- Skill search with trust tier and category filtering
- Skill detail webview panel with score breakdown and metadata
- Mock data fallback for offline use
- MCP server auto-connect with configurable timeout and reconnection
- Install command for one-click skill installation
