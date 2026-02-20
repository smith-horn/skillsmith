# @skillsmith/mcp-server

MCP (Model Context Protocol) server for agent skill discovery, installation, and management.

## What's New in v0.4.0

- **Quota-based throttling** (SMI-2679): `skill_suggest` now counts against your monthly API quota instead of an undocumented per-session rate limit. Community (1,000/mo), Individual (10,000/mo), Team (100,000/mo), Enterprise (unlimited). See [www.skillsmith.app/pricing](https://www.skillsmith.app/pricing).
- **Graceful license degradation**: If the enterprise license check is unavailable, `skill_suggest` falls back to community-tier defaults rather than returning a hard error.
- **5,575 tests passing** across all packages.

## What's New in v0.3.18

- **Async Initialization** (SMI-2205): Server initializes asynchronously for faster startup
- **WASM Fallback** (SMI-2206): Automatic fallback to sql.js when native SQLite unavailable
- **Robust Context Loading** (SMI-2207): Graceful handling of initialization edge cases
- **612 tests passing** with comprehensive coverage

## Auto-Update Notifications

The MCP server checks for updates on startup and notifies you when a newer version is available:

```
[skillsmith] Update available: 0.3.20 → 0.4.0
Restart your MCP client to use the latest version.
```

To disable update checks, set `SKILLSMITH_AUTO_UPDATE_CHECK=false` in your environment.

## Installation

```bash
npm install @skillsmith/mcp-server
```

## Quick Start

Copy this MCP configuration snippet:

```
Add this MCP server to my settings.json:

{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"]
    }
  }
}
```

After adding to your MCP client settings and restarting, try asking:

```
"Search for testing skills"
"Find verified skills for git workflows"
"Install the commit skill"
"Compare jest-helper and vitest-helper"
```

## Live Skill Registry

The Skillsmith API provides access to **14,000+ curated skills** from 20,000+ on GitHub that are:

- **Indexed daily** from GitHub repositories
- **Security screened hourly** for vulnerabilities and malicious patterns
- **Quality scored** based on documentation, structure, and community feedback
- **Categorized** by trust tier (Verified, Community, Experimental)

Skills are served from `api.skillsmith.app` and cached locally for 24 hours.

> **Note (v0.3.8):** Fixed critical bug where the MCP server defaulted to offline mode for all users. Search now correctly connects to the production API. See [SMI-1948](https://linear.app/smith-horn-group/issue/SMI-1948).

### Why Configure an API Key?

Without an API key, you're limited to **10 total requests** (trial mode). With a free Community account, you get **30 requests/minute** with access to all live skills.

**Benefits of API key:**
- Access to live indexed skills (not just cached)
- Higher rate limits based on your tier
- Usage tracking on your dashboard
- Priority during high-traffic periods

### API Key Configuration (SMI-1953)

**Step 1:** Get your API key from https://skillsmith.app/account

**Step 2:** Add to your Claude settings at `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_your_key_here"
      }
    }
  }
}
```

**Step 3:** Restart your MCP client

> **Security Note:** Never paste your API key in chat. Configure it via the settings file above. For testing, set the env var using the appropriate command for your platform:
>
> | Platform | Command |
> |----------|---------|
> | Mac/Linux | `!export SKILLSMITH_API_KEY='your-key-here'` |
> | Windows PowerShell | `!$env:SKILLSMITH_API_KEY='your-key-here'` |
> | Windows CMD | `!set SKILLSMITH_API_KEY=your-key-here` |
>
> The `!` prefix in Claude Code runs the command without exposing the output. See [SMI-1956](https://linear.app/smith-horn-group/issue/SMI-1956).

### Rate Limits by Tier

| Tier | Rate Limit | Monthly Cost | Best For |
|------|------------|--------------|----------|
| Trial | 10 total | Free | Quick evaluation |
| Community | 30/min | Free | Personal projects |
| Individual | 60/min | $9.99/mo | Active developers |
| Team | 120/min | $25/user/mo | Development teams |
| Enterprise | 300/min | $55/user/mo | Large organizations |

All tiers include:
- Full access to skill search, details, and recommendations
- Security screening results
- Quality scores and trust tier information

### API Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILLSMITH_API_KEY` | - | Personal API key for usage tracking |
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
| `skill_suggest` | Suggest skills based on project context (counts against monthly quota) | `"Suggest skills for my project"` |

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

Install a skill to your local environment.

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

### skill_suggest

Proactively suggest relevant skills based on current project context. Counts against your monthly API quota.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_path` | string | Yes | Absolute path to the project directory |
| `current_file` | string | No | File currently being edited |
| `recent_commands` | string[] | No | Recent terminal commands (last 5) |
| `error_message` | string | No | Recent error message, if any |
| `installed_skills` | string[] | No | Currently installed skill IDs (for filtering) |
| `limit` | number | No | Max suggestions to return (default 3, max 10) |
| `session_id` | string | No | Session identifier (optional, for informational purposes) |

## Trust Tiers

| Tier | Description |
|------|-------------|
| `verified` | Official platform skills |
| `community` | Community-reviewed skills |
| `experimental` | New/beta skills |
| `unknown` | Unverified skills |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SKILLSMITH_DB_PATH` | Database file location | `~/.skillsmith/skills.db` |
| `SKILLSMITH_TELEMETRY_ENABLED` | Enable anonymous telemetry | `false` |
| `SKILLSMITH_USE_WASM` | Force WASM SQLite driver (sql.js) | `false` |
| `POSTHOG_API_KEY` | PostHog API key (required if telemetry enabled) | - |

### WASM Fallback (v0.3.18+)

The MCP server automatically falls back to a WASM-based SQLite driver (sql.js) when native better-sqlite3 is unavailable. This ensures the server works in environments where native modules can't be compiled.

The fallback is automatic—no configuration needed. To force WASM mode:

```bash
export SKILLSMITH_USE_WASM=true
```

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

- [GitHub](https://github.com/smith-horn/skillsmith)
- [Issues](https://github.com/smith-horn/skillsmith/issues)
