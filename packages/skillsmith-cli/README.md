# skillsmith-cli

> **This is a convenience wrapper.** The primary package is [`@skillsmith/cli`](https://www.npmjs.com/package/@skillsmith/cli).

**Important:** The bare `skillsmith` package on npm is **not** this project. Use `@skillsmith/cli` or this wrapper (`skillsmith-cli`).

## Install

```bash
npm install -g skillsmith-cli
# or
npm install -g @skillsmith/cli
```

## MCP Server (Recommended)

For AI-assisted skill discovery, configure the MCP server instead:

```json
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"]
    }
  }
}
```

See the [full documentation](https://github.com/smith-horn/skillsmith) for details.

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license)
