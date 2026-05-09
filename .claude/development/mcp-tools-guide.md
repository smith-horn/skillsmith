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

## Team-scoped tools (resolution chain)

**Team-scoped tools** (`team_workspace`, `share_skill`, `private_registry_*`) additionally require `SKILLSMITH_LICENSE_KEY` to resolve the caller's team AND `SUPABASE_SERVICE_ROLE_KEY` on the MCP host for downstream CRUD (SMI-4312 / ADR-116 — the MCP subprocess has no user JWT, so anon-key RLS policies deny). Resolution path: `SKILLSMITH_LICENSE_KEY` env → SHA-256 → `license_keys.key_hash` → `subscriptions` → `teams.subscription_id`, via the `resolve_team_from_license` RPC (migration 071, SECURITY DEFINER, invoked via anon client). Missing/invalid keys return a typed error (not stub data) when Supabase is configured; missing service-role key surfaces `Team workspace operations require SUPABASE_SERVICE_ROLE_KEY`.

## CLI

`skillsmith` or `sklx` — `author subagent/transform/mcp-init`, `sync/status/config`. See [ADR-018](../../docs/internal/adr/018-registry-sync-system.md). New in SMI-4590: `sklx audit collisions` (namespace audit, opposite of legacy `sklx audit advisories` security-advisory checker), `sklx config get audit_mode` / `sklx config set audit_mode <preventative|power_user|governance|off>` (tier-revalidated; Free/Individual cannot select `power_user`/`governance`).
