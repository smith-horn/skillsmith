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

## Requirements

Node.js 18+ is required for the MCP server connection. The extension itself runs without Node.js.

## Links

- Website: [skillsmith.app](https://skillsmith.app)
- GitHub: [github.com/smith-horn/skillsmith](https://github.com/smith-horn/skillsmith)
- Issues: [github.com/smith-horn/skillsmith/issues](https://github.com/smith-horn/skillsmith/issues)

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license)
