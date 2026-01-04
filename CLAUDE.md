# Claude Code Configuration - Skillsmith

## Project Overview

Skillsmith is an MCP server for Claude Code skill discovery, installation, and management. It helps users find, evaluate, and install skills for their Claude Code environment.

## Quick Start for Users

### Configure Skillsmith MCP Server

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

### Using Skillsmith in Claude Code

Once configured, you can ask Claude:

```
"Search for testing skills"
"Find verified skills for git workflows"
"Show details for community/jest-helper"
"Compare jest-helper and vitest-helper"
"Install the commit skill"
"Recommend skills for my React project"
```

---

## Developer Guide

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
| Preflight | `npm run preflight` | `docker exec skillsmith-dev-1 npm run preflight` |

### Pre-flight Dependency Check (SMI-760)

Validates that all imported packages are listed in package.json dependencies. Run before deployment to catch missing dependencies early:

```bash
docker exec skillsmith-dev-1 npm run preflight
```

The script scans all TypeScript source files for imports and verifies each external package is declared. It automatically skips:
- Node.js built-in modules (fs, path, crypto, etc.)
- Workspace packages (@skillsmith/*)
- Runtime-provided modules (vscode for VS Code extensions)

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

If you see `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatch:

```bash
# Rebuild native modules inside container
docker exec skillsmith-dev-1 npm rebuild

# Or rebuild locally after Node.js version change
npm rebuild better-sqlite3
```

> **See also**: [ADR-012: Native Module Version Management](docs/adr/012-native-module-version-management.md)

### Hive Mind Orchestrator

Run in Docker: `docker compose --profile orchestrator up`

See [Hive Mind Execution Skill](.claude/skills/hive-mind-execution/SKILL.md) for workflow and options.
See [ADR-012](docs/adr/012-native-module-version-management.md) for native module management.

## MCP Tools Provided

| Tool | Description | Example |
|------|-------------|---------|
| `search` | Search for skills with filters | `"Find testing skills"` |
| `get_skill` | Get detailed skill information | `"Get details for community/jest-helper"` |
| `install_skill` | Install a skill to ~/.claude/skills | `"Install jest-helper"` |
| `uninstall_skill` | Remove an installed skill | `"Uninstall jest-helper"` |
| `recommend` | Get contextual skill recommendations | `"Recommend skills for React"` |
| `validate` | Validate a skill's structure | `"Validate the commit skill"` |
| `compare` | Compare skills side-by-side | `"Compare jest-helper and vitest-helper"` |

### Tool Parameters

**search**
- `query` (required): Search term (min 2 characters)
- `category`: Filter by category (development, testing, devops, etc.)
- `trust_tier`: Filter by trust level (verified, community, experimental)
- `min_score`: Minimum quality score (0-100)
- `limit`: Max results (default 10)

**get_skill**
- `id` (required): Skill ID in format `author/name`

**compare**
- `skill_ids` (required): Array of skill IDs to compare (2-5 skills)

### Trust Tiers

| Tier | Description |
|------|-------------|
| `verified` | Official Anthropic skills |
| `community` | Community-reviewed skills |
| `experimental` | New/beta skills |
| `unknown` | Unverified skills |

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
# Create worktree from main repository (run from project root)
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
- `LINEAR_TEAM_ID` - Required for E2E test issue creation (UUID format)
- `DEBUG_LINEAR_HOOK=true` - Enable verbose output for debugging

**Advanced Operations**:

```bash
# Create issue for Skillsmith
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-issue "Skillsmith" "Issue title" "Description"

# Query project issues
npx tsx ~/.claude/skills/linear/skills/linear/scripts/query.ts 'query { issues(filter: {project: {name: {eq: "Skillsmith"}}}) { nodes { identifier title state { name } } } }'
```

### CI/DevOps Skills (User-Level)

Five CI/DevOps skills are available globally for pipeline debugging and optimization:

| Skill | Trigger Phrases | Purpose |
|-------|-----------------|---------|
| `flaky-test-detector` | "flaky test", "intermittent failure" | Detect timing-sensitive test patterns |
| `version-sync` | "version mismatch", "upgrade node" | Sync Node.js versions across files |
| `ci-doctor` | "CI failing", "workflow broken" | Diagnose CI/CD pipeline issues |
| `docker-optimizer` | "slow docker build", "optimize Dockerfile" | Optimize Dockerfile for speed/size |
| `security-auditor` | "npm audit", "security vulnerability" | Run structured security audits |

**Quick Commands**:

```bash
# Detect flaky test patterns
npx tsx ~/.claude/skills/flaky-test-detector/scripts/index.ts

# Check Node.js version consistency
npx tsx ~/.claude/skills/version-sync/scripts/index.ts check

# Diagnose CI issues
npx tsx ~/.claude/skills/ci-doctor/scripts/index.ts

# Analyze Dockerfile
npx tsx ~/.claude/skills/docker-optimizer/scripts/index.ts

# Security audit
npx tsx ~/.claude/skills/security-auditor/scripts/index.ts
```

> **Spec**: See [docs/skills/ci-devops-skills.md](docs/skills/ci-devops-skills.md) for full specification.

### Two-Document Model

| Document | Purpose | Location |
|----------|---------|----------|
| **CLAUDE.md** | AI operational context | Project root |
| **standards.md** | Engineering policy (authoritative) | docs/architecture/ |

## Linear Integration

Project: Skillsmith (SMI-xxx issues)

- Phase 0: Validation - COMPLETED ([Retro](docs/retros/phase-0-validation.md))
- Phase 1: Foundation - COMPLETED
- Phase 2a: GitHub Indexing - COMPLETED
- Phase 2b: TDD Security - COMPLETED
- Phase 2c: Performance & Polish - COMPLETED
- Phase 2d: Security Hardening - COMPLETED
- Phase 2e: Code Review Fixes - COMPLETED
- Phase 2f: Batched Execution - COMPLETED
- Phase 3a: MCP Tool Wiring - COMPLETED
- Phase 3b: Data Import & Testing - COMPLETED
- Phase 3c: Documentation - COMPLETED
- Phase 4.5: CI/DevOps Skills - COMPLETED (SMI-978 through SMI-990)

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

## Embedding Service Configuration (SMI-754)

The EmbeddingService supports both real ONNX embeddings and deterministic mock embeddings.

### Modes

| Mode | Use Case | Performance |
|------|----------|-------------|
| **Real** (default) | Production, semantic search | ~50ms/embedding |
| **Fallback** | Tests, CI, development | <1ms/embedding |

### Configuration

```typescript
// Real embeddings (default)
const service = new EmbeddingService({ dbPath: './cache.db' });

// Forced fallback mode for tests
const service = new EmbeddingService({ useFallback: true });

// Check current mode
console.log(service.isUsingFallback()); // true/false
```

### Environment Variable

Set `SKILLSMITH_USE_MOCK_EMBEDDINGS=true` to force fallback mode globally:

```bash
# In .env or shell
export SKILLSMITH_USE_MOCK_EMBEDDINGS=true
docker exec skillsmith-dev-1 npm test
```

### ADR Reference

See [ADR-009: Embedding Service Fallback Strategy](docs/adr/009-embedding-service-fallback.md)

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
