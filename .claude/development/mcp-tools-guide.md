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
| `skill_suggest` | Suggest skills based on current project context (counts against monthly quota) |
| `skill_outdated` | Check installed skills for staleness and dependency status |
| `index_local` | Index skills from a local directory |
| `skill_publish` | Prepare a local skill for publishing |
| `skill_rescan` | Re-scan an installed skill's content |
| `skill_recover_source` | Recover the canonical GitHub source of locally-installed skills (read-only) |
| `inventory_push` | Push this machine's installed-skill inventory to your Skillsmith account for the web dashboard |
| `skill_updates` | Check registry for newer skill versions (Individual+) |
| `skill_diff` | Diff two installed skill versions side-by-side |
| `skill_pack_audit` | Audit all skills in a directory (Individual+) |
| `skill_audit` | Audit skill for security advisories (Team+) |
| `skill_inventory_audit` | Audit local `~/.claude/` inventory for namespace collisions; returns rename + edit suggestions (Team+) |
| `apply_namespace_rename` | Apply a rename suggestion from an audit (`apply` / `custom` / `skip`) (Team+) |
| `apply_recommended_edit` | Apply a recommended prose edit; gated on `APPLY_TEMPLATE_REGISTRY` (Team+) |
| `undo_apply` | Session-scoped undo of the most recent apply_namespace_rename/apply_recommended_edit changeset(s) (Team+) |
| `team_workspace` | Manage team workspaces: create, list, get, delete (Team+) |
| `share_skill` | Add, remove, or list skills in a team workspace (Team+) |
| `publish_private` | Mark a skill private on this device, hidden from your own search results (Team+) |
| `team_analytics_dashboard` | Per-user tool usage counts, top tools, daily trend (Team+) |
| `team_usage_report` | Weekly/monthly usage summary with period comparison (Team+) |
| `private_registry_publish` | Publish a skill version to your team's private registry as a pending submission (Enterprise) |
| `private_registry_manage` | List/get/install/deprecate/undeprecate/review your team's private registry via the `action` parameter (Enterprise) |
| `audit_export` | Export audit log events for a time range (Enterprise) |
| `audit_query` | Query audit logs with filters (Enterprise) |
| `siem_export` | Export audit events for SIEM ingestion (Enterprise) |
| `analytics_dashboard` | Recommendation accuracy, adoption curves, team aggregation (Enterprise) |
| `usage_report` | Comprehensive usage report with all metrics (Enterprise) |
| `configure_sso` | Configure SSO/SAML integration: set, test, remove (Enterprise) |
| `sso_settings` | View current SSO/SAML configuration (Enterprise) |
| `rbac_manage` | Manage RBAC roles: create, list, get, delete (Enterprise) |
| `rbac_assign_role` | Assign or revoke roles for users (Enterprise) |
| `rbac_create_policy` | Create and manage RBAC access policies (Enterprise) |
| `compliance_report` | Generate SOC2, CycloneDX SBOM, or JSON compliance reports (Enterprise) |

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

## VS Code Extension Surface

The `skill_recommend`, `skill_compare`, and `skill_diff` MCP tools are surfaced in the VS Code extension as commands: **Recommend Skills**, **Compare Skills**, and **Check Skill for Updates** (the latter requires Individual plan or higher). The `skill_audit` tool is surfaced in the skill detail panel as a **Security Advisories** section (Team plan or higher). The `skill_inventory_audit` tool is surfaced as the **Audit Skill Inventory** command, whose report offers interactive apply (SMI-5325): the `apply_namespace_rename` and `apply_recommended_edit` tools back per-row **Apply rename…** / **Apply edit…** actions (preview → confirm → re-audit; all ungated/Community).

## CLI

`skillsmith` or `sklx` — `author subagent/transform/mcp-init`, `sync/status/config`. See [ADR-018](../../docs/internal/adr/018-registry-sync-system.md). New in SMI-4590: `sklx audit collisions` (namespace audit, opposite of legacy `sklx audit advisories` security-advisory checker), `sklx config get audit_mode` / `sklx config set audit_mode <preventative|power_user|governance|off>` (tier-revalidated; Free/Individual cannot select `power_user`/`governance`).
