# Skillsmith

**Shared skills, safe for production.**

Once more than one team is publishing agent skills, the problem stops being finding them and starts being managing them. Which team is this scoped to? Which version is installed where? Has it been flagged by a security scan? What happens to the ones nobody maintains anymore?

Skillsmith is a registry for sharing, scanning, and tracking agent skills across teams. Skills are published to a registry scoped to your team and versioned immutably, so drift across installs is visible instead of silent. Flagged or suspicious skills are quarantined pending security review. Skills that go stale can be deprecated instead of quietly rotting in someone's repo.

## Installation

### Quick Setup (MCP)

Skillsmith is **MCP-compatible** — pick the snippet for your agent.
SMI-4580: snippets sourced from [`packages/cli/src/templates/mcp-server.template.snippets.ts`](packages/cli/src/templates/mcp-server.template.snippets.ts) so this README and the website docs cannot drift.

<details>
<summary><strong>Claude Code</strong> — <code>~/.claude/settings.json</code></summary>

```json
{
  "mcpServers": {
    "@skillsmith/mcp-server": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_..."
      }
    }
  }
}
```

Restart Claude Code after editing settings.json.

</details>

<details>
<summary><strong>Cursor</strong> — <code>~/.cursor/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "@skillsmith/mcp-server": {
      "command": "<paste output of: which skillsmith-mcp (macOS/Linux) or where skillsmith-mcp (Windows)>",
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_...",
        "SKILLSMITH_CLIENT": "cursor"
      }
    }
  }
}
```

Cursor 2.4+ required, Node >=22.22 (Cursor's own bundled Node meets this). `SKILLSMITH_CLIENT` routes installs to `~/.cursor/skills` instead of the default `~/.claude/skills`.

**Setup**: run `npm install -g @skillsmith/mcp-server`, then run `which skillsmith-mcp` (macOS/Linux) or `where skillsmith-mcp` (Windows) and paste that path into `command` above — Cursor's bundled Node cannot resolve packages via `npx` (a real `ENOENT` on a missing `Resources/app/resources/lib` directory), so pointing directly at the installed binary is the only form confirmed to work inside Cursor. Prefer to try `npx` first anyway? Replace `command` with `"npx"` and add `"args": ["-y", "@skillsmith/mcp-server"]` — simpler, but may hit the same `ENOENT`, plus `EBADENGINE` or `ENOTEMPTY` on repeated installs. After saving: enable the server in Cursor's Settings → MCP panel and start a new chat — a correctly-configured entry still shows disconnected until toggled on there — then reload the window.

</details>

<details>
<summary><strong>GitHub Copilot (VS Code)</strong> — <code>.vscode/mcp.json</code> (workspace)</summary>

```json
{
  "mcpServers": {
    "@skillsmith/mcp-server": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_..."
      }
    }
  }
}
```

VS Code 1.108+ required. Workspace-scoped (commit to repo if team-shared, or use user `settings.json` instead).

</details>

<details>
<summary><strong>Windsurf</strong> — <code>~/.codeium/windsurf/mcp_config.json</code></summary>

```json
{
  "mcpServers": {
    "@skillsmith/mcp-server": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_API_KEY": "${env:SKILLSMITH_API_KEY}"
      }
    }
  }
}
```

Supports `${env:VAR}` interpolation; export `SKILLSMITH_API_KEY` in your shell instead of inlining the secret.

</details>

<details>
<summary><strong>Codex CLI</strong> — <code>~/.codex/config.toml</code> (TOML, not JSON)</summary>

```toml
[mcp_servers.@skillsmith/mcp-server]
command = "npx"
args = ["-y", "@skillsmith/mcp-server"]

[mcp_servers.@skillsmith/mcp-server.env]
SKILLSMITH_API_KEY = "sk_live_..."
```

Codex reads `~/.agents/skills`. When installing via CLI, pass `--client agents`.

</details>

<details>
<summary><strong>Cross-agent (open standard)</strong> — <code>~/.agents/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "@skillsmith/mcp-server": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_..."
      }
    }
  }
}
```

Read by any agent honouring the cross-agent skill convention.

</details>

After adding to your MCP client settings and restarting, you can search for skills immediately.

### API Key Configuration (Optional)

For higher rate limits and usage tracking, authenticate with your API key.

**Easiest — CLI login (interactive):**

```bash
npm install -g @skillsmith/cli
skillsmith login
```

This opens [skillsmith.app/account/cli-token](https://skillsmith.app/account/cli-token) in your browser. Generate a key, copy it, and paste it when prompted. The key is stored securely in your OS keyring.

**MCP server config — add the key to your settings:**

The per-client snippets above already include the `env.SKILLSMITH_API_KEY` slot — replace the `sk_live_...` placeholder with the value from `skillsmith login`.

Get your API key at [skillsmith.app/account/cli-token](https://skillsmith.app/account/cli-token).

| Tier | Monthly quota | Per-minute limit | Cost |
|------|---------------|------------------|------|
| No API key (MCP default) | Community rate, shared public key | 30/min, shared across all keyless clients | Free |
| Community | 100 | 30/min | Free |
| Individual | 1,000 | 200/min | $9.99/mo |
| Team | 10,000 | 300/min | $25/user/mo |
| Enterprise | Unlimited | 600/min | Contact Sales |

> **Quota note:** the monthly figure is a hard limit only where enforced. Edge functions hard-block on monthly quota for Community only, and only when `ENFORCE_COMMUNITY_QUOTA` is `'true'`. The MCP server's own monthly quota counts only `skill_suggest` and the tier-gated tools, and hard-blocks them by default (`SKILLSMITH_ENFORCE_MCP_QUOTA=false` turns that off).

The MCP server falls back to a built-in public key when none is set, so keyless MCP use is Community-rate and shares one 30/min bucket with every other keyless client. The 10-call trial (100/min per IP) applies only to direct HTTP callers that send no Authorization header. When enabled, a per-IP daily budget can also apply to that shared key (`ENFORCE_ANON_BUDGET`; off by default).

> **Note:** Never paste API keys in chat. Configure via settings.json only.

### CLI Installation (Development)

The CLI is available for local development:

```bash
# From the repository root
npm run build
node packages/cli/dist/index.js search "testing"
```

## The four questions

Once more than one team is publishing skills, these are the questions that matter:

1. **Which team is this scoped to?** Every skill in the registry is scoped to a team.
2. **Which version is installed here?** Versions are immutable; `skill_diff` (Individual tier) and `skill_outdated` report drift for what's installed on the machine you run them from.
3. **Has it been flagged by the security scan?** Skills pulled from the public index are scored automatically; flagged or suspicious ones are quarantined pending review — unflagged means it wasn't flagged, not that it was formally approved. Each skill carries one of eight trust tiers, from Official to Unverified ([Security Guide](https://skillsmith.app/docs/security)).
4. **What happens to the ones nobody maintains?** Stale skills can be deprecated instead of quietly rotting in someone's repo.

## How it works

- **Publish** — skills are published to a registry scoped to your team, versioned immutably.
- **Version** — every publish creates a new immutable version; nothing is overwritten in place.
- **Drift detection** — `skill_diff` (Individual tier) and `skill_outdated` show what's installed and where it has fallen behind, at the point you check.
- **Deprecate** — skills that go stale can be deprecated instead of quietly rotting in someone's repo.

## Scopes and permissions

Skills are scoped to your team's registry. Team owners and admins control who can publish and manage skills; members install and search.

## Start solo

Search, install, and manage skills for yourself, free. When your team needs the same skill, the registry is already there.

## MCP Tools

Skillsmith registers 43 tools. 19 of the 43 work on the free Community tier. Higher tiers add version tracking, team features and enterprise controls. Tools above your tier return an upgrade message. [Pricing](https://skillsmith.app/pricing).

### Community (free)

| Tool | Description |
|------|-------------|
| `search` | Search skills with filters (query, category, trust tier, min score) |
| `get_skill` | Get detailed skill information including install command |
| `install_skill` | Install a skill to your local environment |
| `uninstall_skill` | Remove an installed skill |
| `skill_recommend` | Get contextual skill recommendations |
| `skill_suggest` | Suggest skills from your current project context (counts against your monthly quota) |
| `skill_validate` | Validate a skill's structure and quality |
| `skill_compare` | Compare two skills side-by-side |
| `skill_outdated` | Check installed skills for staleness and dependency status |
| `skill_rescan` | Re-scan an installed skill with the latest security patterns |
| `skill_publish` | Validate a skill and prepare it for publishing |
| `skill_recover_source` | Recover the GitHub source of locally installed skills (read-only) |
| `index_local` | Index skills from a local directory |
| `inventory_push` | Push this machine's installed-skill inventory to your dashboard (read-only; needs `skillsmith login`) |
| `skill_inventory_audit` | Check every installed client's skills for name collisions and get rename suggestions |
| `apply_namespace_rename` | Apply or revert a rename suggestion (previews first, changes files only when confirmed) |
| `apply_recommended_edit` | Apply a suggested prose edit from an audit (previews first, changes files only when confirmed) |
| `undo_apply` | Undo the most recent rename or edit from this session |
| `apply_manifest_reconcile` | Repair a corrupted or ambiguous manifest entry |

### Individual

| Tool | Description |
|------|-------------|
| `skill_updates` | Check the registry for newer versions of installed skills |
| `skill_diff` | Section-level diff between two versions of a skill |
| `skill_pack_audit` | Audit a directory of skills for version drift and weak triggers |

### Team

| Tool | Description |
|------|-------------|
| `skill_audit` | Check installed skills for known security advisories |
| `team_workspace` | Create, list, get and delete team workspaces |
| `share_skill` | Add, remove or list skills in a team workspace |
| `publish_private` | Hide a skill from your own search results on this machine (local only) |
| `team_analytics_dashboard` | Per-user tool usage, top tools and daily trend |
| `team_usage_report` | Weekly or monthly usage summary with period comparison |
| `compliance_report` | Generate SOC2, CycloneDX SBOM or JSON reports for your local skill inventory |

### Enterprise

| Tool | Description |
|------|-------------|
| `private_registry_publish` | Publish a skill version to your private registry for approval |
| `private_registry_manage` | List, get, install, deprecate, approve or reject private registry skills |
| `configure_sso` | Set up SSO/SAML, including DNS domain verification |
| `sso_settings` | View the current SSO/SAML configuration |
| `rbac_manage` | Inspect and adjust what each team role can do |
| `rbac_assign_role` | Assign or revoke member roles, or list members |
| `rbac_create_policy` | Bulk-set or clear permission overrides for a role |
| `audit_export` | Export audit log events for a time range |
| `audit_query` | Query audit logs with filters |
| `siem_export` | Export audit events to your SIEM |
| `analytics_dashboard` | Recommendation accuracy, usage trends and team-wide aggregation |
| `usage_report` | Full usage report across all metrics |
| `webhook_configure` | Signed webhooks for skill lifecycle events (preview) |
| `api_key_manage` | Create, list and revoke API keys (preview) |

The automatic session-start namespace audit is a Team and Enterprise feature. The audit and rename tools above can be run by hand on any tier.

**Local-first by design.** Skillsmith caches the registry in a local SQLite database at `~/.skillsmith/skills.db`, shared across the MCP server, the CLI, and the VS Code extension. Search is FTS5 (SQLite's built-in keyword search) by default; semantic search is opt-in (`SKILLSMITH_USE_HNSW=true`) and runs over local ONNX embeddings (an open ML model format that runs on CPU — no API call). [Inside the Local Skill Database](https://skillsmith.app/blog/inside-the-local-skill-database) walks through the schema, the FTS5 / HNSW search paths, and how `sync` (a Team+ tier feature) keeps the cache fresh.

## Architecture

Skillsmith uses the Model Context Protocol (MCP):

```text
┌─────────────────────────────────────────────────────┐
│  MCP Client (Claude Code, Cursor, etc.)             │
│  ┌─────────────────────────────────────────────────┐│
│  │  Skillsmith MCP Server                          ││
│  │  └── @skillsmith/mcp-server                     ││
│  │      ├── search, get_skill, skill_compare       ││
│  │      ├── install_skill, uninstall_skill         ││
│  │      ├── skill_recommend, skill_validate        ││
│  │      ├── skill_outdated, skill_diff, ...        ││
│  │      └── 43 tools across four tiers             ││
│  └─────────────────────────────────────────────────┘│
│                          │                          │
│                          ▼                          │
│  ┌─────────────────────────────────────────────────┐│
│  │  ~/.skillsmith/skills.db (SQLite + FTS5)        ││
│  │  ~/.claude/skills/ (installed skills)           ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

## Usage

Once configured, your MCP client can use Skillsmith tools:

```text
"Search for testing skills"
→ Uses search tool to find testing-related skills

"Show me details for community/jest-helper"
→ Uses get_skill tool to retrieve full skill information

"Install the jest-helper skill"
→ Uses install_skill tool to add it to ~/.claude/skills

"Compare jest-helper and vitest-helper"
→ Uses skill_compare tool to show side-by-side comparison

"Are any of my installed skills out of date?"
→ Uses skill_outdated tool to check for staleness and missing dependencies

"Do any of my skills clash with each other?"
→ Uses skill_inventory_audit tool to find name collisions and suggest renames
```

### CLI Usage (Development)

```bash
# From the repository, after building
node packages/cli/dist/index.js search "testing" --tier verified --min-score 80
node packages/cli/dist/index.js get community/jest-helper
node packages/cli/dist/index.js install community/jest-helper
```

## Documentation

- [**Security Guide**](https://skillsmith.app/docs/security) - Understanding skill trust, safety, and protections
- [5-Minute Setup](https://skillsmith.app/docs/quickstart) - Quick start guide
- [Configuration Guide](https://skillsmith.app/docs/getting-started) - Complete setup and usage
- [Status](https://www.skillsmith.app/status) - Live status and uptime history for Skillsmith's core services

## Development

Skillsmith uses **Docker-first development**. All commands run inside Docker to ensure consistent native module support across all platforms.

### Prerequisites

- **Docker Desktop** (v24+) or Docker Engine with Docker Compose
- **Git** (for cloning the repository)
- **Node.js** (optional, only for local tooling outside Docker)

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/smith-horn/skillsmith.git
cd skillsmith

# 2. Create your local environment file
cp .env.example .env

# 3. Start the development container
docker compose --profile dev up -d

# 4. Install dependencies (first time only)
docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install'

# 5. Build and test
docker exec skillsmith-dev-1 npm run build
docker exec skillsmith-dev-1 npm test
```

### Running Commands in Docker

All npm commands should be run inside the Docker container:

| Command | Docker Command |
|---------|----------------|
| Build | `docker exec skillsmith-dev-1 npm run build` |
| Test | `docker exec skillsmith-dev-1 npm test` |
| Lint | `docker exec skillsmith-dev-1 npm run lint` |
| Typecheck | `docker exec skillsmith-dev-1 npm run typecheck` |
| Audit | `docker exec skillsmith-dev-1 npm run audit:standards` |

### Container Management

```bash
# Start development container
docker compose --profile dev up -d

# Check container status
docker ps | grep skillsmith

# View container logs
docker logs skillsmith-dev-1

# Stop container
docker compose --profile dev down

# Restart after Dockerfile changes
docker compose --profile dev down
docker compose --profile dev build --no-cache
docker compose --profile dev up -d
```

### After Pulling Changes

When you pull changes that modify `package.json` or `package-lock.json`:

```bash
docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install'
docker exec skillsmith-dev-1 npm run build
```

### Troubleshooting

#### Container won't start

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev up -d
```

The wipe does not block startup at the entrypoint's `node_modules` pre-check — the root volume re-seeds from the image, so that check passes rather than exiting (SMI-6674); later startup steps are a separate matter. What the wipe does leave is a mixed dependency state, so don't follow it with a bare install. Print and follow the ordered refresh sequence instead (ADR-158; SMI-6614):

```bash
( cd <main-checkout-path> && sh scripts/lib/print-deps-refresh-advice.sh <main-checkout-path> )
```

#### Native module errors (`ERR_DLOPEN_FAILED`)

Native modules like `better-sqlite3` and `onnxruntime-node` may need rebuilding:

```bash
docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm rebuild'
```

#### Tests fail with shared library errors

If you see errors about `ld-linux-aarch64.so.1` or similar, ensure you're running inside Docker (not locally):

```bash
# Wrong - don't run locally
npm test

# Correct - run in Docker
docker exec skillsmith-dev-1 npm test
```

### Why Docker?

Skillsmith uses native Node.js modules (`better-sqlite3`, `onnxruntime-node`) that require **glibc**. Docker provides a consistent Debian-based environment with glibc, avoiding compatibility issues on systems using musl libc (like Alpine Linux).

See [CLAUDE.md](CLAUDE.md) for full development workflow and skill configuration.

## Tech Stack

- **Runtime**: Node.js >=22.22 (Docker with glibc)
- **Protocol**: MCP (Model Context Protocol)
- **Database**: SQLite with FTS5
- **Embeddings**: all-MiniLM-L6-v2 via onnxruntime-node
- **Testing**: Vitest
- **CI/CD**: GitHub Actions

## License

Skillsmith is source-available under the [Elastic License 2.0](LICENSE).

**You CAN:**

- Use Skillsmith for personal or internal business purposes
- Modify the source code for your own use
- Self-host for your team
- Contribute bug fixes and improvements

**You CANNOT:**

- Offer Skillsmith as a managed service to third parties
- Circumvent license key enforcement features

For the full license text, see the [LICENSE](LICENSE) file.

## Author

Smith Horn Group Ltd

---

_Skillsmith is not affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic._
