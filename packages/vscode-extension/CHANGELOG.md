# Changelog

All notable changes to the Skillsmith VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Skill search with trust-tier and category filters.
- Skill detail panel with score breakdown and metadata.
- One-click install command.
- Automatic MCP server connection with configurable timeout and reconnection.
- Offline mock-data fallback.
