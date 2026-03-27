# Skillsmith MCP Tools Guide

Reference for Skillsmith MCP server tools, authentication, and CLI.

## Tools

| Tool | Description |
|------|-------------|
| `search` | Search skills (query, category, trust_tier, min_score, limit) |
| `get_skill` | Get skill details by `author/name` ID |
| `install_skill` | Install skill to `~/.claude/skills` |
| `uninstall_skill` | Remove installed skill |
| `recommend` | Contextual skill recommendations |
| `validate` | Validate skill structure |
| `compare` | Compare 2-5 skills side-by-side |
| `skill_diff` | Diff two installed skill versions side-by-side |
| `skill_audit` | Audit skill for security advisories (Team+) |

## Authentication

| Method | Rate Limit | Setup |
|--------|-----------|-------|
| Personal API Key (`X-API-Key: sk_live_*`) | Tier-based | `~/.skillsmith/config.json` or `SKILLSMITH_API_KEY` env in Claude settings |
| Supabase Anon Key | 30/min | Built-in fallback |
| No Auth | 10 trial calls | None |

Shell exports don't reach MCP subprocesses — configure in `~/.skillsmith/config.json` or Claude settings.

## Trust Tiers

- **verified**: Official, reviewed by Skillsmith team
- **community**: Community-reviewed
- **experimental**: New or beta

## Tool Naming Convention

New tools use `skill_` prefix; legacy tools (`search`, `get_skill`) lack it.

## CLI

`skillsmith` or `sklx` — `author subagent/transform/mcp-init`, `sync/status/config`. See [ADR-018](../docs/internal/adr/018-registry-sync-system.md).
