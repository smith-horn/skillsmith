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

Enforces engineering standards from [standards.md](docs/architecture/standards.md).

**Trigger Phrases**: "code review", "commit", "standards", "compliance", "best practices"

**Quick Audit** (run in Docker):

```bash
docker exec skillsmith-dev-1 npm run audit:standards
```

### Worktree Manager Skill

> **Location**: [.claude/skills/worktree-manager/SKILL.md](.claude/skills/worktree-manager/SKILL.md)

Manages git worktrees for parallel development with conflict prevention.

**Trigger Phrases**: "create worktree", "parallel development", "feature branch", "merge worktree"

**Key Features**:
- Staggered exports strategy (prevents index.ts conflicts)
- Rebase-first workflow
- Multi-session coordination

**Quick Start**:

```bash
# Create worktree from main repository
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith
git worktree add ../worktrees/feature-name -b feature/feature-name
```

### Linear Skill (User-Level)

> **Location**: `~/.claude/skills/linear/skills/linear/SKILL.md`

Manages Linear issues, projects, and workflows. Available globally across all sessions.

**Skillsmith Project Context**:
- **Project**: Skillsmith
- **Issue Prefix**: SMI-xxx
- **Team**: Check with `npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts whoami`

**Quick Commands** (preferred):

```bash
# Mark issue as done
npm run linear:done SMI-644

# Mark issue as in progress
npm run linear:wip SMI-640

# Check issues in recent commits
npm run linear:check

# Auto-sync from last commit message
npm run linear:sync

# Test the post-commit hook manually
npm run linear:hook

# Test with debug output
npm run linear:hook:debug
```

**Automatic Post-Commit Hook** (SMI-710):

The project includes an automatic post-commit hook that syncs Linear issues:

- Extracts `SMI-xxx` issue references from commit messages
- Marks issues as `in_progress` by default
- Marks as `done` if commit message contains: fix, close, complete, done, finish, resolve
- Runs in background (does not block git operations)
- Fails silently if `LINEAR_API_KEY` is not set
- Times out after 2 seconds

**Configuration**:
- `LINEAR_API_KEY` - Required for Linear API access (silent fail if unset)
- `DEBUG_LINEAR_HOOK=true` - Enable verbose output for debugging

**Advanced Operations**:

```bash
# Create issue for Skillsmith
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-issue "Skillsmith" "Issue title" "Description"

# Query project issues
npx tsx ~/.claude/skills/linear/skills/linear/scripts/query.ts 'query { issues(filter: {project: {name: {eq: "Skillsmith"}}}) { nodes { identifier title state { name } } } }'
```

### Two-Document Model

| Document | Purpose | Location |
|----------|---------|----------|
| **CLAUDE.md** | AI operational context | Project root |
| **standards.md** | Engineering policy (authoritative) | docs/architecture/ |

## Linear Integration

Project: Skillsmith (SMI-xxx issues)

- Phase 0: Validation - COMPLETED ([Retro](docs/retros/phase-0-validation.md))
- Phase 1: Foundation - COMPLETED
- Phase 2: Recommendations - IN PROGRESS
- Phase 2c: Performance & Polish - COMPLETED

### Key Issues

| Issue | Description | Status |
|-------|-------------|--------|
| SMI-644 | Tiered Cache Layer with TTL | Done |
| SMI-683 | Cache race condition fixes | Done |
| SMI-684 | Prototype pollution prevention | Done |
| SMI-611 | Workspace dependency installation | Done |
| SMI-612 | MCP SDK type declarations | Done |
| SMI-613 | Implicit any type annotations | Done |
| SMI-617 | Docker native module compilation | Done |
| SMI-614 | Pre-commit hooks | Done |
| SMI-615 | CI/CD pipeline | Done |
| SMI-616 | Integration tests | Done |
| SMI-708 | CI/CD Docker layer caching optimization | Done |
| SMI-709 | VS Code MCP client integration | Done |
| SMI-710 | Post-commit hook for automatic Linear sync | Done |
| SMI-712 | CI workflow fixes | Done |
| SMI-716 | Prettier formatting | Done |
| SMI-717 | File splitting analysis | Done |
| SMI-718 | Coverage threshold fixes | Done |
| SMI-719 | Docker guard hook | Done |

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
