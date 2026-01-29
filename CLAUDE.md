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

## CI Health Requirements

**CI stability is a top priority.** All code changes must pass CI before merging. Monitor CI success rate and address issues proactively.

### Zero Tolerance Policy

| Category | Requirement |
|----------|-------------|
| ESLint | Zero warnings, zero errors |
| TypeScript | Strict mode, no `any` types without justification |
| Prettier | All files formatted |
| Tests | 100% pass rate, no flaky tests |
| Security | No high-severity vulnerabilities |

### Scripts Must Use Docker

**All scripts MUST use Docker for npm commands.** Local npm execution causes environment inconsistencies.

```bash
# CORRECT - Docker execution
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run build

# INCORRECT - Local execution (NEVER use)
npm test
npm run build
```

### Code Quality Standards

| Standard | Target | Tracked By |
|----------|--------|------------|
| ESLint warnings | 0 | CI lint job |
| Explicit `any` types | 0 (or justified) | ESLint rule |
| File size | < 500 lines | Governance audit |
| Test coverage | > 80% | Codecov |

### When CI Fails

1. **Do not merge** - CI failures block PRs
2. **Investigate immediately** - Check the failing job logs
3. **Create Linear issue** - If fix is non-trivial, track it
4. **Fix locally first** - Run `docker exec skillsmith-dev-1 npm run preflight` before pushing

---

## Git-Crypt (Encrypted Documentation)

**IMPORTANT**: The `docs/` directory and `.claude/hive-mind/` are encrypted with git-crypt. You MUST unlock before reading these files.

### Setup

Set `GIT_CRYPT_KEY_PATH` in your `.env` file (see `.env.example`). Key path is managed via Varlock.

### Check Status

```bash
git-crypt status docs/ | head -5
# If you see "encrypted:" prefix, files are locked
```

### Unlock (Required for Reading Docs)

```bash
# Unlock using Varlock-managed key path (tilde expansion required)
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'
```

### Troubleshooting: Files Still Encrypted After Unlock

If `git-crypt unlock` succeeds but files still show encrypted content, the smudge filter isn't being triggered. Use this workaround:

```bash
# Batch decrypt files manually (pipe through smudge filter)
for f in docs/gtm/*.md docs/gtm/**/*.md; do
  if [ -f "$f" ]; then
    cat "$f" | git-crypt smudge > "/tmp/$(basename $f)" 2>/dev/null
    mv "/tmp/$(basename $f)" "$f"
  fi
done
```

### Worktree Considerations

When creating git worktrees, git-crypt must be unlocked in the **main repo first**, then the worktree inherits the unlocked state.

```bash
# 1. Unlock in main repo first
cd /path/to/skillsmith
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'

# 2. Then create worktree
git worktree add ../worktrees/my-feature -b feature/my-feature
```

### Automated Worktree Creation (SMI-1822)

Use the automation script for creating worktrees in git-crypt encrypted repos:

```bash
# Create a new worktree with automatic git-crypt setup
./scripts/create-worktree.sh worktrees/my-feature feature/my-feature

# Show help
./scripts/create-worktree.sh --help
```

The script handles:
1. Validates git-crypt is unlocked in main repo
2. Creates worktree with `--no-checkout` to avoid smudge filter errors
3. Copies git-crypt keys to worktree's gitdir
4. Checks out files with decryption working

**Manual Method (if script unavailable):**

```bash
# Step 1: Create without checkout
git worktree add --no-checkout worktrees/<name> -b <branch> main

# Step 2: Find worktree's gitdir
GIT_DIR=$(cat worktrees/<name>/.git | sed 's/gitdir: //')

# Step 3: Copy git-crypt keys
mkdir -p "$GIT_DIR/git-crypt/keys"
cp -r .git/git-crypt/keys/* "$GIT_DIR/git-crypt/keys/"

# Step 4: Checkout files
cd worktrees/<name> && git reset --hard HEAD
```

### Encrypted Paths

| Path | Contains |
|------|----------|
| `docs/**` | ADRs, implementation plans, architecture docs |
| `.claude/hive-mind/**` | Hive mind execution configs |

**Exception**: `docs/development/*.md` and `docs/templates/*.md` are NOT encrypted.

---

## Claude-Flow MCP Server (REQUIRED for Hive Mind)

**IMPORTANT**: Hive mind execution and agent spawning require the claude-flow MCP server to be configured.

### Quick Setup

```bash
# Add MCP server (one-time setup)
claude mcp add claude-flow -- npx claude-flow@alpha mcp start

# Verify it's configured
claude mcp list | grep claude-flow
```

### Project-Level Configuration (Recommended)

The project includes `.mcp.json` for automatic MCP configuration:

```json
{
  "mcpServers": {
    "claude-flow": {
      "command": "npx",
      "args": ["claude-flow@alpha", "mcp", "start"],
      "env": {
        "CLAUDE_FLOW_LOG_LEVEL": "info",
        "CLAUDE_FLOW_MEMORY_BACKEND": "sqlite"
      }
    }
  }
}
```

### MCP Tools Available

Once configured, these tools become available for agent coordination:

| Tool | Purpose |
|------|---------|
| `mcp__claude-flow__swarm_init` | Initialize swarm with topology (hierarchical, mesh, etc.) |
| `mcp__claude-flow__agent_spawn` | Spawn specialist agents (architect, coder, tester, reviewer) |
| `mcp__claude-flow__task_orchestrate` | Coordinate task execution |
| `mcp__claude-flow__memory_usage` | Shared memory operations |
| `mcp__claude-flow__swarm_destroy` | Cleanup swarm after completion |

### Specialist Agent Types

| Agent | Role | Specialization |
|-------|------|----------------|
| `architect` | System design | API contracts, infrastructure, DDD |
| `coder` | Implementation | Backend, frontend, React, Astro, Rust |
| `tester` | QA | Unit, integration, E2E, security tests |
| `reviewer` | Code review | Security audit, best practices |
| `researcher` | Analysis | Codebase exploration, documentation |

### Example: Spawning Agents for a Wave

```javascript
// 1. Initialize swarm (use "laptop" profile for MacBook)
mcp__claude-flow__swarm_init({
  topology: "hierarchical",
  maxAgents: 2,  // MacBook constraint
  queen_model: "sonnet",
  worker_model: "haiku"
})

// 2. Spawn specialist team (all in single message for parallel execution)
mcp__claude-flow__agent_spawn({ type: "architect" })
mcp__claude-flow__agent_spawn({ type: "coder" })
mcp__claude-flow__agent_spawn({ type: "tester" })
mcp__claude-flow__agent_spawn({ type: "reviewer" })

// 3. Execute and coordinate via task_orchestrate
mcp__claude-flow__task_orchestrate({
  task: "Implement SMI-XXX feature",
  strategy: "parallel"
})
```

**See Also**:
- [Hive Mind Execution Skill](.claude/skills/hive-mind-execution/SKILL.md)
- [Hive Mind Advanced Skill](.claude/skills/hive-mind-advanced/SKILL.md)

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

```
"Search for testing skills"
"Find verified skills for git workflows"
"Show details for community/jest-helper"
"Compare jest-helper and vitest-helper"
"Install the commit skill"
"Recommend skills for my React project"
"Browse all security skills"
"Show verified skills"
"List high-quality skills (score > 80)"
```

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

### Docker Container Rebuild (SMI-1781)

The Docker volume `node_modules` persists across container restarts. Use the appropriate method based on change scope:

**Restart (fast) - Minor changes, adding dependencies:**
```bash
docker compose --profile dev down
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm install
```

**Full Rebuild (thorough) - Major version upgrades, native module changes, dependency conflicts:**
```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules  # Clear cached node_modules
docker compose --profile dev build --no-cache
docker compose --profile dev up -d
```

| Scenario | Use |
|----------|-----|
| Adding a new dependency | Restart |
| Updating patch/minor versions | Restart |
| Major version upgrade (e.g., Stripe v14→v20) | Full Rebuild |
| Native module issues (better-sqlite3, onnxruntime) | Full Rebuild |
| TypeScript errors after `npm install` | Full Rebuild |
| `NODE_MODULE_VERSION` mismatch | Full Rebuild |

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

- `query` (optional): Search term. Required if no filters provided.
- `category`: Filter by category (development, testing, devops, etc.)
- `trust_tier`: Filter by trust level (verified, community, experimental)
- `min_score`: Minimum quality score (0-100)
- `limit`: Max results (default 10)

**Note:** Either `query` OR at least one filter (`category`, `trust_tier`, `min_score`) must be provided.

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

### API Authentication (SMI-1950)

The MCP server supports three authentication modes:

| Mode | Header | Rate Limit | Usage Tracking |
|------|--------|------------|----------------|
| Personal API Key | `X-API-Key: sk_live_*` | Tier-based (60-300/min) | ✅ Account dashboard |
| Supabase Anon Key | `Authorization: Bearer eyJ...` | 30/min (community) | ❌ Not tracked |
| No Auth | None | 10 total (trial) | ❌ Not tracked |

**To track usage on your account**, configure your personal API key:

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

Get your API key from https://skillsmith.app/account after signing up.

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
| [governance](.claude/skills/governance/SKILL.md) | Engineering standards enforcement | "code review", "standards", "compliance", "retro" |
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
- **Stripe CLI Testing**: See [docs/development/stripe-testing.md](docs/development/stripe-testing.md)

### Test File Locations (SMI-1780)

Vitest only runs tests matching these include patterns. Tests in other locations will be silently ignored.

| Pattern | Example Location |
|---------|------------------|
| `packages/*/src/**/*.test.ts` | `packages/core/src/foo.test.ts` |
| `packages/*/src/**/*.spec.ts` | `packages/mcp-server/src/bar.spec.ts` |
| `packages/*/tests/**/*.test.ts` | `packages/core/tests/unit/foo.test.ts` |
| `packages/*/tests/**/*.spec.ts` | `packages/enterprise/tests/integration/bar.spec.ts` |
| `tests/**/*.test.ts` | `tests/unit/utils.test.ts` |
| `supabase/functions/**/*.test.ts` | `supabase/functions/indexer/index.test.ts` |
| `scripts/tests/**/*.test.ts` | `scripts/tests/validate-skills.test.ts` |

**Common Mistakes:**
- `scripts/__tests__/foo.test.ts` - Wrong directory name (use `scripts/tests/`)
- `packages/core/test/foo.test.ts` - Wrong directory name (use `tests/` plural)
- `src/foo.test.ts` - Must be inside a package

> Reference: `vitest.config.ts` lines 7-19

---

## Hive Mind Orchestration

Hive mind configs enable multi-agent task orchestration with coordinated memory and quality gates.

### Configuration Location

```
.claude/hive-mind/
├── README.md              # Usage documentation
└── *.yaml                 # Task configurations
```

### Quick Start

```bash
# Run a hive mind configuration
./start-hive-mind.sh

# Or use claude-flow directly
npx claude-flow swarm --config .claude/hive-mind/your-config.yaml
```

### Resource Profiles

| Profile | Max Agents | Use Case |
|---------|------------|----------|
| `laptop` | 2 | M1/M4 MacBook development |
| `workstation` | 4 | Desktop with more resources |
| `server` | 8+ | CI/CD or cloud execution |

### When to Version Configs

- **Version**: Reusable templates, team workflows, release processes
- **Gitignore**: One-time tasks, personal preferences, experiments

> See [.claude/hive-mind/README.md](.claude/hive-mind/README.md) for full documentation

---

## Supabase Edge Functions

| Function | Purpose | Auth |
|----------|---------|------|
| `early-access-signup` | Email waitlist signup with rate limiting, honeypot, Resend emails | Anonymous |
| `contact-submit` | Contact form submissions with email notifications | Anonymous |
| `checkout` | Stripe checkout session creation | Anonymous |
| `stripe-webhook` | Stripe webhook handler (subscriptions, payments, license keys) | Anonymous |
| `create-portal-session` | Stripe customer portal session creation | Authenticated |
| `list-invoices` | List customer invoices from Stripe | Authenticated |
| `update-seat-count` | Update subscription seat count | Authenticated |
| `stats` | Public stats (skill count) for homepage | Anonymous |
| `skills-search` | Skill search API | API Key |
| `skills-get` | Get skill details | API Key |
| `skills-recommend` | Skill recommendations | API Key |
| `indexer` | GitHub skill indexing (scheduled) | Service Role |
| `skills-refresh-metadata` | Refresh metadata for existing skills (scheduled) | Service Role |
| `ops-report` | Weekly operations report with email | Service Role |
| `alert-notify` | Send alert emails on job failures | Service Role |

**Deploy a function:**
```bash
npx supabase functions deploy <function-name> --no-verify-jwt  # Anonymous access
npx supabase functions deploy <function-name>                   # Requires auth
```

**Functions requiring `--no-verify-jwt`:**

These functions bypass Supabase gateway JWT validation and handle auth internally:

```bash
# Anonymous functions (no auth required)
npx supabase functions deploy early-access-signup --no-verify-jwt
npx supabase functions deploy contact-submit --no-verify-jwt
npx supabase functions deploy stats --no-verify-jwt
npx supabase functions deploy skills-search --no-verify-jwt
npx supabase functions deploy skills-get --no-verify-jwt
npx supabase functions deploy skills-recommend --no-verify-jwt
npx supabase functions deploy stripe-webhook --no-verify-jwt
npx supabase functions deploy checkout --no-verify-jwt
npx supabase functions deploy events --no-verify-jwt

# Authenticated functions with internal JWT validation
# These validate the user token in function code, not at gateway
npx supabase functions deploy generate-license --no-verify-jwt
npx supabase functions deploy regenerate-license --no-verify-jwt
npx supabase functions deploy create-portal-session --no-verify-jwt
npx supabase functions deploy list-invoices --no-verify-jwt
```

> **Why these functions use `--no-verify-jwt`:** The Supabase gateway rejects user JWTs from the frontend auth flow. These functions validate tokens internally using `supabase.auth.getUser()`. See SMI-1906 for details.

> **Note**: The `verify_jwt` setting is also configured in `supabase/config.toml` for local development. When deploying to production, you must use the `--no-verify-jwt` flag explicitly.

**CI Protection (SMI-1900):** Anonymous functions are validated by `npm run audit:standards`. If you add a new anonymous function:
1. Add `[functions.<name>]` with `verify_jwt = false` to `supabase/config.toml`
2. Add deploy command to the anonymous functions list above
3. Add function name to `ANONYMOUS_FUNCTIONS` array in `scripts/audit-standards.mjs`

### CORS Configuration (SMI-1904)

CORS is configured in `supabase/functions/_shared/cors.ts`:

| Origin Type | Handling |
|-------------|----------|
| Production domains | Always allowed (`skillsmith.app`, `skillsmith.dev`) |
| Vercel preview URLs | Auto-allowed via pattern (`*-smithhorngroup.vercel.app`) |
| Localhost | Always allowed for development |
| Custom domains | Add via `CORS_ALLOWED_ORIGINS` env var |

**Adding custom origins:**

Set in Supabase Dashboard → Edge Functions → Secrets:
```
CORS_ALLOWED_ORIGINS=https://custom.example.com,https://staging.skillsmith.app
```

Or via CLI:
```bash
npx supabase secrets set CORS_ALLOWED_ORIGINS="https://custom.example.com"
```

CI will fail if any anonymous function is missing from config.toml or CLAUDE.md.

---

## Monitoring & Alerts

### Scheduled Jobs

| Job | Schedule | Function |
|-----|----------|----------|
| Skill Indexer | Daily 2 AM UTC | `indexer` |
| Metadata Refresh | Hourly :30 | `skills-refresh-metadata` |
| Weekly Ops Report | Monday 9 AM UTC | `ops-report` |
| Billing Monitor | Monday 9 AM UTC | GitHub Actions only |

### Alert Notifications

Alerts are sent to `support@skillsmith.app` via Resend when:
- Indexer workflow fails
- Metadata refresh workflow fails (scheduled runs only)
- Weekly ops report detects anomalies

**Trigger manual ops report:**
```bash
varlock run -- bash -c 'curl -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"days\": 7, \"dryRun\": false}" \
  "$SUPABASE_URL/functions/v1/ops-report"'
```

### Audit Logs

All scheduled jobs log to the `audit_logs` table:
- `indexer:run` - Skill indexing results
- `refresh:run` - Metadata refresh results
- `ops-report:sent` - Weekly report sent
- `alert:sent` - Alert notification sent

---

## Architecture Documentation

| Document | Purpose |
|----------|---------|
| [Skill Dependencies](docs/architecture/system-design/skill-dependencies.md) | Dependency graph showing skill relationships |
| [System Overview](docs/architecture/system-design/system-overview.md) | High-level system architecture |
| [Architecture Index](docs/architecture/index.md) | Complete architecture documentation index |
| [Engineering Standards](docs/architecture/standards.md) | Authoritative engineering policy |
| [Database Standards](docs/architecture/standards-database.md) | Migration patterns, function security, RLS |
| [MCP Decision Engine](docs/architecture/mcp-decision-engine-architecture.md) | Skill vs MCP decision framework |
| [Indexer Infrastructure](docs/architecture/indexer-infrastructure.md) | GitHub skill indexing with App authentication |
| [Astro Script Patterns](docs/architecture/standards-astro.md) | Module vs inline scripts, server-to-client data passing, **layout consistency & auth navigation** |

---

## Process Documentation

| Document | Purpose |
|----------|---------|
| [Context Compaction](docs/process/context-compaction.md) | AI context window management, session recovery, hive mind coordination |
| [Linear Hygiene Guide](docs/process/linear-hygiene-guide.md) | Issue management and workflow standards |
| [Wave Completion Checklist](docs/process/wave-completion-checklist.md) | Quality gates for wave-based development |
| [Exploration Phase Template](docs/process/exploration-phase-template.md) | Template for exploration/discovery phases |

---

## Website Documentation (skillsmith.app)

Public documentation pages at https://skillsmith.app/docs:

| Page | Path | Description |
|------|------|-------------|
| Overview | `/docs` | Main documentation landing page |
| Getting Started | `/docs/getting-started` | Setup guide for MCP server and CLI |
| Quickstart | `/docs/quickstart` | Dual workflow paths for quick setup |
| CLI Reference | `/docs/cli` | Complete CLI command reference |
| MCP Server | `/docs/mcp-server` | MCP server configuration |
| API Reference | `/docs/api` | API documentation for integrators |
| Security | `/docs/security` | Security scanning, threat model, best practices |
| Quarantine | `/docs/quarantine` | Quarantine severity levels and resolution process |
| Trust Tiers | `/docs/trust-tiers` | Four-tier trust system (Official, Verified, Community, Unverified) |

**Deployment**: Website requires manual deployment via Vercel CLI:
```bash
cd packages/website && vercel --prod
```

**Contact Form**: All user inquiries route through `/contact` form (no exposed email addresses).
- Supports `?topic=` URL param: `verification`, `security`, `support`, `enterprise`, `general`, etc.
- `/verify` redirects to `/contact?topic=verification`

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

### VSCode extension build fails with "@esbuild/linux-x64" not found

This occurs when `npm ci --ignore-scripts` skips esbuild's postinstall script that downloads platform-specific binaries.

```bash
docker exec skillsmith-dev-1 npm rebuild esbuild
```

> **Note**: The Dockerfile already handles this via `npm rebuild better-sqlite3 onnxruntime-node esbuild`

### Orphaned Agent Processes

If background agents don't terminate properly:

```bash
# Preview orphaned processes
./scripts/cleanup-orphans.sh --dry-run

# Kill orphaned processes
./scripts/cleanup-orphans.sh
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
