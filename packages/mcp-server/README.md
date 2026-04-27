# @skillsmith/mcp-server

> **Important:** The bare `skillsmith` package on npm is **not** this project. Install `@skillsmith/mcp-server` for the MCP server or [`@skillsmith/cli`](https://www.npmjs.com/package/@skillsmith/cli) for CLI usage.

MCP (Model Context Protocol) server for agent skill discovery, installation, and management.

## What's New in v0.4.5

- **Dependency intelligence**: `skill_validate` warns on deprecated dependencies and undeclared MCP server references. `install_skill`, `get_skill`, and `uninstall_skill` now surface dependency data.
- **`skill_outdated` tool**: Check installed skills for staleness and dependency satisfaction status.
- **Encrypted skill detection**: `install_skill` detects git-crypt encrypted skills and returns a clear error instead of misleading validation messages.
- **v0.4.5 fix**: Resolved missing dependency export that broke v0.4.4 installations.

See [CHANGELOG.md](./CHANGELOG.md) for previous releases.

## Auto-Update Notifications

The MCP server checks for updates on startup and notifies you when a newer version is available:

```
[skillsmith] Update available: 0.4.4 → 0.4.5
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

## Platform Configuration

Skillsmith works with any MCP-compatible AI agent platform. Add the following to your platform's MCP config file:

**Claude Code** (`~/.claude/settings.json`):

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

**OpenClaw / Cursor / Codex / Antigravity / GitHub Copilot / other MCP clients** (`openclaw.json` or equivalent):

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

Get your API key at https://skillsmith.app/account (free Community tier available).

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

> **Note (v0.3.8):** Fixed critical bug where the MCP server defaulted to offline mode for all users. Search now correctly connects to the production API.

### Why Configure an API Key?

Without an API key, you're limited to **10 total requests** (trial mode). With a free Community account, you get **30 requests/minute** with access to all live skills.

**Benefits of API key:**
- Access to live indexed skills (not just cached)
- Higher rate limits based on your tier
- Usage tracking on your dashboard
- Priority during high-traffic periods

### API Key Configuration

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
> The `!` prefix in Claude Code runs the command without exposing the output.

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

| Tool | Description | Tier |
|------|-------------|------|
| `search` | Search for skills with filters | Community |
| `get_skill` | Get detailed skill information | Community |
| `install_skill` | Install a skill to ~/.claude/skills | Community |
| `uninstall_skill` | Remove an installed skill | Community |
| `skill_recommend` | Get contextual skill recommendations | Community |
| `skill_validate` | Validate a skill's structure | Community |
| `skill_compare` | Compare skills side-by-side | Community |
| `skill_suggest` | Suggest skills based on project context (counts against monthly quota) | Community |
| `skill_outdated` | Check installed skills for staleness and dependency status | Community |
| `index_local` | Index skills from a local directory | Community |
| `skill_publish` | Prepare a skill for publishing | Community |
| `skill_rescan` | Re-scan an installed skill's content | Community |
| `skill_updates` | Check registry for newer skill versions | Individual+ |
| `skill_diff` | Section-level diff between skill versions | Individual+ |
| `skill_pack_audit` | Audit all skills in a directory | Individual+ |
| `skill_audit` | Check skills for security advisories | Team+ |
| `team_workspace` | Manage team workspaces (create, list, get, delete) | Team+ |
| `share_skill` | Add, remove, or list skills in a team workspace | Team+ |
| `publish_private` | Mark a skill as private to your team | Team+ |
| `team_analytics_dashboard` | Per-user tool usage counts, top tools, daily trend | Team+ |
| `team_usage_report` | Weekly/monthly usage summary with period comparison | Team+ |
| `audit_export` | Export audit log events for a time range | Enterprise |
| `audit_query` | Query audit logs with filters | Enterprise |
| `siem_export` | Export audit events for SIEM ingestion | Enterprise |
| `analytics_dashboard` | Recommendation accuracy, adoption curves, team aggregation | Enterprise |
| `usage_report` | Comprehensive usage report with all metrics | Enterprise |
| `configure_sso` | Configure SSO/SAML integration (set, test, remove) | Enterprise |
| `sso_settings` | View current SSO/SAML configuration | Enterprise |
| `private_registry_publish` | Publish a skill to your private registry | Enterprise |
| `private_registry_manage` | Manage private registry skills (list, get, deprecate) | Enterprise |
| `rbac_manage` | Manage RBAC roles (create, list, get, delete) | Enterprise |
| `rbac_assign_role` | Assign or revoke roles for users | Enterprise |
| `rbac_create_policy` | Create and manage RBAC access policies | Enterprise |
| `webhook_configure` | Configure HMAC-SHA256 signed webhooks for skill events (in preview — availability pending production migration) | Enterprise |
| `api_key_manage` | Manage API keys for programmatic access (in preview — availability pending production migration) | Enterprise |
<!-- preview-status tracked by SMI-4135 -->
| `compliance_report` | Generate SOC2, CycloneDX SBOM, or JSON compliance reports | Enterprise |

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

**Response fields include:** `repository_url`, `homepage_url` (when declared by the skill author), and `compatibility` tags (LLMs, IDEs, platforms supported).

### get_skill

Get detailed information about a specific skill.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Skill ID in format `author/name` |

**Response fields include:** `also_installed` — an array of skills frequently co-installed alongside this one (surfaced once ≥5 co-installs are observed). Each entry contains `skillId`, `name`, `description`, and `installCount`.

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

### skill_outdated

Check installed skills for available updates and dependency satisfaction status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_deps` | boolean | No | Include dependency satisfaction status (default: true) |

### skill_diff

Show a section-level diff between two versions of a skill. Returns added, removed, and modified headings along with a change type (major/minor/patch) and update recommendation. Requires Individual tier or higher.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skillId` | string | Yes | Registry skill identifier (e.g. `author/skill-name`) |
| `oldContent` | string | Yes | Previous SKILL.md content |
| `newContent` | string | Yes | Updated SKILL.md content |
| `oldRiskScore` | number | No | Risk score of the old version (0–100) |
| `newRiskScore` | number | No | Risk score of the new version (0–100) |
| `hasLocalModifications` | boolean | No | Whether the installed skill has local edits (default: false) |
| `trustTier` | string | No | Registry trust tier: `verified`, `community`, `experimental` (default: community) |

### skill_audit

Check installed skills for known security advisories. Requires Team tier or higher. The advisory system is in early access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skillIds` | string[] | No | Specific skill IDs to audit (omit to return all skills with active advisories) |

### index_local

Index local skills from `~/.claude/skills/` directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `force` | boolean | No | Force re-indexing even if cache is valid (default: false) |
| `skillsDir` | string | No | Custom skills directory path (defaults to `~/.claude/skills/`) |

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
| `SKILLSMITH_API_KEY_HMAC_SECRET` | HMAC secret for hashing Custom Integration API keys before DB storage. Required if you invoke `webhook_configure` or `api_key_manage`. See setup below. | - |

### Custom Integration Setup (Team+ admins)

The `webhook_configure` and `api_key_manage` tools hash secrets server-side via HMAC-SHA-256 before persisting to the shared `api_keys` table. The HMAC key lives in `SKILLSMITH_API_KEY_HMAC_SECRET` rather than as a hardcoded constant — defense-in-depth so a leaked DB cannot be reverse-cracked offline.

**Distribution model**: identical to `SUPABASE_SERVICE_ROLE_KEY`. The same secret value must be set on every MCP host that creates or verifies Custom Integration API keys, otherwise hashes computed on host A won't match hashes verified on host B.

If the variable is missing or shorter than 32 characters when these tools are invoked, the call fails fast with:

```
SKILLSMITH_API_KEY_HMAC_SECRET must be set to a 32+ character random secret
before integration tools can be used. Generate one via: openssl rand -base64 48
```

**First-time provisioning** (Skillsmith admin, once per organization):

```bash
openssl rand -base64 48
```

Distribute that value through the same secure channel used for `SUPABASE_SERVICE_ROLE_KEY` (e.g., 1Password vault, encrypted onboarding email). Each Team-tier admin sets it on their own MCP host alongside their other secrets:

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_your_personal_key",
        "SKILLSMITH_LICENSE_KEY": "sklic_your_team_license",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ...your_service_role_jwt",
        "SKILLSMITH_API_KEY_HMAC_SECRET": "<the shared 32+ char secret>"
      }
    }
  }
}
```

**Rotation**: replace the secret on every host in lockstep. Existing rows in the `api_keys` table become unverifiable after rotation, so coordinate with affected admins or invalidate keys explicitly. As of 2026-04-26 the table has zero rows, so the first rotation post-launch is free.

If you only use Community/Individual tools (search, install, recommend, etc.), this variable is not needed.

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
