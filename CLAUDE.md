# Claude Code Configuration - Skillsmith

## Sub-Documentation

Detailed guides extracted via progressive disclosure. CLAUDE.md contains essentials; sub-docs contain deep dives.

| Document | Description |
|----------|-------------|
| [docker-guide.md](.claude/development/docker-guide.md) | Container rebuild scenarios, DNS failure, native modules, troubleshooting |
| [git-crypt-guide.md](.claude/development/git-crypt-guide.md) | Unlock, worktree setup, rebase workaround, smudge filter fixes |
| [ci-reference.md](.claude/development/ci-reference.md) | Branch protection, change classification, Turborepo, CI scripts |
| [deployment-guide.md](.claude/development/deployment-guide.md) | Edge function deploy commands, CORS, website, monitoring & alerts |
| [claude-flow-guide.md](.claude/development/claude-flow-guide.md) | Agent types, swarm examples, hive mind, SPARC modes |
| [cloudinary-guide.md](.claude/development/cloudinary-guide.md) | Blog image upload workflow, URL transforms, folder conventions |
| [subagent-tool-permissions-guide.md](.claude/development/subagent-tool-permissions-guide.md) | Subagent tool access by type, foreground/background behavior, skill author checklist |
| [edge-function-patterns.md](.claude/development/edge-function-patterns.md) | Deno edge function patterns, shared utilities, request handling |
| [stripe-testing.md](.claude/development/stripe-testing.md) | Stripe test mode, webhook testing, fixture data |
| [stripe-troubleshooting.md](.claude/development/stripe-troubleshooting.md) | Common Stripe integration issues and fixes |
| [stripe-billing-portal.md](.claude/development/stripe-billing-portal.md) | Customer portal setup, subscription management |
| [benchmarks.md](.claude/development/benchmarks.md) | Performance benchmarking suite, search/index benchmarks |
| [neural-testing.md](.claude/development/neural-testing.md) | Neural pattern testing, embedding service tests |
| [mcp-registry.md](.claude/development/mcp-registry.md) | MCP registry publishing, server.json sync, version requirements |

---

## Docker-First Development

**All code execution MUST happen in Docker.** Native modules require glibc. See [ADR-002](docs/internal/adr/002-docker-glibc-requirement.md).

```bash
docker compose --profile dev up -d                    # Start container (REQUIRED first)
docker exec skillsmith-dev-1 npm run build             # Build
docker exec skillsmith-dev-1 npm test                  # Test
docker exec skillsmith-dev-1 npm run lint              # Lint
docker exec skillsmith-dev-1 npm run typecheck         # Typecheck
docker exec skillsmith-dev-1 npm run audit:standards   # Standards audit
docker exec skillsmith-dev-1 npm run preflight         # All checks before push
```

**After pulling changes**: The `post-merge` hook auto-runs `npm install` in Docker when `package-lock.json` changes. If the container is not running, start it and run `docker exec skillsmith-dev-1 npm install && docker exec skillsmith-dev-1 npm run build`.

**Full rebuild** (native module issues, major upgrades): See [docker-guide.md](.claude/development/docker-guide.md#full-rebuild-thorough).

**Container management**: `docker compose --profile dev down` (stop), `docker logs skillsmith-dev-1` (logs).

**Submodule**: Run `git submodule update --init` before `docker compose up` if internal docs are needed inside the container. Internal docs are not available inside Docker by default.

---

## CI Health Requirements

| Category | Requirement |
|----------|-------------|
| ESLint | Zero warnings, zero errors |
| TypeScript | Strict mode, no unjustified `any` |
| Prettier | All files formatted |
| Tests | 100% pass rate |
| Security | No high-severity vulnerabilities |
| File size | < 500 lines per file |
| Test coverage | > 80% |

**When CI fails**: Don't merge. Check logs. Run `docker exec skillsmith-dev-1 npm run preflight` locally. Create Linear issue if non-trivial.

**Change tiers**: `docs` (~30s), `config` (validation), `code` (~11 min full), `deps` (rebuild + audit). Mixed commits trigger full CI. Details: [ci-reference.md](.claude/development/ci-reference.md).

**Build**: Uses Turborepo (`npm run build`). Legacy fallback: `npm run build:legacy`. See [ADR-106](docs/internal/adr/106-turborepo-build-orchestration.md).

**Branch protection**: 11 required checks for code PRs, 2 for docs-only. Admin bypass for emergencies. Details: [ci-reference.md](.claude/development/ci-reference.md#branch-protection).

---

## Project Overview

Skillsmith is an MCP server for Claude Code skill discovery, installation, and management.

**Runtime**: Node >=22.0.0, npm 11.9.0. Version pinned in `.nvmrc` (22) and `package.json` engines.

```text
packages/
├── core/              # @skillsmith/core (0.4.10) - Database, repositories, services, security
├── mcp-server/        # @skillsmith/mcp-server (0.4.0) - MCP tools (search, install, etc.)
├── cli/               # @skillsmith/cli (0.3.8) - Command-line interface (skillsmith, sklx)
├── enterprise/        # @smith-horn/enterprise (0.1.2) - SSO, RBAC, audit streaming (private)
├── website/           # @skillsmith/website (0.1.0) - Astro site (skillsmith.app)
└── vscode-extension/  # @skillsmith/vscode-extension (0.1.2) - VS Code integration
apps/
└── api-proxy/         # @skillsmith/api-proxy (1.0.0) - Vercel proxy to Supabase Edge Functions
```

**License**: [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) — See [ADR-013](docs/internal/adr/013-open-core-licensing.md)

| Tier | Price | API Calls/Month |
|------|-------|-----------------|
| Community | Free | 1,000 |
| Individual | $9.99/mo | 10,000 |
| Team | $25/user/mo | 100,000 |
| Enterprise | $55/user/mo | Unlimited |

**Quick Start** — Add to `~/.claude/settings.json`:

```json
{ "mcpServers": { "skillsmith": { "command": "npx", "args": ["-y", "@skillsmith/mcp-server"] } } }
```

---

## Git-Crypt (Narrowed Scope)

**Only `.claude/skills/`, `.claude/plans/`, `.claude/hive-mind/`, `supabase/functions/`, and `supabase/migrations/` are encrypted.** Internal docs are in a private submodule at `docs/internal/`.

```bash
git-crypt status | head -10                           # Check encryption scope
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'  # Unlock
git submodule update --init                           # Init internal docs (authorized users only)
```

**Not encrypted** (always readable): `.claude/settings.json`, `supabase/config.toml`, `.claude/development/`, `.claude/templates/`.

**Worktrees**: Unlock main repo first, then `./scripts/create-worktree.sh`. Remove with `./scripts/remove-worktree.sh --prune`.

**Rebasing**: `git pull --rebase` may fail due to smudge filter on remaining encrypted paths. Use `git format-patch` workaround.

**Full guide**: [git-crypt-guide.md](.claude/development/git-crypt-guide.md)

---

## Branch Management (SMI-2536)

Git-crypt smudge filters can silently switch branches during stash/pop operations (including lint-staged in pre-commit hooks). The pre-commit hook detects and aborts if this happens, but follow this protocol as defense-in-depth:

1. **Before first edit**: `git branch --show-current` — confirm you're on the feature branch
2. **After `git commit`**: `git branch --show-current` — verify the commit landed correctly
3. **After `git stash pop`**: `git branch --show-current` — stash pop is the most common trigger
4. **After `git checkout`**: `git branch --show-current` — checkout can report false success

**If branch switched during commit**, the post-commit hook prints recovery commands:

```bash
git checkout <expected-branch>
git cherry-pick <commit-hash>
```

**Syncing main**: Use the quiet wrapper to avoid ~5,000 tokens of git-crypt noise:

```bash
./scripts/sync-main.sh                              # Quiet sync (~75 tokens output)
git checkout -b <branch-name>                        # Then create feature branch
```

**Risk-first wave ordering (SMI-2596)**: Waves with database migrations or production behavior changes execute first, regardless of implementation readiness. If deviating from risk order, document the rationale explicitly in the wave plan.

**Wave branch stacking (SMI-2597)**: When multiple waves modify overlapping files, branch sequentially (Wave N+1 from Wave N's branch) instead of all from main. This prevents merge conflicts from squash-merges. Tradeoff: earlier waves must merge before later waves can start CI.

**Direct-to-main commits (SMI-2598)**: Only allowed for SQL-only fixes to migrations already deployed to staging (not production). Must run `supabase db lint` locally first and include Linear issue ref in commit message.

---

## Varlock Security

**All secrets via Varlock. Never expose API keys in terminal output.**

| File | Commit? |
|------|---------|
| `.env.schema` | Yes (defines `@sensitive` annotations) |
| `.env.example` | Yes (placeholder values) |
| `.env` | Never |

```bash
varlock load                    # Validate (masked output)
varlock run -- npm test         # Run with secrets injected
```

**Never** `echo $SECRET` or `cat .env`. Never ask users to paste secrets in chat. See [AI Agent Secret Handling](docs/internal/architecture/standards-security.md#411-ai-agent-secret-handling-smi-1956).

---

## Test File Locations (SMI-1780)

Vitest only runs tests matching these patterns. Tests elsewhere are **silently ignored**.

| Pattern | Example |
|---------|---------|
| `packages/*/src/**/*.test.ts` | `packages/core/src/foo.test.ts` |
| `packages/*/src/**/*.spec.ts` | `packages/mcp-server/src/bar.spec.ts` |
| `packages/*/tests/**/*.test.ts` | `packages/core/tests/unit/foo.test.ts` |
| `packages/*/tests/**/*.spec.ts` | `packages/enterprise/tests/integration/bar.spec.ts` |
| `tests/**/*.test.ts` | `tests/unit/utils.test.ts` |
| `supabase/functions/**/*.test.ts` | `supabase/functions/indexer/index.test.ts` |
| `scripts/tests/**/*.test.ts` | `scripts/tests/validate-skills.test.ts` |

**Common mistakes**: `scripts/__tests__/` (use `scripts/tests/`), `packages/core/test/` (use `tests/` plural), `src/foo.test.ts` (must be inside a package). Reference: `vitest.config.ts`.

---

## Skillsmith MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Search skills (query, category, trust_tier, min_score, limit) |
| `get_skill` | Get skill details by `author/name` ID |
| `install_skill` | Install skill to `~/.claude/skills` with security scan and conflict resolution |
| `uninstall_skill` | Remove installed skill |
| `recommend` | Contextual skill recommendations based on codebase analysis |
| `validate` | Validate skill structure (SKILL.md frontmatter, content) |
| `compare` | Compare 2-5 skills side-by-side (quality, trust, features, scores) |
| `analyze` | Analyze codebase for framework detection, dependencies, skill recommendations |
| `index_local` | Index local skills from `~/.claude/skills` and `./.claude/skills` |
| `publish` | Publish a skill to the Skillsmith registry with preflight checks |

**Auth**: Personal API Key (`X-API-Key: sk_live_*`, tier-based), Supabase Anon Key (30/min), No Auth (10 trial). Configure in `~/.skillsmith/config.json` or `SKILLSMITH_API_KEY` env in Claude settings. Shell exports don't reach MCP subprocesses.

**Trust tiers**: verified (official), curated (third-party publishers), community (reviewed), experimental (new/beta), unknown (unvetted), local (user's own, client-only — not stored in DB).

**CLI**: `skillsmith` or `sklx` — `author subagent/transform/mcp-init`, `sync/status/config`, `list/update/remove`. See [ADR-018](docs/internal/adr/018-registry-sync-system.md).

---

## Core Architecture (`@skillsmith/core`)

The core package contains 25+ subsystems. Key modules for development:

| Module | Purpose | Key Classes/Functions |
|--------|---------|----------------------|
| `db/` | SQLite with WASM fallback, schema migrations (v1-v4) | `createDatabase()`, `openDatabase()`, `runMigrations()` |
| `repositories/` | CRUD layer (prepared statements, WAL mode) | `SkillRepository`, `IndexerRepository`, `CacheRepository`, `QuarantineRepository` |
| `services/` | Business logic | `SearchService` (FTS5+BM25), `TransformationService`, `QuarantineService` |
| `security/` | Scanner, audit logger, rate limiter, E2B sandbox | `SecurityScanner`, `AuditLogger`, `RateLimiter`, `SkillSandbox` |
| `sync/` | Registry sync engine (differential) | `SyncEngine`, `BackgroundSyncService` |
| `webhooks/` | GitHub webhook ingestion, HMAC-SHA256 verification | `WebhookHandler`, `WebhookQueue` |
| `indexer/` | Skill parsing and indexing | `SkillParser`, `GitHubIndexer`, `SwarmIndexer` |
| `embeddings/` | Semantic embeddings (ONNX all-MiniLM-L6-v2, HNSW) | `EmbeddingService` |
| `search/` | Hybrid search (FTS5 + semantic) | `HybridSearch` |
| `cache/` | L1 (LRU in-memory) + L2 (SQLite TTL) tiered caching | `TieredCache`, `CacheManager` |
| `api/` | Skillsmith registry API client with retry/cache | `SkillsmithApiClient` |
| `billing/` | Stripe integration, subscriptions, GDPR compliance | `BillingService`, `StripeWebhookHandler` |
| `telemetry/` | OpenTelemetry tracing + PostHog analytics | `SkillsmithTracer`, `MetricsRegistry` |
| `session/` | Session lifecycle with recovery and health monitoring | `SessionManager`, `SessionRecovery` |
| `analysis/` | Codebase analysis (TypeScript/JS, framework detection) | `CodebaseAnalyzer` |
| `matching/` | Skill recommendation and overlap detection | `SkillMatcher`, `OverlapDetector` |
| `scoring/` | Quality scoring (docs 25%, impl 25%, examples 20%, maint 15%, fresh 15%) | `QualityScorer` |
| `routing/` | SONA routing for MCP tool optimization | `SONARouter` |
| `validation/` | SSRF prevention, path traversal, input sanitization | `validateUrl()`, `validatePath()` |

**Database schema**: 4 migrations. Tables: `skills`, `skills_fts` (FTS5 virtual), `sources`, `categories`, `skill_categories`, `cache`, `audit_logs`, `sync_config`, `sync_history`, `quarantine`. Indexes on author, trust_tier, quality_score, risk_score, security_passed.

---

## Supabase Edge Functions

| Function | Auth | `--no-verify-jwt` |
|----------|------|--------------------|
| `early-access-signup`, `contact-submit`, `stats`, `checkout`, `stripe-webhook`, `events` | Anonymous | Yes |
| `skills-search`, `skills-get`, `skills-recommend` | API Key | Yes |
| `health` | Anonymous (health check) | Yes |
| `email-inbound` | Anonymous (Resend webhook) | Yes |
| `generate-license`, `regenerate-license`, `create-portal-session`, `list-invoices` | Authenticated (internal JWT) | Yes |
| `update-seat-count` | Authenticated | No |
| `indexer`, `skills-refresh-metadata`, `ops-report`, `alert-notify` | Service Role | No |

**Adding anonymous functions** (CI validates): Add to `supabase/config.toml` with `verify_jwt = false`, add to `NO_VERIFY_JWT_FUNCTIONS` in `scripts/audit-standards.mjs`, and add deploy command below.

**Deploy commands** (`--no-verify-jwt` required — CI scans CLAUDE.md for these):

```bash
npx supabase functions deploy early-access-signup --no-verify-jwt
npx supabase functions deploy contact-submit --no-verify-jwt
npx supabase functions deploy stats --no-verify-jwt
npx supabase functions deploy skills-search --no-verify-jwt
npx supabase functions deploy skills-get --no-verify-jwt
npx supabase functions deploy skills-recommend --no-verify-jwt
npx supabase functions deploy stripe-webhook --no-verify-jwt
npx supabase functions deploy checkout --no-verify-jwt
npx supabase functions deploy events --no-verify-jwt
npx supabase functions deploy health --no-verify-jwt
npx supabase functions deploy email-inbound --no-verify-jwt
npx supabase functions deploy generate-license --no-verify-jwt
npx supabase functions deploy regenerate-license --no-verify-jwt
npx supabase functions deploy create-portal-session --no-verify-jwt
npx supabase functions deploy list-invoices --no-verify-jwt
```

**CORS & monitoring details**: [deployment-guide.md](.claude/development/deployment-guide.md)

---

## GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push/PR to main | Full CI: Docker build, change classification, lint, typecheck, test, coverage |
| `docs-only.yml` | PR (docs changes) | Fast path (~30s) for documentation-only PRs |
| `e2e-tests.yml` | Manual/scheduled | End-to-end tests for CLI and MCP server |
| `packaging-test.yml` | PR | Package publishing validation (dry-run) |
| `publish.yml` | Release tag | Publish packages to npm/GitHub Packages |
| `website-deploy-staging.yml` | Push to main | Staging deployment via Vercel |
| `codeql.yml` | Push/PR/schedule | CodeQL security analysis |
| `security-scan.yml` | Push/PR | Security scanning (npm audit, gitleaks) |
| `weekly-security-scan.yml` | Weekly | Comprehensive weekly security scan |
| `batch-transform.yml` | Manual | Batch skill transformation |
| `user-growth-report.yml` | Monday 9 AM UTC | User growth metrics |
| `indexer.yml` | Daily 2 AM UTC | Skill indexer |
| `refresh-metadata.yml` | Hourly :30 | Metadata refresh |
| `ops-report.yml` | Monday 9 AM UTC | Operations report |
| `analytics-report.yml` | Monday 9 AM UTC | Weekly analytics |
| `billing-monitor.yml` | Monday 9 AM UTC | Billing monitor |
| `ab-results.yml` | Monday 9 AM UTC | A/B experiment results — creates issue with verdict |

---

## Monitoring & Alerts

| Job | Schedule | Function |
|-----|----------|----------|
| Skill Indexer | Daily 2 AM UTC | `indexer` |
| Metadata Refresh | Hourly :30 | `skills-refresh-metadata` |
| Ops Report | Monday 9 AM UTC | `ops-report` |
| Weekly Analytics | Monday 9 AM UTC | GitHub Actions (`analytics-report.yml`) |
| Billing Monitor | Monday 9 AM UTC | GitHub Actions (`billing-monitor.yml`) |
| User Growth Report | Monday 9 AM UTC | GitHub Actions (`user-growth-report.yml`) |
| A/B Experiment Results | Monday 9 AM UTC | GitHub Actions (`ab-results.yml`) — creates issue with verdict |

Alerts to `support@smithhorn.ca` via Resend on failures. All jobs log to `audit_logs` table. Manual trigger & audit log details: [deployment-guide.md](.claude/development/deployment-guide.md#monitoring--alerts).

---

## MCP Server Configuration (`.mcp.json`)

Two MCP servers are auto-configured for local development via `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-flow": {
      "command": "npx",
      "args": ["claude-flow@alpha", "mcp", "start"],
      "env": { "CLAUDE_FLOW_LOG_LEVEL": "info", "CLAUDE_FLOW_MEMORY_BACKEND": "sqlite" }
    },
    "skillsmith": {
      "command": "node",
      "args": ["./packages/mcp-server/dist/src/index.js"]
    }
  }
}
```

**Claude-Flow** is required for hive mind and agent spawning. Manual: `claude mcp add claude-flow -- npx claude-flow@alpha mcp start`.

**Tools**: `swarm_init`, `agent_spawn`, `task_orchestrate`, `memory_usage`, `swarm_destroy`.

**Agent types**: architect, coder, tester, reviewer, researcher.

**Full guide**: [claude-flow-guide.md](.claude/development/claude-flow-guide.md)

---

## MCP Registry

Published as `io.github.smith-horn/skillsmith` on [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/). Auto-published via CI. **Version sync required**: update both `packages/mcp-server/package.json` and `packages/mcp-server/server.json`. Full guide: [mcp-registry.md](.claude/development/mcp-registry.md).

---

## Skills & Embedding

**Project skills** (`.claude/skills/`, 35+ skills): Key skills include [governance](.claude/skills/governance/SKILL.md) (standards enforcement), [worktree-manager](.claude/skills/worktree-manager/SKILL.md) (parallel development), [plan-review-skill](.claude/skills/plan-review-skill/SKILL.md) (VP-trio plan review), [skill-builder](.claude/skills/skill-builder/SKILL.md) (create new skills). Also includes domain-specific skills for GitHub workflows, hive mind, swarm orchestration, SPARC methodology, AgentDB, and Flow Nexus.

**Agent definitions** (`.claude/agents/`, 21 types): architecture, coder, tester, reviewer, researcher, consensus, data, devops, documentation, flow-nexus, github, goal, hive-mind, neural, optimization, reasoning, sparc, specialized, swarm, templates, testing.

**User skills** (`~/.claude/skills/`): linear, mcp-decision-helper, flaky-test-detector, version-sync, ci-doctor, docker-optimizer, security-auditor, session-cleanup (end-of-session housekeeping — `/session-cleanup`).

**Embedding**: Real ONNX all-MiniLM-L6-v2 (~50ms) with HNSW approximate nearest neighbor, or mock (<1ms, `SKILLSMITH_USE_MOCK_EMBEDDINGS=true`). WASM fallback when native onnxruntime unavailable. See [ADR-009](docs/internal/adr/009-embedding-service-fallback.md). Auto-update check: `SKILLSMITH_AUTO_UPDATE_CHECK=false` to disable.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Container won't start | `docker compose --profile dev down && docker volume rm skillsmith_node_modules && docker compose --profile dev up -d` |
| Native module errors | `docker exec skillsmith-dev-1 npm rebuild better-sqlite3 onnxruntime-node` |
| Platform mismatch (SIGKILL 137) | `rm -rf packages/*/node_modules/better-sqlite3 packages/*/node_modules/onnxruntime-node` then rebuild |
| Node ABI mismatch (after Node upgrade) | WASM fallback auto-activates since core 0.4.10. To restore native: `docker exec skillsmith-dev-1 npm rebuild better-sqlite3` |
| Docker DNS failure | `docker network prune -f` then restart container |
| Stale CJS artifacts | `docker exec skillsmith-dev-1 bash -c 'find /app/packages -path "*/src/*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -type f -delete'` |
| Orphaned agents | `./scripts/cleanup-orphans.sh` (`--dry-run` to preview) |

**Detailed diagnostics** (Symptoms / Root Cause / Fix): [docker-guide.md](.claude/development/docker-guide.md#troubleshooting)

---

## Key npm Scripts

Beyond `build`/`test`/`lint` (documented above), these scripts are frequently used:

| Script | Purpose |
|--------|---------|
| `npm run preflight` | Full pre-push validation (lint, typecheck, test, coverage, standards) |
| `npm run ci:quick` | Fast local CI check (cached lint + typecheck + test) |
| `npm run audit:standards` | Audit against engineering standards |
| `npm run validate:skills` | Validate local skill files |
| `npm run validate:anon-functions` | Validate anonymous edge function config |
| `npm run validate:versions` | Check package version consistency |
| `npm run test:e2e` | End-to-end tests (CLI + MCP) |
| `npm run test:coverage` | Test with coverage report |
| `npm run benchmark` | Performance benchmarks (search, index) |
| `npm run seed` | Seed database with test skills |
| `npm run seed:clear` | Clear seeded data |
| `npm run sync:push` / `sync:pull` | Sync local DB with Supabase (add `--dry-run` variants) |
| `npm run linear:done` | Mark Linear issue done from commit |
| `npm run linear:sync` | Sync Linear state from commit messages |
| `npm run transform:batch` | Batch transform skills (decompose, optimize) |
| `npm run skillsmith` | Run CLI from source (`node packages/cli/dist/src/index.js`) |

---

## Pre-Commit & Pre-Push Hooks

**Pre-commit** (5 phases):
1. Gitleaks secret detection
2. TypeScript build cache clearing (optional: `FULL_TYPECHECK=1`)
3. TypeScript type checking (per-package or full)
4. lint-staged: two-phase ESLint (`--fix` then `--max-warnings=0`) + Prettier
5. SMI-2536: Branch integrity guard (detects git-crypt branch switches)

**Post-commit**: Branch integrity fallback + Linear issue sync (background).

**Post-merge**: Auto `npm install` in Docker when `package-lock.json` changes.

**Pre-push** (5 phases):
1. Uncommitted changes detection (SMI-1342)
2. Security checks: security tests, npm audit, secrets pattern scan (SMI-727)
3. Format check with Prettier (SMI-1835)
4. Coverage validation (SMI-1602)
5. Linear issue sync in batch mode (SMI-2633)

**Pre-rebase**: Warns about unmerged feature branches to prevent accidental loss of work.

---

## Key References

| Category | Documents |
|----------|-----------|
| Architecture | [System Overview](docs/internal/architecture/system-design/system-overview.md), [Skill Dependencies](docs/internal/architecture/system-design/skill-dependencies.md), [Index](docs/internal/architecture/index.md) |
| Standards | [Engineering](docs/internal/architecture/standards.md), [Database](docs/internal/architecture/standards-database.md), [Astro](docs/internal/architecture/standards-astro.md), [Security](docs/internal/architecture/standards-security.md) |
| Process | [Context Compaction](docs/internal/process/context-compaction.md), [Linear Hygiene](docs/internal/process/linear-hygiene-guide.md), [Wave Checklist](docs/internal/process/wave-completion-checklist.md) |
| Development | [Docker](.claude/development/docker-guide.md), [Git-Crypt](.claude/development/git-crypt-guide.md), [CI](.claude/development/ci-reference.md), [Deploy](.claude/development/deployment-guide.md), [Claude-Flow](.claude/development/claude-flow-guide.md) |
| Testing | [Stripe](.claude/development/stripe-testing.md), [Neural](.claude/development/neural-testing.md), [Benchmarks](.claude/development/benchmarks.md) |
| Billing | [Stripe Testing](.claude/development/stripe-testing.md), [Billing Portal](.claude/development/stripe-billing-portal.md), [Troubleshooting](.claude/development/stripe-troubleshooting.md) |
| Edge Functions | [Patterns](.claude/development/edge-function-patterns.md), [Deploy](.claude/development/deployment-guide.md) |
| Research | [Version Control for Agent Skills](docs/research/version-control-agent-skills.md) |
| Website | [skillsmith.app/docs](https://skillsmith.app/docs) — Deploy: `cd packages/website && vercel --prod` |

**Linear**: Initiative Skillsmith (SMI-xxx). Authoritative standards: `docs/internal/architecture/standards.md`.

---

## Infrastructure Change Policy (ADR-109)

Changes to Docker, CI, entrypoints, hooks, or dev tooling scripts **require SPARC + plan-review before implementation**. Use `/launchpad --infra` (auto-detected) or run SPARC research manually → `docs/internal/implementation/{slug}.md` → plan-review skill → implement.

Trigger paths: `docker-entrypoint.sh`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/`, `.husky/`, `scripts/` (CI/hook files), `vitest.config.ts`, `turbo.json`, `lint-staged.config.js`.

Application code (`packages/*/src/**`) and docs do not require this. See [ADR-109](docs/internal/adr/109-sparc-plan-review-for-infra-changes.md).

---

## Important Instruction Reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.
NEVER defer fixes to "later" or "a future pass". If a code review or audit surfaces an issue in scope, fix it immediately in the same PR. Do not label findings as "informational" or "non-blocking" if they can be resolved now.
