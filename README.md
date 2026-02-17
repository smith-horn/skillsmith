# Skillsmith

**Craft your agent skill workflow.**

Skillsmith is an agent skill discovery, recommendation, and management system for MCP-compatible AI tools. Find the right skills for your projects, install them safely, and learn to use them effectively.

## Features

- **Discover** - Search skills from GitHub with semantic search
- **Recommend** - Get personalized skill suggestions based on context
- **Install** - One-command installation to `~/.claude/skills/`
- **Validate** - Quality scores and structure validation
- **Trust** - Four trust tiers from Official to Community ([Security Guide](docs/internal/security/skill-security-guide.md))
- **Compare** - Side-by-side skill comparison

### MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Search skills with filters (query, category, trust tier, min score) |
| `get_skill` | Get detailed skill information including install command |
| `install_skill` | Install a skill to your local environment |
| `uninstall_skill` | Remove an installed skill |
| `recommend` | Get contextual skill recommendations |
| `validate` | Validate a skill's structure and quality |
| `compare` | Compare multiple skills side-by-side |

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

## Installation

### Quick Setup (MCP)

Copy this MCP configuration snippet:

```text
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

After adding to your MCP client settings and restarting, you can search for skills immediately.

### API Key Configuration (Optional)

For higher rate limits and usage tracking, add your API key:

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

Get your API key at [skillsmith.app/account](https://skillsmith.app/account).

| Tier | Rate Limit | Cost |
|------|------------|------|
| Trial | 10 total | Free |
| Community | 30/min | Free |
| Individual | 60/min | $9.99/mo |
| Team | 120/min | $25/user/mo |
| Enterprise | 300/min | $55/user/mo |

> **Note:** Never paste API keys in chat. Configure via settings.json only.

### CLI Installation (Development)

The CLI is available for local development:

```bash
# From the repository root
npm run build
node packages/cli/dist/index.js search "testing"
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

- [**Skill Security Guide**](docs/internal/security/skill-security-guide.md) - Understanding skill trust, safety, and how Skillsmith protects you
- [Getting Started](docs/internal/GETTING_STARTED.md) - Complete setup and usage guide
- [Engineering Standards](docs/internal/architecture/standards.md) - Code quality policies
- [ADR Index](docs/internal/adr/index.md) - Architecture Decision Records
- [Security Checklist](docs/internal/security/checklists/code-review.md) - Security review guidelines (developers)
- [Phase Retrospectives](docs/internal/retros/) - Phase learnings and improvements

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

# 2. Start the development container
docker compose --profile dev up -d

# 3. Install dependencies (first time only)
docker exec skillsmith-dev-1 npm install

# 4. Build and test
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

For the full technical decision, see [ADR-002: Docker with glibc for Native Module Compatibility](/docs/internal/adr/002-docker-glibc-requirement.md).

See [CLAUDE.md](CLAUDE.md) for full development workflow and skill configuration.

## Tech Stack

- **Runtime**: Node.js 20+ (Docker with glibc)
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

*Skillsmith is not affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.*
