# Changelog

All notable changes to the Skillsmith VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
