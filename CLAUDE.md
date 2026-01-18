# Claude Code Configuration - Skillsmith

## Docker-First Development

**All code execution MUST happen in Docker.** This ensures consistent environments and avoids native module issues.

```bash
# Start the development container (REQUIRED before any code execution)
docker compose --profile dev up -d

# ALL commands run inside Docker
docker exec skillsmith-dev-1 npm run build
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run lint
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm run audit:standards
```

> **Why Docker?** Native modules (better-sqlite3, onnxruntime-node) require glibc. See [ADR-002](docs/adr/002-docker-glibc-requirement.md).

---

## License and Pricing

**License**: [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) - See [ADR-013](docs/adr/013-open-core-licensing.md)

| Tier | Price | API Calls/Month | Features |
|------|-------|-----------------|----------|
| Community | Free | 1,000 | Core features |
| Individual | $9.99/mo | 10,000 | Core + basic analytics |
| Team | $25/user/mo | 100,000 | Team workspaces, private skills |
| Enterprise | $55/user/mo | Unlimited | SSO, RBAC, audit logging |

**References**: [ADR-017: Quota Enforcement](docs/adr/017-quota-enforcement-system.md) | [Quota Constants](packages/enterprise/src/license/quotas.ts)

---

## Project Overview

Skillsmith is an MCP server for Claude Code skill discovery, installation, and management. It helps users find, evaluate, and install skills for their Claude Code environment.

## Quick Start for Users

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"]
    }
  }
}
```

Once configured, you can ask Claude:
- "Search for testing skills"
- "Find verified skills for git workflows"
- "Compare jest-helper and vitest-helper"
- "Install the commit skill"

---

## Developer Guide

### Build Commands

| Command | Docker (PREFERRED) |
|---------|---------------------|
| Build | `docker exec skillsmith-dev-1 npm run build` |
| Test | `docker exec skillsmith-dev-1 npm test` |
| Lint | `docker exec skillsmith-dev-1 npm run lint` |
| Typecheck | `docker exec skillsmith-dev-1 npm run typecheck` |
| Audit | `docker exec skillsmith-dev-1 npm run audit:standards` |
| Preflight | `docker exec skillsmith-dev-1 npm run preflight` |

### Docker Container Management

```bash
docker compose --profile dev up -d      # Start container
docker compose --profile dev down       # Stop container
docker logs skillsmith-dev-1            # View logs
```

### After Pulling Changes

```bash
docker exec skillsmith-dev-1 npm install
docker exec skillsmith-dev-1 npm run build
```

### Native Module Issues

If you see `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatch:

```bash
docker exec skillsmith-dev-1 npm rebuild better-sqlite3
docker exec skillsmith-dev-1 npm rebuild onnxruntime-node
```

> See [ADR-012: Native Module Version Management](docs/adr/012-native-module-version-management.md)

---

## SPARC Development

### Core Commands

```bash
npx claude-flow sparc modes              # List available modes
npx claude-flow sparc tdd "<feature>"    # Run TDD workflow
npx claude-flow sparc run <mode> "<task>" # Execute specific mode
```

### Concurrent Execution Rules

1. ALL operations MUST be concurrent/parallel in a single message
2. **NEVER save working files to the root folder**
3. Use Claude Code's Task tool for spawning agents concurrently
4. Batch ALL todos in ONE TodoWrite call

### File Organization

- `/src` - Source code
- `/tests` - Test files
- `/docs` - Documentation
- `/scripts` - Utility scripts

### MCP Server Setup

```bash
claude mcp add claude-flow npx claude-flow@alpha mcp start
```

> See `.claude/agents/` for available agent definitions.

---

## Package Structure

```
packages/
├── core/        # @skillsmith/core - Database, repositories, services
├── mcp-server/  # @skillsmith/mcp-server - MCP tools (search, install, etc.)
└── cli/         # @skillsmith/cli - Command-line interface
```

## Skillsmith MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Search for skills with filters |
| `get_skill` | Get detailed skill information |
| `install_skill` | Install a skill to ~/.claude/skills |
| `uninstall_skill` | Remove an installed skill |
| `recommend` | Get contextual skill recommendations |
| `validate` | Validate a skill's structure |
| `compare` | Compare skills side-by-side |

### Trust Tiers

| Tier | Description |
|------|-------------|
| `verified` | Official Anthropic skills |
| `community` | Community-reviewed skills |
| `experimental` | New/beta skills |

---

## Skillsmith CLI Commands

The CLI (`skillsmith` or `sklx`) provides commands for skill management and authoring.

### Author Commands (SMI-1389, SMI-1390, SMI-1433)

| Command | Description |
|---------|-------------|
| `author subagent` | Generate companion subagent for a skill |
| `author transform` | Upgrade existing skill with subagent |
| `author mcp-init` | Scaffold a new MCP server project |

> See [Subagent Pair Generation Architecture](docs/architecture/subagent-pair-generation-architecture.md)

### Sync Commands (SMI-1467)

| Command | Description |
|---------|-------------|
| `sync` | Sync skills from registry |
| `sync status` | Show sync status |
| `sync config` | Configure auto-sync |

> See [ADR-018: Registry Sync System](docs/adr/018-registry-sync-system.md)

---

## Varlock Security

**All secrets MUST be managed via Varlock. Never expose API keys in terminal output.**

| File | Purpose | Commit? |
|------|---------|---------|
| `.env.schema` | Defines variables with `@sensitive` annotations | Yes |
| `.env.example` | Template with placeholder values | Yes |
| `.env` | Actual secrets | Never |

### Safe Commands

```bash
varlock load                    # Validate environment (masked output)
varlock run -- npm test         # Run with secrets injected
```

### Unsafe Commands (NEVER Use)

```bash
echo $LINEAR_API_KEY            # Exposes to terminal
cat .env                        # Exposes all secrets
```

---

## Skills Configuration

### Project Skills (`.claude/skills/`)

| Skill | Purpose | Trigger Phrases |
|-------|---------|-----------------|
| [governance](.claude/skills/governance/SKILL.md) | Engineering standards enforcement | "code review", "standards", "compliance" |
| [worktree-manager](.claude/skills/worktree-manager/SKILL.md) | Git worktree parallel development | "create worktree", "parallel development" |

**Quick Audit**: `docker exec skillsmith-dev-1 npm run audit:standards`

### User-Level Skills (`~/.claude/skills/`)

| Skill | Purpose | Trigger Phrases |
|-------|---------|-----------------|
| [linear](~/.claude/skills/linear/SKILL.md) | Linear issue management | "linear issue", "SMI-xxx" |
| [mcp-decision-helper](~/.claude/skills/mcp-decision-helper/SKILL.md) | Skill vs MCP decision framework | "should I use MCP", "skill vs MCP" |

### CI/DevOps Skills (User-Level)

| Skill | Purpose |
|-------|---------|
| `flaky-test-detector` | Detect timing-sensitive test patterns |
| `version-sync` | Sync Node.js versions across files |
| `ci-doctor` | Diagnose CI/CD pipeline issues |
| `docker-optimizer` | Optimize Dockerfile for speed/size |
| `security-auditor` | Run structured security audits |

---

## Linear Integration

Initiative: Skillsmith (SMI-xxx issues)

| Document | Purpose | Location |
|----------|---------|----------|
| **CLAUDE.md** | AI operational context | Project root |
| **standards.md** | Engineering policy (authoritative) | docs/architecture/ |

---

## Embedding Service Configuration

The EmbeddingService supports both real ONNX embeddings and deterministic mock embeddings.

| Mode | Use Case | Performance |
|------|----------|-------------|
| **Real** (default) | Production, semantic search | ~50ms/embedding |
| **Fallback** | Tests, CI, development | <1ms/embedding |

Set `SKILLSMITH_USE_MOCK_EMBEDDINGS=true` to force fallback mode globally.

> See [ADR-009: Embedding Service Fallback Strategy](docs/adr/009-embedding-service-fallback.md)

---

## Testing & Benchmarks

- **Neural Integration Tests**: See [docs/development/neural-testing.md](docs/development/neural-testing.md)
- **V3 Migration Benchmarks**: See [docs/development/benchmarks.md](docs/development/benchmarks.md)

---

## Architecture Documentation

| Document | Purpose |
|----------|---------|
| [Skill Dependencies](docs/architecture/system-design/skill-dependencies.md) | Dependency graph showing skill relationships |
| [System Overview](docs/architecture/system-design/system-overview.md) | High-level system architecture |
| [Architecture Index](docs/architecture/index.md) | Complete architecture documentation index |
| [Engineering Standards](docs/architecture/standards.md) | Authoritative engineering policy |
| [MCP Decision Engine](docs/architecture/mcp-decision-engine-architecture.md) | Skill vs MCP decision framework |
| [Indexer Infrastructure](docs/architecture/indexer-infrastructure.md) | GitHub skill indexing with App authentication |

---

## Troubleshooting

### Container won't start

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm install
```

### Tests fail with native module errors

```bash
docker exec skillsmith-dev-1 npm rebuild better-sqlite3
docker exec skillsmith-dev-1 npm rebuild onnxruntime-node
```

---

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues

---

## Important Instruction Reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.
