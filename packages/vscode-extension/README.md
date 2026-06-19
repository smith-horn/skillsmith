# Skillsmith

Discover, search, and install agent skills directly in VS Code. Works with any MCP-compatible agent — Claude Code, Cursor, Copilot, Codex, Windsurf.

## Why Skillsmith?

- **Browse the Skillsmith skill registry** from your VS Code sidebar
- **View skill details** with rendered SKILL.md documentation
- **One-click install** skills to `~/.claude/skills`

## Features

| Feature | Description |
|---------|-------------|
| Sidebar Skill Tree | Browse skills grouped into Installed and Available sections, with a trust-tier badge shown per skill |
| Skill Search | Search the registry by keyword — trust-tier badges are shown on each result |
| Detail Panel | Rich skill detail view with rendered SKILL.md content, score breakdown, and metadata |
| MCP Integration | Live data from the Skillsmith API via Model Context Protocol |
| Offline Fallback | Works offline with cached local skill data |

### Filtering

Click **Filter Skills** in the Skills view title bar to narrow discovery results by:

- **Trust tier** — Official, Verified, Curated, Community, or Unverified
- **Category** — limit results to a specific skill category
- **Minimum score** — set a quality floor so lower-rated skills are hidden

A persistent banner in the Skills view shows your active query and any filters so you always know what you're looking at. Use **Clear Skill Filters** (available in the title bar when filters are active) to reset them. Filters are cleared automatically when the window reloads.

### Browsing and Detail View

The sidebar displays skills with rich metadata on each row: author, category, score, and an installed indicator when the skill is also available locally. Click a skill to open the detail panel, where a sticky header keeps the Install or Uninstall button visible while you scroll through documentation. For installed skills, the detail panel offers quick shortcuts to open the skill's `SKILL.md` file or reveal its folder in the operating system.

**Local-first by design.** Skillsmith caches the registry in a local SQLite database at `~/.skillsmith/skills.db`, shared across the MCP server, the CLI, and the VS Code extension. Search is FTS5 (SQLite's built-in keyword search) by default; semantic search is opt-in (`SKILLSMITH_USE_HNSW=true`) and runs over local ONNX embeddings (an open ML model format that runs on CPU — no API call). [Inside the Local Skill Database](https://skillsmith.app/blog/inside-the-local-skill-database) walks through the schema, the FTS5 / HNSW search paths, and how `sync` keeps the cache fresh.

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
