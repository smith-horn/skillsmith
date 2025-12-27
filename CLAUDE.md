# Claude Code Configuration - Skillsmith

## Project Overview

Skillsmith is an MCP server for Claude Code skill discovery, installation, and management. It helps users find, evaluate, and install skills for their Claude Code environment.

## IMPORTANT: Docker-First Development

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

## Build Commands

| Command | Local | Docker (PREFERRED) |
|---------|-------|-------------------|
| Build | `npm run build` | `docker exec skillsmith-dev-1 npm run build` |
| Test | `npm run test` | `docker exec skillsmith-dev-1 npm test` |
| Lint | `npm run lint` | `docker exec skillsmith-dev-1 npm run lint` |
| Typecheck | `npm run typecheck` | `docker exec skillsmith-dev-1 npm run typecheck` |
| Audit | `npm run audit:standards` | `docker exec skillsmith-dev-1 npm run audit:standards` |

## Package Structure

```
packages/
├── core/        # @skillsmith/core - Database, repositories, services
├── mcp-server/  # @skillsmith/mcp-server - MCP tools (search, install, etc.)
└── cli/         # @skillsmith/cli - Command-line interface
```

## Docker Development

### Container Management

```bash
# Start container (required first)
docker compose --profile dev up -d

# Check container status
docker ps | grep skillsmith

# View logs
docker logs skillsmith-dev-1

# Stop container
docker compose --profile dev down

# Rebuild after Dockerfile changes
docker compose --profile dev build --no-cache
docker compose --profile dev up -d
```

### After Pulling Changes

When pulling changes that modify `package.json`:

```bash
docker exec skillsmith-dev-1 npm install
docker exec skillsmith-dev-1 npm run build
```

### Native Module Issues

If you see `ERR_DLOPEN_FAILED`:

```bash
# Rebuild native modules inside container
docker exec skillsmith-dev-1 npm rebuild
```

## MCP Tools Provided

| Tool | Description |
|------|-------------|
| `search` | Search for skills with filters |
| `get_skill` | Get detailed skill information |
| `install_skill` | Install a skill to ~/.claude/skills |
| `uninstall_skill` | Remove an installed skill |

## Code Style

- TypeScript strict mode enabled
- ESLint + Prettier formatting
- Vitest for testing
- JSDoc for public APIs

## Cross-References

> **Engineering Standards**: See [docs/architecture/standards.md](docs/architecture/standards.md) for authoritative policy
> **ADRs**: See [docs/adr/](docs/adr/) for architecture decisions
> **Retrospectives**: See [docs/retros/](docs/retros/) for phase retrospectives

## Quick Reference

### Pre-Commit Checklist (run in Docker)

```bash
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm run lint
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run audit:standards
```

### Naming Conventions (§1.2 in standards.md)

- Files: PascalCase for components, camelCase for utilities
- Variables: camelCase
- Constants: SCREAMING_SNAKE_CASE
- DB columns: snake_case

## Skills in Use

### Governance Skill

> **Location**: [.claude/skills/governance/SKILL.md](.claude/skills/governance/SKILL.md)

Enforces engineering standards and code quality policies during development.

**Trigger Phrases**: "code review", "review this", "commit", "standards", "compliance", "code quality", "best practices", "before I merge"

**Key Commands** (run in Docker):

```bash
docker exec skillsmith-dev-1 npm run audit:standards
docker exec skillsmith-dev-1 node .claude/skills/governance/scripts/governance-check.mjs
```

**When Active**:

- During code review discussions
- Before commits (reminds about pre-commit checklist)
- When discussing code quality or standards

**Two-Document Model**:

| Document | Purpose | Location |
|----------|---------|----------|
| **CLAUDE.md** | AI operational context | Project root |
| **standards.md** | Engineering policy (authoritative) | docs/architecture/ |

## Linear Integration

Project: Skillsmith (SMI-xxx issues)

- Phase 0: Validation - COMPLETED ([Retro](docs/retros/phase-0-validation.md))
- Phase 1: Foundation - IN PROGRESS
- Phase 2: Recommendations - Planned

### Key Issues

| Issue | Description | Status |
|-------|-------------|--------|
| SMI-611 | Workspace dependency installation | Done |
| SMI-612 | MCP SDK type declarations | Done |
| SMI-613 | Implicit any type annotations | Done |
| SMI-617 | Docker native module compilation | Done |
| SMI-614 | Pre-commit hooks | Todo |
| SMI-615 | CI/CD pipeline | Todo |
| SMI-616 | Integration tests | Todo |

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

### TypeScript errors after changes

```bash
docker exec skillsmith-dev-1 npm run build
```
