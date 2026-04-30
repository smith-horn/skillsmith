# Skillsmith

Discover, search, and install Claude Code skills directly in VS Code.

## Why Skillsmith?

- **Browse the Skillsmith skill registry** from your VS Code sidebar
- **View skill details** with rendered SKILL.md documentation
- **One-click install** skills to `~/.claude/skills`

## Features

| Feature | Description |
|---------|-------------|
| Sidebar Skill Tree | Browse skills organized by category and trust tier |
| Skill Search | Search the registry with trust tier and category filtering |
| Detail Panel | Rich skill detail view with rendered SKILL.md content, score breakdown, and metadata |
| MCP Integration | Live data from the Skillsmith API via Model Context Protocol |
| Offline Fallback | Works offline with cached local skill data |

**Local-first by design.** Skillsmith caches the registry in a local SQLite database at `~/.skillsmith/skills.db`, shared across the MCP server, the CLI, and the VS Code extension. Search is FTS5 by default; semantic search is opt-in (`SKILLSMITH_USE_HNSW=true`) and runs over local ONNX embeddings. [Inside the Local Skill Database](https://skillsmith.app/blog/inside-the-local-skill-database) walks through the schema, the FTS5 / HNSW search paths, and how `sync` keeps the cache fresh.

## Getting Started

1. Install Skillsmith from the VS Code Marketplace.
2. The extension auto-connects to the Skillsmith MCP server.
3. Open the Skillsmith sidebar (activity bar icon) to browse and search skills.

For MCP server setup and configuration, see the [Skillsmith documentation](https://skillsmith.app/docs).

## Configuration Reference

All settings are under the `skillsmith.*` namespace in VS Code Settings.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `skillsmith.skillsDirectory` | `string` | `~/.claude/skills` | Directory where skills are installed |
| `skillsmith.apiEndpoint` | `string` | `""` | Custom API endpoint for skill search (leave empty for default) |
| `skillsmith.mcp.serverCommand` | `string` | `npx` | Command to run the MCP server |
| `skillsmith.mcp.serverArgs` | `string[]` | `["@skillsmith/mcp-server"]` | Arguments for the MCP server command |
| `skillsmith.mcp.autoConnect` | `boolean` | `true` | Automatically connect to MCP server on extension activation |
| `skillsmith.mcp.autoReconnect` | `boolean` | `true` | Automatically reconnect when connection is lost |
| `skillsmith.mcp.connectionTimeout` | `number` | `30000` | Connection timeout in milliseconds |
| `skillsmith.mcp.minServerVersion` | `string` | `"0.4.9"` | Minimum required MCP server version. Older servers trigger a non-blocking update prompt. |
| `skillsmith.telemetry.enabled` | `boolean` | `true` | Opt-out for anonymous usage telemetry. Also respects VS Code's global `telemetry.telemetryLevel`. |
| `skillsmith.telemetryEndpoint` | `string` | `""` | Telemetry POST target. Empty (default) disables all network calls. |

## Requirements

Node.js 18+ is required for the MCP server connection. The extension itself runs without Node.js.

## Privacy

The extension emits anonymous usage events for the Create Skill and Uninstall Skill commands (SMI-4194) when — and only when — all of these are true:

- VS Code's global `telemetry.telemetryLevel` is not `off`.
- The `skillsmith.telemetry.enabled` setting is `true` (default).
- The `skillsmith.telemetryEndpoint` setting is a non-empty URL (no default — telemetry is off out of the box).

Events carry an anonymous cohort UUID generated on first activation and persisted in the extension's `globalState`. The UUID is never tied to a user account, email, or any PII. Event payloads include only the event name, extension version, and VS Code version. Network calls are fire-and-forget with a 2-second timeout.

Disable at any time by setting `skillsmith.telemetry.enabled: false` or by clearing `skillsmith.telemetryEndpoint`.

## Testing

Unit tests run inside the Skillsmith Docker dev container:

```bash
docker exec skillsmith-dev-1 npm test -w packages/vscode-extension
```

Integration tests use `@vscode/test-electron`, which launches a real VS Code Extension Host. Electron has no display server inside the container, so integration tests run on the host (per ADR-113, the VS Code extension is host-only):

```bash
npm --prefix packages/vscode-extension run test:integration
```

## Links

- Website: [skillsmith.app](https://skillsmith.app)
- GitHub: [github.com/smith-horn/skillsmith](https://github.com/smith-horn/skillsmith)
- Issues: [github.com/smith-horn/skillsmith/issues](https://github.com/smith-horn/skillsmith/issues)

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license)
