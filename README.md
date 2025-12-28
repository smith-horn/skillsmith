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

**Docker-first development** - All commands run inside Docker for consistent native module support.

```bash
# Start development container
docker compose --profile dev up -d

# Run commands inside Docker
docker exec skillsmith-dev-1 npm run build
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run lint
docker exec skillsmith-dev-1 npm run typecheck
```

See [CLAUDE.md](CLAUDE.md) for full development workflow.

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
