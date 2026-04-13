# Changelog

All notable changes to `@skillsmith/cli` are documented here.

## v0.5.3

- **Docs**: bump internal submodule for SMI-4181/4184 GSC audit plan (#539)

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
