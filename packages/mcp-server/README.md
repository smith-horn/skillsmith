# @skillsmith/mcp-server

MCP (Model Context Protocol) server for Claude Code skill discovery, installation, and management.

## Installation

```bash
npm install @skillsmith/mcp-server
```

## Quick Start

Add to your Claude Code configuration (`~/.claude/settings.json`):

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

Then ask Claude:

```
"Search for testing skills"
"Find verified skills for git workflows"
"Install the commit skill"
"Compare jest-helper and vitest-helper"
```

## Live Skill Registry

Version 0.2.0 introduces the live skill registry with 9,717+ skills.

Skills are served from `api.skillsmith.app` and cached locally for 24 hours.

### API Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILLSMITH_API_URL` | `https://api.skillsmith.app/functions/v1` | API endpoint |
| `SKILLSMITH_OFFLINE_MODE` | `false` | Use local database instead |
| `SKILLSMITH_TELEMETRY` | `true` | Enable anonymous telemetry |

## Available Tools

| Tool | Description | Example |
|------|-------------|---------|
| `search` | Search for skills with filters | `"Find testing skills"` |
| `get_skill` | Get detailed skill information | `"Get details for community/jest-helper"` |
| `install_skill` | Install a skill to ~/.claude/skills | `"Install jest-helper"` |
| `uninstall_skill` | Remove an installed skill | `"Uninstall jest-helper"` |
| `skill_recommend` | Get contextual skill recommendations | `"Recommend skills for React"` |
| `skill_validate` | Validate a skill's structure | `"Validate the commit skill"` |
| `skill_compare` | Compare skills side-by-side | `"Compare jest-helper and vitest-helper"` |
| `skill_suggest` | Suggest skills based on context | `"Suggest skills for my project"` |

## Tool Parameters

### search

Search for skills matching a query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search term (min 2 characters) |
| `category` | string | No | Filter by category (development, testing, devops, etc.) |
| `trust_tier` | string | No | Filter by trust level (verified, community, experimental) |
| `min_score` | number | No | Minimum quality score (0-100) |
| `limit` | number | No | Max results (default 10) |

### get_skill

Get detailed information about a specific skill.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Skill ID in format `author/name` |

### install_skill

Install a skill to your local Claude Code environment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Skill ID to install |

### uninstall_skill

Remove an installed skill.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Skill ID to uninstall |

### skill_recommend

Get skill recommendations based on context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context` | string | Yes | Description of your project or needs |
| `limit` | number | No | Max recommendations (default 5) |

### skill_validate

Validate a skill's SKILL.md file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to skill directory or SKILL.md |

### skill_compare

Compare multiple skills side-by-side.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skill_ids` | string[] | Yes | Array of skill IDs to compare (2-5) |

## Trust Tiers

| Tier | Description |
|------|-------------|
| `verified` | Official Anthropic skills |
| `community` | Community-reviewed skills |
| `experimental` | New/beta skills |
| `unknown` | Unverified skills |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SKILLSMITH_DB_PATH` | Database file location | `~/.skillsmith/skills.db` |
| `SKILLSMITH_TELEMETRY_ENABLED` | Enable anonymous telemetry | `false` |
| `POSTHOG_API_KEY` | PostHog API key (required if telemetry enabled) | - |

## Telemetry

Skillsmith includes optional, anonymous telemetry to help improve the product. **Telemetry is disabled by default.**

To enable telemetry:

```bash
export SKILLSMITH_TELEMETRY_ENABLED=true
export POSTHOG_API_KEY=your_api_key
```

See [PRIVACY.md](./PRIVACY.md) for full details on what data is collected and how it's used.

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license)

## Links

- [GitHub](https://github.com/smith-horn-group/skillsmith)
- [Issues](https://github.com/smith-horn-group/skillsmith/issues)
