# Skillsmith

**Craft your Claude Code workflow.**

Skillsmith is a skill discovery, recommendation, and learning system for [Claude Code](https://claude.ai/code) users. Find the right skills for your projects, install them safely, and learn to use them effectively.

## Status

**Phase 2c: In Progress** - Tiered caching, GitHub webhooks, and performance optimization.

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 0 | ✅ Complete | Planning, architecture, monorepo setup |
| Phase 1 | ✅ Complete | CI/CD, testing infrastructure, code quality |
| Phase 2a | ✅ Complete | GitHub indexing, skill parsing |
| Phase 2b | ✅ Complete | TDD security fixes, vector embeddings |
| Phase 2c | 🚧 In Progress | Tiered cache, webhooks, performance |

## Features (Planned)

- **Discover** - Search 50,000+ skills from GitHub, SkillsMP, and other sources
- **Recommend** - Get personalized skill suggestions based on your codebase
- **Install** - One-command installation with security scanning
- **Learn** - Guided learning paths for new skills
- **Trust** - Quality scores and trust tiers to find reliable skills

## Architecture

Skillsmith is built as a set of MCP (Model Context Protocol) servers that integrate directly with Claude Code:

```
┌─────────────────────────────────────────────────────┐
│  Claude Code                                         │
│  ┌─────────────────────────────────────────────────┐│
│  │  Skillsmith MCP Servers                         ││
│  │  ├── discovery-core (search, install, audit)   ││
│  │  ├── learning (paths, exercises, progress)     ││
│  │  └── sync (index refresh, health)              ││
│  └─────────────────────────────────────────────────┘│
│                          │                           │
│                          ▼                           │
│  ┌─────────────────────────────────────────────────┐│
│  │  ~/.skillsmith/                                 ││
│  │  ├── index/skills.db (SQLite + FTS5)           ││
│  │  ├── user/profile.json                         ││
│  │  └── config/settings.json                      ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

## Installation (Coming Soon)

```bash
npm install -g skillsmith
skillsmith register
```

## Usage (Coming Soon)

Once installed, Skillsmith tools are available directly in Claude Code:

```
# Search for skills
"Find skills for React testing"

# Get recommendations for your project
"What skills would help with this codebase?"

# Install a skill
"Install the jest-helper skill"

# Audit activation issues
"Why isn't my commit skill working?"
```

## Documentation

Detailed documentation is available in the `/docs` folder:

- [Architecture](/docs/architecture/) - System design and technical decisions
  - [Engineering Standards](/docs/architecture/standards.md) - Code quality policies
  - [Phase 2 Implementation](/docs/architecture/phase-2-implementation.md) - Current work
- [ADRs](/docs/adr/) - Architecture Decision Records
- [Retrospectives](/docs/retros/) - Phase learnings and improvements

## Development

Skillsmith uses **Docker-first development**. All commands run inside Docker to ensure consistent native module support across all platforms.

### Prerequisites

- **Docker Desktop** (v24+) or Docker Engine with Docker Compose
- **Git** (for cloning the repository)
- **Node.js** (optional, only for local tooling outside Docker)

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/skillsmith.git
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

For the full technical decision, see [ADR-002: Docker with glibc for Native Module Compatibility](/docs/adr/002-docker-glibc-requirement.md).

See [CLAUDE.md](CLAUDE.md) for full development workflow and skill configuration.

## Tech Stack

- **Runtime**: Node.js 18+ (Docker with glibc)
- **Protocol**: MCP (Model Context Protocol)
- **Database**: SQLite with FTS5
- **Embeddings**: all-MiniLM-L6-v2 via onnxruntime-node
- **Testing**: Vitest
- **CI/CD**: GitHub Actions

## License

[Apache License 2.0](LICENSE)

## Author

Smith Horn Group Ltd

---

*Skillsmith is not affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.*
