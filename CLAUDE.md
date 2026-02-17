# Claude Code Configuration - Skillsmith

## Sub-Documentation

Detailed guides extracted via progressive disclosure. CLAUDE.md contains essentials; sub-docs contain deep dives.

| Document | Description |
|----------|-------------|
| [docker-guide.md](docs/development/docker-guide.md) | Container rebuild scenarios, DNS failure, native modules, troubleshooting |
| [git-crypt-guide.md](docs/development/git-crypt-guide.md) | Unlock, worktree setup, rebase workaround, smudge filter fixes |
| [ci-reference.md](docs/development/ci-reference.md) | Branch protection, change classification, Turborepo, CI scripts |
| [deployment-guide.md](docs/development/deployment-guide.md) | Edge function deploy commands, CORS, website, monitoring & alerts |
| [claude-flow-guide.md](docs/development/claude-flow-guide.md) | Agent types, swarm examples, hive mind, SPARC modes |
| [cloudinary-guide.md](docs/development/cloudinary-guide.md) | Blog image upload workflow, URL transforms, folder conventions |

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

**Full rebuild** (native module issues, major upgrades): See [docker-guide.md](docs/development/docker-guide.md#full-rebuild-thorough).

**Container management**: `docker compose --profile dev down` (stop), `docker logs skillsmith-dev-1` (logs).

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

**Change tiers**: `docs` (~30s), `config` (validation), `code` (~11 min full), `deps` (rebuild + audit). Mixed commits trigger full CI. Details: [ci-reference.md](docs/development/ci-reference.md).

**Build**: Uses Turborepo (`npm run build`). Legacy fallback: `npm run build:legacy`. See [ADR-106](docs/internal/adr/106-turborepo-build-orchestration.md).

**Branch protection**: 11 required checks for code PRs, 2 for docs-only. Admin bypass for emergencies. Details: [ci-reference.md](docs/development/ci-reference.md#branch-protection).

---

## Project Overview

Skillsmith is an MCP server for Claude Code skill discovery, installation, and management.

```text
packages/
├── core/        # @skillsmith/core - Database, repositories, services
├── mcp-server/  # @skillsmith/mcp-server - MCP tools (search, install, etc.)
└── cli/         # @skillsmith/cli - Command-line interface
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

**Not encrypted** (always readable): `.claude/settings.json`, `supabase/config.toml`, all `docs/development/`, `docs/templates/`.

**Worktrees**: Unlock main repo first, then `./scripts/create-worktree.sh`. Remove with `./scripts/remove-worktree.sh --prune`.

**Rebasing**: `git pull --rebase` may fail due to smudge filter on remaining encrypted paths. Use `git format-patch` workaround.

**Full guide**: [git-crypt-guide.md](docs/development/git-crypt-guide.md)

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
| `install_skill` | Install skill to `~/.claude/skills` |
| `uninstall_skill` | Remove installed skill |
| `recommend` | Contextual skill recommendations |
| `validate` | Validate skill structure |
| `compare` | Compare 2-5 skills side-by-side |

**Auth**: Personal API Key (`X-API-Key: sk_live_*`, tier-based), Supabase Anon Key (30/min), No Auth (10 trial). Configure in `~/.skillsmith/config.json` or `SKILLSMITH_API_KEY` env in Claude settings. Shell exports don't reach MCP subprocesses.

**Trust tiers**: verified (official), community (reviewed), experimental (new/beta).

**CLI**: `skillsmith` or `sklx` — `author subagent/transform/mcp-init`, `sync/status/config`. See [ADR-018](docs/internal/adr/018-registry-sync-system.md).

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

**CORS & monitoring details**: [deployment-guide.md](docs/development/deployment-guide.md)

---

## Monitoring & Alerts

| Job | Schedule | Function |
|-----|----------|----------|
| Skill Indexer | Daily 2 AM UTC | `indexer` |
| Metadata Refresh | Hourly :30 | `skills-refresh-metadata` |
| Ops Report | Monday 9 AM UTC | `ops-report` |
| Weekly Analytics | Monday 9 AM UTC | GitHub Actions (`analytics-report.yml`) |
| Billing Monitor | Monday 9 AM UTC | GitHub Actions |

Alerts to `support@smithhorn.ca` via Resend on failures. All jobs log to `audit_logs` table. Manual trigger & audit log details: [deployment-guide.md](docs/development/deployment-guide.md#monitoring--alerts).

---

## Claude-Flow MCP Server

Required for hive mind and agent spawning. Auto-configured via `.mcp.json`. Manual: `claude mcp add claude-flow -- npx claude-flow@alpha mcp start`.

**Tools**: `swarm_init`, `agent_spawn`, `task_orchestrate`, `memory_usage`, `swarm_destroy`.

**Agent types**: architect, coder, tester, reviewer, researcher.

**Full guide**: [claude-flow-guide.md](docs/development/claude-flow-guide.md)

---

## MCP Registry

Published as `io.github.smith-horn/skillsmith` on [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/). Auto-published via CI. **Version sync required**: update both `packages/mcp-server/package.json` and `packages/mcp-server/server.json`. Full guide: [mcp-registry.md](docs/development/mcp-registry.md).

---

## Skills & Embedding

**Project skills** (`.claude/skills/`): [governance](.claude/skills/governance/SKILL.md) (standards enforcement), [worktree-manager](.claude/skills/worktree-manager/SKILL.md) (parallel development).

**User skills** (`~/.claude/skills/`): linear, mcp-decision-helper, flaky-test-detector, version-sync, ci-doctor, docker-optimizer, security-auditor.

**Embedding**: Real ONNX (~50ms) or mock (<1ms, `SKILLSMITH_USE_MOCK_EMBEDDINGS=true`). See [ADR-009](docs/internal/adr/009-embedding-service-fallback.md). Auto-update check: `SKILLSMITH_AUTO_UPDATE_CHECK=false` to disable.

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

**Detailed diagnostics** (Symptoms / Root Cause / Fix): [docker-guide.md](docs/development/docker-guide.md#troubleshooting)

---

## Key References

| Category | Documents |
|----------|-----------|
| Architecture | [System Overview](docs/internal/architecture/system-design/system-overview.md), [Skill Dependencies](docs/internal/architecture/system-design/skill-dependencies.md), [Index](docs/internal/architecture/index.md) |
| Standards | [Engineering](docs/internal/architecture/standards.md), [Database](docs/internal/architecture/standards-database.md), [Astro](docs/internal/architecture/standards-astro.md), [Security](docs/internal/architecture/standards-security.md) |
| Process | [Context Compaction](docs/internal/process/context-compaction.md), [Linear Hygiene](docs/internal/process/linear-hygiene-guide.md), [Wave Checklist](docs/internal/process/wave-completion-checklist.md) |
| Development | [Docker](docs/development/docker-guide.md), [Git-Crypt](docs/development/git-crypt-guide.md), [CI](docs/development/ci-reference.md), [Deploy](docs/development/deployment-guide.md), [Claude-Flow](docs/development/claude-flow-guide.md) |
| Testing | [Stripe](docs/development/stripe-testing.md), [Neural](docs/development/neural-testing.md), [Benchmarks](docs/development/benchmarks.md) |
| Website | [skillsmith.app/docs](https://skillsmith.app/docs) — Deploy: `cd packages/website && vercel --prod` |

**Linear**: Initiative Skillsmith (SMI-xxx). Authoritative standards: `docs/internal/architecture/standards.md`.

---

## Important Instruction Reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.
NEVER defer fixes to "later" or "a future pass". If a code review or audit surfaces an issue in scope, fix it immediately in the same PR. Do not label findings as "informational" or "non-blocking" if they can be resolved now.
