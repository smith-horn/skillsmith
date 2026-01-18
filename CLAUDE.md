# Claude Code Configuration - Skillsmith

## 🚨 CRITICAL: Docker-First Development

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

## ⚠️ IMPORTANT: License and Pricing Update (January 2026)

**As of January 2026, Skillsmith has migrated from Apache-2.0 to Elastic License 2.0.**

> **CRITICAL FOR AI AGENTS**: Documentation written before January 2026 may reference the old Apache-2.0 license and three-tier pricing. **IGNORE** any references to:
> - "Apache-2.0" license for Skillsmith packages
> - "Free tier unlimited" or "no rate limiting"
> - Three-tier structure (Community/Team/Enterprise only)

### Current License: Elastic License 2.0

All Skillsmith packages are now licensed under [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license):
- ✅ Self-hosting for internal use is permitted
- ✅ Modification for own use is permitted
- ❌ Cannot offer as a managed/hosted service to third parties
- ❌ Cannot circumvent license key functionality

### Current Four-Tier Pricing (with Usage Quotas)

| Tier | Price | API Calls/Month | Features |
|------|-------|-----------------|----------|
| **Community** | Free | 1,000 | Core features |
| **Individual** | $9.99/mo | 10,000 | Core + basic analytics |
| **Team** | $25/user/mo | 100,000 | Team workspaces, private skills |
| **Enterprise** | $55/user/mo | Unlimited | SSO, RBAC, audit logging |

**Authoritative References:**
- [ADR-013: Open Core Licensing](docs/adr/013-open-core-licensing.md) - License model
- [ADR-017: Quota Enforcement](docs/adr/017-quota-enforcement-system.md) - Usage quotas
- [packages/enterprise/src/license/quotas.ts](packages/enterprise/src/license/quotas.ts) - Quota constants

---

## Project Overview

Skillsmith is an MCP server for Claude Code skill discovery, installation, and management. It helps users find, evaluate, and install skills for their Claude Code environment.

This project uses SPARC (Specification, Pseudocode, Architecture, Refinement, Completion) methodology with Claude-Flow orchestration for systematic Test-Driven Development.

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

### Build Commands

| Command   | Local                     | Docker (PREFERRED)                                     |
| --------- | ------------------------- | ------------------------------------------------------ |
| Build     | `npm run build`           | `docker exec skillsmith-dev-1 npm run build`           |
| Test      | `npm run test`            | `docker exec skillsmith-dev-1 npm test`                |
| Lint      | `npm run lint`            | `docker exec skillsmith-dev-1 npm run lint`            |
| Typecheck | `npm run typecheck`       | `docker exec skillsmith-dev-1 npm run typecheck`       |
| Audit     | `npm run audit:standards` | `docker exec skillsmith-dev-1 npm run audit:standards` |
| Preflight | `npm run preflight`       | `docker exec skillsmith-dev-1 npm run preflight`       |

### Pre-flight Dependency Check (SMI-760)

Validates that all imported packages are listed in package.json dependencies:

```bash
docker exec skillsmith-dev-1 npm run preflight
```

### Docker Container Management

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

---

## SPARC Development Environment

### Concurrent Execution Rules

**ABSOLUTE RULES**:

1. ALL operations MUST be concurrent/parallel in a single message
2. **NEVER save working files, text/mds and tests to the root folder**
3. ALWAYS organize files in appropriate subdirectories
4. **USE CLAUDE CODE'S TASK TOOL** for spawning agents concurrently, not just MCP

### Golden Rule: "1 MESSAGE = ALL RELATED OPERATIONS"

**MANDATORY PATTERNS:**

- **TodoWrite**: ALWAYS batch ALL todos in ONE call (5-10+ todos minimum)
- **Task tool (Claude Code)**: ALWAYS spawn ALL agents in ONE message with full instructions
- **File operations**: ALWAYS batch ALL reads/writes/edits in ONE message
- **Bash commands**: ALWAYS batch ALL terminal operations in ONE message
- **Memory operations**: ALWAYS batch ALL memory store/retrieve in ONE message

### File Organization Rules

**NEVER save to root folder. Use these directories:**

- `/src` - Source code files
- `/tests` - Test files
- `/docs` - Documentation and markdown files
- `/config` - Configuration files
- `/scripts` - Utility scripts
- `/examples` - Example code

### SPARC Commands

#### Core Commands

- `npx claude-flow sparc modes` - List available modes
- `npx claude-flow sparc run <mode> "<task>"` - Execute specific mode
- `npx claude-flow sparc tdd "<feature>"` - Run complete TDD workflow
- `npx claude-flow sparc info <mode>` - Get mode details

#### Batchtools Commands

- `npx claude-flow sparc batch <modes> "<task>"` - Parallel execution
- `npx claude-flow sparc pipeline "<task>"` - Full pipeline processing
- `npx claude-flow sparc concurrent <mode> "<tasks-file>"` - Multi-task processing

### SPARC Workflow Phases

1. **Specification** - Requirements analysis (`sparc run spec-pseudocode`)
2. **Pseudocode** - Algorithm design (`sparc run spec-pseudocode`)
3. **Architecture** - System design (`sparc run architect`)
4. **Refinement** - TDD implementation (`sparc tdd`)
5. **Completion** - Integration (`sparc run integration`)

### Code Style & Best Practices

- **Modular Design**: Files under 500 lines
- **Environment Safety**: Never hardcode secrets
- **Test-First**: Write tests before implementation
- **Clean Architecture**: Separate concerns
- **Documentation**: Keep updated

---

## Claude Code Task Tool & Agents

### Claude Code's Task tool is the PRIMARY way to spawn agents

```javascript
// CORRECT: Use Claude Code's Task tool for parallel agent execution
[Single Message]:
  Task("Research agent", "Analyze requirements and patterns...", "researcher")
  Task("Coder agent", "Implement core features...", "coder")
  Task("Tester agent", "Create comprehensive tests...", "tester")
  Task("Reviewer agent", "Review code quality...", "reviewer")
  Task("Architect agent", "Design system architecture...", "system-architect")
```

**MCP tools are ONLY for coordination setup:**

- `mcp__claude-flow__swarm_init` - Initialize coordination topology
- `mcp__claude-flow__agent_spawn` - Define agent types for coordination
- `mcp__claude-flow__task_orchestrate` - Orchestrate high-level workflows

### Available Agents (54 Total)

#### Core Development

`coder`, `reviewer`, `tester`, `planner`, `researcher`

#### Swarm Coordination

`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`, `collective-intelligence-coordinator`, `swarm-memory-manager`

#### Consensus & Distributed

`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`, `consensus-builder`, `crdt-synchronizer`, `quorum-manager`, `security-manager`

#### Performance & Optimization

`perf-analyzer`, `performance-benchmarker`, `task-orchestrator`, `memory-coordinator`, `smart-agent`

#### GitHub & Repository

`github-modes`, `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`, `workflow-automation`, `project-board-sync`, `repo-architect`, `multi-repo-swarm`

#### SPARC Methodology

`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`, `refinement`

#### Specialized Development

`backend-dev`, `mobile-dev`, `ml-developer`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

#### Testing & Validation

`tdd-london-swarm`, `production-validator`

#### Migration & Planning

`migration-planner`, `swarm-init`

### Agent Coordination Protocol

**Every Agent Spawned via Task Tool MUST:**

**1. BEFORE Work:**

```bash
npx claude-flow@alpha hooks pre-task --description "[task]"
npx claude-flow@alpha hooks session-restore --session-id "swarm-[id]"
```

**2. DURING Work:**

```bash
npx claude-flow@alpha hooks post-edit --file "[file]" --memory-key "swarm/[agent]/[step]"
npx claude-flow@alpha hooks notify --message "[what was done]"
```

**3. AFTER Work:**

```bash
npx claude-flow@alpha hooks post-task --task-id "[task]"
npx claude-flow@alpha hooks session-end --export-metrics true
```

### Concurrent Execution Examples

#### CORRECT WORKFLOW: MCP Coordinates, Claude Code Executes

```javascript
// Step 1: MCP tools set up coordination (optional, for complex tasks)
[Single Message - Coordination Setup]:
  mcp__claude-flow__swarm_init { topology: "mesh", maxAgents: 6 }
  mcp__claude-flow__agent_spawn { type: "researcher" }
  mcp__claude-flow__agent_spawn { type: "coder" }
  mcp__claude-flow__agent_spawn { type: "tester" }

// Step 2: Claude Code Task tool spawns ACTUAL agents that do the work
[Single Message - Parallel Agent Execution]:
  Task("Research agent", "Analyze API requirements and best practices.", "researcher")
  Task("Coder agent", "Implement REST endpoints with authentication.", "coder")
  Task("Database agent", "Design and implement database schema.", "code-analyzer")
  Task("Tester agent", "Create comprehensive test suite with 90% coverage.", "tester")
  Task("Reviewer agent", "Review code quality and security.", "reviewer")

  // Batch ALL todos in ONE call
  TodoWrite { todos: [...8-10 todos...] }

  // Parallel file operations
  Bash "mkdir -p app/{src,tests,docs,config}"
```

#### WRONG (Multiple Messages):

```javascript
Message 1: mcp__claude-flow__swarm_init
Message 2: Task("agent 1")
Message 3: TodoWrite { todos: [single todo] }
// This breaks parallel coordination!
```

---

## MCP Tools & Orchestration

### Claude Code vs MCP Tools

**Claude Code Handles ALL EXECUTION:**

- **Task tool**: Spawn and run agents concurrently for actual work
- File operations (Read, Write, Edit, MultiEdit, Glob, Grep)
- Code generation and programming
- Bash commands and system operations
- TodoWrite and task management
- Git operations
- Testing and debugging

**MCP Tools ONLY COORDINATE:**

- Swarm initialization (topology setup)
- Agent type definitions (coordination patterns)
- Task orchestration (high-level planning)
- Memory management
- Neural features
- Performance tracking

**KEY**: MCP coordinates the strategy, Claude Code's Task tool executes with real agents.

### MCP Tool Categories

#### Coordination

`swarm_init`, `agent_spawn`, `task_orchestrate`

#### Monitoring

`swarm_status`, `agent_list`, `agent_metrics`, `task_status`, `task_results`

#### Memory & Neural

`memory_usage`, `neural_status`, `neural_train`, `neural_patterns`

#### GitHub Integration

`github_swarm`, `repo_analyze`, `pr_enhance`, `issue_triage`, `code_review`

#### System

`benchmark_run`, `features_detect`, `swarm_monitor`

### MCP Server Setup

```bash
# Add MCP servers (Claude Flow required, others optional)
claude mcp add claude-flow npx claude-flow@alpha mcp start
claude mcp add ruv-swarm npx ruv-swarm mcp start  # Optional: Enhanced coordination
claude mcp add flow-nexus npx flow-nexus@latest mcp start  # Optional: Cloud features
```

### Performance Benefits

- **84.8% SWE-Bench solve rate**
- **32.3% token reduction**
- **2.8-4.4x speed improvement**
- **27+ neural models**

### Advanced Features (v2.0.0)

- Automatic Topology Selection
- Parallel Execution (2.8-4.4x speed)
- Neural Training
- Bottleneck Analysis
- Smart Auto-Spawning
- Self-Healing Workflows
- Cross-Session Memory
- GitHub Integration

---

## Package Structure

```
packages/
├── core/        # @skillsmith/core - Database, repositories, services
├── mcp-server/  # @skillsmith/mcp-server - MCP tools (search, install, etc.)
└── cli/         # @skillsmith/cli - Command-line interface
```

## Skillsmith MCP Tools

| Tool              | Description                          | Example                                   |
| ----------------- | ------------------------------------ | ----------------------------------------- |
| `search`          | Search for skills with filters       | `"Find testing skills"`                   |
| `get_skill`       | Get detailed skill information       | `"Get details for community/jest-helper"` |
| `install_skill`   | Install a skill to ~/.claude/skills  | `"Install jest-helper"`                   |
| `uninstall_skill` | Remove an installed skill            | `"Uninstall jest-helper"`                 |
| `recommend`       | Get contextual skill recommendations | `"Recommend skills for React"`            |
| `validate`        | Validate a skill's structure         | `"Validate the commit skill"`             |
| `compare`         | Compare skills side-by-side          | `"Compare jest-helper and vitest-helper"` |

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

| Tier           | Description               |
| -------------- | ------------------------- |
| `verified`     | Official Anthropic skills |
| `community`    | Community-reviewed skills |
| `experimental` | New/beta skills           |
| `unknown`      | Unverified skills         |

---

## Skillsmith CLI Commands

The CLI (`skillsmith` or `sklx`) provides commands for skill management and authoring.

### Author Commands (SMI-1389, SMI-1390, SMI-1433)

Commands for skill authoring, subagent generation, and MCP server scaffolding.

| Command | Description | Example |
|---------|-------------|---------|
| `author subagent` | Generate companion subagent for a skill | `skillsmith author subagent ./my-skill` |
| `author transform` | Upgrade existing skill with subagent | `skillsmith author transform ./my-skill` |
| `author mcp-init` | Scaffold a new MCP server project | `skillsmith author mcp-init my-server` |

**subagent options**:
- `--output, -o <dir>`: Output directory (default: ~/.claude/agents)
- `--tools <list>`: Override detected tools (comma-separated)
- `--model <model>`: Specify model (sonnet, opus, haiku)
- `--skip-claude-md`: Skip CLAUDE.md delegation snippet
- `--force`: Overwrite existing subagent definition

**transform options**:
- `--dry-run`: Preview changes without writing files
- `--batch`: Process multiple skills (when given directory)
- `--tools <list>`: Override detected tools
- `--model <model>`: Specify model
- `--force`: Overwrite existing subagent

**mcp-init options**:
- `--output, -o <dir>`: Output directory (default: current directory)
- `--tools <list>`: Initial tool names (comma-separated)
- `--force`: Overwrite existing directory

**Tool Detection**: The commands automatically analyze skill content to determine minimal required tools (Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch).

> **Architecture**: See [Subagent Pair Generation Architecture](docs/architecture/subagent-pair-generation-architecture.md)

### Sync Commands (SMI-1467)

Commands for synchronizing local skill database with live registry.

| Command | Description | Example |
|---------|-------------|---------|
| `sync` | Sync skills from registry | `skillsmith sync` |
| `sync --force` | Force full sync | `skillsmith sync --force` |
| `sync --dry-run` | Preview changes | `skillsmith sync --dry-run` |
| `sync status` | Show sync status | `skillsmith sync status` |
| `sync history` | View sync history | `skillsmith sync history` |
| `sync config` | Configure auto-sync | `skillsmith sync config --show` |

**sync config options**:
- `--show`: Display current configuration
- `--enable`: Enable automatic background sync
- `--disable`: Disable automatic sync
- `--frequency <freq>`: Set frequency (`daily` or `weekly`)

> **Architecture**: See [ADR-018: Registry Sync System](docs/adr/018-registry-sync-system.md)

---

## Varlock Security (MANDATORY)

**All secrets MUST be managed via Varlock. Never expose API keys in terminal output.**

### Required Files

| File           | Purpose                                         | Commit? |
| -------------- | ----------------------------------------------- | ------- |
| `.env.schema`  | Defines variables with `@sensitive` annotations | Yes     |
| `.env.example` | Template with placeholder values                | Yes     |
| `.env`         | Actual secrets                                  | Never   |

### Safe Commands (Always Use)

```bash
# Validate environment (masked output)
varlock load

# Run commands with secrets injected
varlock run -- npm test
varlock run -- npx tsx scripts/query.ts

# Check schema (safe - no values)
cat .env.schema
```

### Unsafe Commands (NEVER Use)

```bash
# NEVER - exposes secrets to Claude's context
linear config show          # Exposes LINEAR_API_KEY
echo $LINEAR_API_KEY        # Exposes to terminal
cat .env                    # Exposes all secrets
printenv | grep API         # Exposes matching secrets
```

### Project Environment Variables

| Variable         | Type                          | Sensitivity | Description       |
| ---------------- | ----------------------------- | ----------- | ----------------- |
| `LINEAR_API_KEY` | `string(startsWith=lin_api_)` | Sensitive   | Linear API access |
| `NODE_ENV`       | `enum(dev,staging,prod)`      | Public      | Environment mode  |

---

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

### MCP Decision Helper (User-Level)

> **Location**: `~/.claude/skills/mcp-decision-helper/SKILL.md`

Helps decide whether to implement capabilities as Claude Code Skills vs MCP servers using an 8-dimension scoring framework.

**Trigger Phrases**: "should I use MCP", "skill vs MCP", "MCP or skill", "MCP decision"

**Key Features**:

- 8-dimension scoring framework
- Automatic disqualifiers for quick decisions
- Interactive CLI evaluation script
- Templates for Skill, MCP, and Hybrid implementations

**Quick Evaluation**:

```bash
# Interactive evaluation
npx tsx ~/.claude/skills/mcp-decision-helper/scripts/evaluate.ts

# With pre-filled task
npx tsx ~/.claude/skills/mcp-decision-helper/scripts/evaluate.ts --task "daily report generator"
```

**Decision Thresholds**: Score ≤ -6 → SKILL | Score -5 to +5 → HYBRID | Score ≥ +6 → MCP

### Linear Skill (User-Level)

> **Full Documentation**: [`~/.claude/skills/linear/skills/linear/SKILL.md`](~/.claude/skills/linear/skills/linear/SKILL.md)

Manages Linear issues, projects, and workflows. Available globally across all sessions.

**Skillsmith Project Context**:

- **Project**: Skillsmith Phase 7: Enterprise Features
- **Issue Prefix**: SMI-xxx
- **Team**: Smith Horn Group

**Quick Commands**:

```bash
# Mark issues as done (accepts SMI-123 or 123 format)
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done SMI-1089 SMI-1090

# Mark issues as in progress
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts wip SMI-1091

# Update to any status
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts status Done 1089 1090 1091

# Create issue
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-issue "Skillsmith" "Title" "Description"

# Check setup
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts whoami
```

**Configuration**: Requires `LINEAR_API_KEY` environment variable.

### CI/DevOps Skills (User-Level)

Five CI/DevOps skills are available globally for pipeline debugging and optimization:

| Skill                 | Trigger Phrases                            | Purpose                               |
| --------------------- | ------------------------------------------ | ------------------------------------- |
| `flaky-test-detector` | "flaky test", "intermittent failure"       | Detect timing-sensitive test patterns |
| `version-sync`        | "version mismatch", "upgrade node"         | Sync Node.js versions across files    |
| `ci-doctor`           | "CI failing", "workflow broken"            | Diagnose CI/CD pipeline issues        |
| `docker-optimizer`    | "slow docker build", "optimize Dockerfile" | Optimize Dockerfile for speed/size    |
| `security-auditor`    | "npm audit", "security vulnerability"      | Run structured security audits        |

---

## Linear Integration

Initiative: Skillsmith (SMI-xxx issues)

### Two-Document Model

| Document         | Purpose                            | Location           |
| ---------------- | ---------------------------------- | ------------------ |
| **CLAUDE.md**    | AI operational context             | Project root       |
| **standards.md** | Engineering policy (authoritative) | docs/architecture/ |

---

## Embedding Service Configuration (SMI-754)

The EmbeddingService supports both real ONNX embeddings and deterministic mock embeddings.

### Modes

| Mode               | Use Case                    | Performance     |
| ------------------ | --------------------------- | --------------- |
| **Real** (default) | Production, semantic search | ~50ms/embedding |
| **Fallback**       | Tests, CI, development      | <1ms/embedding  |

### Configuration

```typescript
// Real embeddings (default)
const service = new EmbeddingService({ dbPath: './cache.db' })

// Forced fallback mode for tests
const service = new EmbeddingService({ useFallback: true })

// Check current mode
console.log(service.isUsingFallback()) // true/false
```

### Environment Variable

Set `SKILLSMITH_USE_MOCK_EMBEDDINGS=true` to force fallback mode globally:

```bash
# In .env or shell
export SKILLSMITH_USE_MOCK_EMBEDDINGS=true
docker exec skillsmith-dev-1 npm test
```

> **ADR Reference**: See [ADR-009: Embedding Service Fallback Strategy](docs/adr/009-embedding-service-fallback.md)

---

## Neural Integration Tests (SMI-1535, SMI-1536)

The Recommendation Learning Loop has comprehensive integration tests in `packages/core/tests/integration/neural/`.

### Running Neural Tests

```bash
# Run all neural tests
docker exec skillsmith-dev-1 npm test -- packages/core/tests/integration/neural/

# Run specific test suite
docker exec skillsmith-dev-1 npm test -- packages/core/tests/integration/neural/signal-collection.test.ts
docker exec skillsmith-dev-1 npm test -- packages/core/tests/integration/neural/e2e-learning.test.ts
```

### Test Suites

| File | Tests | Coverage |
|------|-------|----------|
| `signal-collection.test.ts` | 11 | Signal recording/querying |
| `preference-learner.test.ts` | 14 | Profile updates, weight decay |
| `personalization.test.ts` | 13 | Recommendation re-ranking |
| `privacy.test.ts` | 13 | GDPR compliance, data wipe |
| `e2e-learning.test.ts` | 7 | Full learning loop validation |

### Test Infrastructure

- **`setup.ts`**: Mock implementations of all learning interfaces
- **`helpers.ts`**: Signal generation utilities (`generateSignal`, `generateUserJourney`, etc.)

> **Documentation**: See [Phase 5: Neural Testing](docs/execution/phase5-neural-testing.md)

---

## V3 Migration Benchmarks (SMI-1537)

Performance benchmarks for the V3 API migration.

```bash
# Run benchmarks
docker exec skillsmith-dev-1 npm run benchmark:v3

# With JSON output
docker exec skillsmith-dev-1 npx tsx scripts/benchmark-v3-migration.ts --json
```

**Targets:**

| Operation | V2 Baseline | Target | Speedup |
|-----------|-------------|--------|---------|
| Memory Operations | 200ms | 5ms | 40x |
| Embedding Search (10K) | 500ms | 3ms | 150x |
| Recommendation Pipeline | 800ms | 200ms | 4x |

Benchmarks run automatically on PRs via GitHub Actions.

---

## Architecture Documentation

Key architecture documents for this project:

| Document                                                                        | Purpose                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------- |
| [Skill Dependencies](docs/architecture/skill-dependencies.md)                   | Dependency graph showing skill relationships |
| [System Overview](docs/architecture/system-overview.md)                         | High-level system architecture               |
| [Architecture Index](docs/architecture/index.md)                                | Complete architecture documentation index    |
| [Engineering Standards](docs/architecture/standards.md)                         | Authoritative engineering policy             |
| [MCP Decision Engine](docs/architecture/mcp-decision-engine-architecture.md)    | Skill vs MCP decision framework              |
| [Indexer Infrastructure](docs/architecture/indexer-infrastructure.md)           | GitHub skill indexing with App authentication |

### Skill Dependency Quick Reference

| Skill                 | Required Tools  | Required Env Vars              |
| --------------------- | --------------- | ------------------------------ |
| docker                | Docker          | -                              |
| linear                | Node.js         | LINEAR_API_KEY                 |
| vercel-github-actions | Vercel CLI, Git | VERCEL_TOKEN                   |
| dev-browser           | Bun, Playwright | -                              |
| doc-screenshots       | -               | - (requires dev-browser skill) |
| mcp-decision-helper   | Node.js         | -                              |

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

### TypeScript errors after changes

```bash
docker exec skillsmith-dev-1 npm run build
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
NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.

**Remember: Claude Flow coordinates, Claude Code creates!**
