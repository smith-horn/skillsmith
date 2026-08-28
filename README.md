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

| Tier | Rate Limit | Cost |
|------|------------|------|
| Trial | 10 total | Free |
| Community | 30/min | Free |
| Individual | 60/min | $9.99/mo |
| Team | 120/min | $25/user/mo |
| Enterprise | 300/min | Custom |

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
2. **Which version is installed here?** Versions are immutable; `skill_diff` and `skill_outdated` report drift for what's installed on the machine you run them from.
3. **Has it been flagged by the security scan?** Skills pulled from the public index are scored automatically; flagged or suspicious ones are quarantined pending review — unflagged means it wasn't flagged, not that it was formally approved. Skills carry one of five trust tiers, from Official to Unverified ([Security Guide](docs/internal/security/skill-security-guide.md)).
4. **What happens to the ones nobody maintains?** Stale skills can be deprecated instead of quietly rotting in someone's repo.

## How it works

- **Publish** — skills are published to a registry scoped to your team, versioned immutably.
- **Version** — every publish creates a new immutable version; nothing is overwritten in place.
- **Drift detection** — `skill_diff` and `skill_outdated` show what's installed and where it has fallen behind, at the point you check.
- **Deprecate** — skills that go stale can be deprecated instead of quietly rotting in someone's repo.

## Scopes and permissions

Skills are scoped to your team's registry. Team owners and admins control who can publish and manage skills; members install and search.

## Start solo

Search, install, and manage skills for yourself, free. When your team needs the same skill, the registry is already there.

## MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Search skills with filters (query, category, trust tier, min score) |
| `get_skill` | Get detailed skill information including install command |
| `install_skill` | Install a skill to your local environment |
| `uninstall_skill` | Remove an installed skill |
| `recommend` | Get contextual skill recommendations |
| `validate` | Validate a skill's structure and quality |
| `compare` | Compare multiple skills side-by-side |

**Local-first by design.** Skillsmith caches the registry in a local SQLite database at `~/.skillsmith/skills.db`, shared across the MCP server, the CLI, and the VS Code extension. Search is FTS5 (SQLite's built-in keyword search) by default; semantic search is opt-in (`SKILLSMITH_USE_HNSW=true`) and runs over local ONNX embeddings (an open ML model format that runs on CPU — no API call). [Inside the Local Skill Database](https://skillsmith.app/blog/inside-the-local-skill-database) walks through the schema, the FTS5 / HNSW search paths, and how `sync` (a Team+ tier feature) keeps the cache fresh.

## Architecture

Skillsmith uses the Model Context Protocol (MCP):

```text
┌─────────────────────────────────────────────────────┐
│  MCP Client (Claude Code, Cursor, etc.)               │
│  ┌─────────────────────────────────────────────────┐│
│  │  Skillsmith MCP Server                          ││
│  │  └── @skillsmith/mcp-server                     ││
│  │      ├── search, get_skill, compare             ││
│  │      ├── install_skill, uninstall_skill         ││
│  │      └── recommend, validate                    ││
│  └─────────────────────────────────────────────────┘│
│                          │                           │
│                          ▼                           │
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
→ Uses compare tool to show side-by-side comparison
```

### CLI Usage (Development)

```bash
# From the repository, after building
node packages/cli/dist/index.js search "testing" --tier verified --min-score 80
node packages/cli/dist/index.js get community/jest-helper
node packages/cli/dist/index.js install community/jest-helper
```

## Documentation

### Public

- [**Security Guide**](https://skillsmith.app/docs/security) - Understanding skill trust, safety, and protections
- [5-Minute Setup](https://skillsmith.app/docs/quickstart) - Quick start guide
- [Configuration Guide](https://skillsmith.app/docs/getting-started) - Complete setup and usage
- [Status](https://www.skillsmith.app/status) - Live status and uptime history for Skillsmith's core services

### Internal

Internal documentation is in a private submodule at `docs/internal/`. Access requires repository membership. Run `git submodule update --init` after cloning.

- [Engineering Standards](docs/internal/architecture/standards.md) - Code quality policies (requires repository access)
- [ADR Index](docs/internal/adr/index.md) - Architecture Decision Records (requires repository access)
- [Security Checklist](docs/internal/security/checklists/code-review.md) - Security review guidelines (requires repository access)
- [Phase Retrospectives](docs/internal/retros/) - Phase learnings (requires repository access)

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
docker exec skillsmith-dev-1 npm install

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
docker exec skillsmith-dev-1 npm install
docker exec skillsmith-dev-1 npm run build
```

### Troubleshooting

#### Container won't start

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm install
```

#### Native module errors (`ERR_DLOPEN_FAILED`)

Native modules like `better-sqlite3` and `onnxruntime-node` may need rebuilding:

```bash
docker exec skillsmith-dev-1 npm rebuild
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

For the full technical decision, see [ADR-002: Docker with glibc for Native Module Compatibility](docs/internal/adr/002-docker-glibc-requirement.md).

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
