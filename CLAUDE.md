# Claude Code Configuration - Skillsmith

## Sub-Documentation

Detailed guides extracted via progressive disclosure. CLAUDE.md contains essentials; sub-docs contain deep dives.

| Document | Description |
|----------|-------------|
| [docker-guide.md](.claude/development/docker-guide.md) | Container rebuild scenarios, DNS failure, native modules, troubleshooting |
| [git-crypt-guide.md](.claude/development/git-crypt-guide.md) | Unlock, worktree setup, hooks-in-worktrees, Docker bind-mounts (SMI-4689/4738), pre-push (SMI-4767), rebase workaround, smudge filter fixes |
| [ci-reference.md](.claude/development/ci-reference.md) | Branch protection, change classification, Turborepo, npm overrides, release-PR carve-out, vitest split rationale |
| [deployment-guide.md](.claude/development/deployment-guide.md) | Edge function deploy, CORS, website, full monitoring & alerts table |
| [branch-management.md](.claude/development/branch-management.md) | Pre-commit auto-restore prose, post-commit fallback recovery, direct-to-main SQL rule (SMI-2598) |
| [edge-function-patterns.md](.claude/development/edge-function-patterns.md) | Function-auth matrix, project refs, auto-deploy mechanics |
| [mcp-tools-guide.md](.claude/development/mcp-tools-guide.md) | Team-tool resolution chain (SMI-4312/ADR-116), CLI surface (SMI-4590) |
| [publishing-guide.md](.claude/development/publishing-guide.md) | Local-fallback deprecation (SMI-4533), publish-order rationale, version-pin rules |
| [claude-flow-guide.md](.claude/development/claude-flow-guide.md) | Ruflo (formerly claude-flow) — agent types, swarm examples, hive mind, SPARC modes |
| [cloudinary-guide.md](.claude/development/cloudinary-guide.md) | Blog image upload workflow, URL transforms, folder conventions |
| [vscode-publishing-guide.md](.claude/development/vscode-publishing-guide.md) | VS Code Marketplace publishing, local/CI workflow, PAT rotation |
| [subagent-tool-permissions-guide.md](.claude/development/subagent-tool-permissions-guide.md) | Subagent tool access by type, foreground/background behavior, skill author checklist |
| [supabase-migration-safety.md](.claude/development/supabase-migration-safety.md) | Pre/post-apply query catalog, ACCESS EXCLUSIVE locks, rollback, pooler. Invoke via `supabase-migration-reviewer` skill |
| [ruvector-dev-tooling.md](.claude/development/ruvector-dev-tooling.md) | `skillsmith-doc-retrieval` MCP (SMI-4417) — local semantic doc search, post-commit hook, token-delta gate |
| [smoke-prod-guide.md](.claude/development/smoke-prod-guide.md) | Post-deploy smoke harness (SMI-4459) — surface manifest, failure triage, phase rollout |
| [vercel-deploy-hook.md](.claude/development/vercel-deploy-hook.md) | Vercel→GitHub `repository_dispatch` triggering `smoke-prod.yml` post-deploy |
| [e2e-staging-runbook.md](.claude/development/e2e-staging-runbook.md) | `device-login-roundtrip.yml` (SMI-4460) — secret rotation, Docker carve-out, prod-ref grep gate |
| [eval-cron-setup.md](.claude/development/eval-cron-setup.md) | Canonical-dev retrieval-eval cron (SMI-4764 W2) — launchd/systemd, heartbeat, replacement protocol |

**Implementation plan template**: [.claude/templates/implementation-plan.md](.claude/templates/implementation-plan.md) — use this structure for all plans in `docs/internal/implementation/`.

---

## Docker-First Development

**All code execution MUST happen in Docker** for any path that loads native modules (`better-sqlite3`, `onnxruntime-node`, etc.). Native modules require glibc — see [ADR-002](docs/internal/adr/002-docker-glibc-requirement.md), whose scope is narrowly the choice of `node:22-slim` over Alpine, *not* a project-wide mandate that every CI job run in Docker.

**CI carve-out (SMI-4647)**: four pure-JS jobs run on the host runner — `lint`, `typecheck`, `compliance`, `code-review`. New jobs default to Docker; opt-in requires `# audit:carveout-pure-js` marker. Full rationale: [ci-reference.md § Docker-First CI Carve-out](.claude/development/ci-reference.md#docker-first-ci-carve-out-smi-4647).

```bash
docker compose --profile dev up -d                    # Start container (REQUIRED first)
docker exec skillsmith-dev-1 npm run build             # Build
docker exec skillsmith-dev-1 npm test                  # Test
docker exec skillsmith-dev-1 npm run lint              # Lint
docker exec skillsmith-dev-1 npm run typecheck         # Typecheck
docker exec skillsmith-dev-1 npm run audit:standards   # Standards audit
docker exec skillsmith-dev-1 npm run preflight         # All checks before push
```

**After pulling**: post-merge hook auto-runs `npm install` in Docker on `package-lock.json` change; if container is down, start it and run `docker exec skillsmith-dev-1 npm install && npm run build`. **Full rebuild** (native modules, major upgrades): [docker-guide.md](.claude/development/docker-guide.md#full-rebuild-thorough). **Stop**: `docker compose --profile dev down`. **Logs**: `docker logs skillsmith-dev-1`. **Submodule**: `git submodule update --init` before `docker compose up` if internal docs needed inside container.

---

## CI Health Requirements

Zero ESLint warnings/errors. TypeScript strict (no unjustified `any`). All files Prettier-formatted. 100% test pass. No high-severity vulns. **<500 lines/file** (`audit:standards` enforces; split into `foo.helpers.ts`/`foo.types.ts` if approaching). >80% coverage. Source-file changes must include related test updates.

**When CI fails**: don't merge. Run `docker exec skillsmith-dev-1 npm run preflight` locally. Linear issue if non-trivial.

**Post-deploy smoke (SMI-4459)**: `smoke-prod.yml` runs `scripts/smoke-prod.sh` against prod after each merge. Failure → Linear + email. Skip: `[skip-smoke]` in PR body. [smoke-prod-guide.md](.claude/development/smoke-prod-guide.md).

**Build**: Turborepo (`npm run build`); legacy fallback `npm run build:legacy` ([ADR-106](docs/internal/adr/106-turborepo-build-orchestration.md)). **Change tiers**: `docs` ~30s, `config` validation, `code` ~11 min full, `deps` rebuild+audit. **Branch protection**: 13 checks (code) / 2 checks (docs-only). **npm overrides, release-PR carve-out, vitest split rationale**: [ci-reference.md](.claude/development/ci-reference.md).

---

## Project Overview

Skillsmith is an MCP server for Claude Code skill discovery, installation, and management. Packages: `@skillsmith/core` (DB, repositories, services), `@skillsmith/mcp-server` (MCP tools), `@skillsmith/cli`. License: [Elastic 2.0](https://www.elastic.co/licensing/elastic-license) ([ADR-013](docs/internal/adr/013-open-core-licensing.md)). Quick Start: [README](README.md).

| Tier | Price | API Calls/Month |
|------|-------|-----------------|
| Community | Free | 1,000 |
| Individual | $9.99/mo | 10,000 |
| Team | $25/user/mo | 100,000 |
| Enterprise | $55/user/mo | Unlimited |

---

## Git-Crypt (Narrowed Scope)

**Only `supabase/functions/` and `supabase/migrations/` are encrypted via git-crypt.** Strategic IP (`.claude/skills/`, `.claude/plans/`, `.claude/hive-mind/`) lives in the private `smith-horn/skillsmith-strategy` submodule (PAT-based access, parallel to `docs/internal/`). Internal docs are in a private submodule at `docs/internal/`.

```bash
git-crypt status | head -10                           # Check encryption scope
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'  # Unlock
git submodule update --init                           # Init internal docs (authorized users only)
```

**Not encrypted** (always readable): `.claude/settings.json`, `supabase/config.toml`, `.claude/development/`, `.claude/templates/`.

**Worktrees**: Unlock main repo first, then `./scripts/create-worktree.sh`. Remove with `./scripts/remove-worktree.sh --prune`. Hooks-in-worktrees, Docker bind-mounts (SMI-4689/4738), pre-push (SMI-4767), host native bindings (SMI-4549), and SMI-4698 native-rebuild caveat: see [git-crypt-guide.md § Worktree Setup](.claude/development/git-crypt-guide.md#worktree-setup).

**Strategy submodule init**: each of `.claude/skills`, `.claude/plans`, `.claude/hive-mind` is a submodule of `smith-horn/skillsmith-strategy` pinned to its own branch (`branch = skills/plans/hive-mind` in `.gitmodules`). Plain `git submodule update --init` materializes the right content at each mount-point — no sparse-checkout machinery needed (SMI-4829 cutover, shape b′; the prior shape b sparse-checkout approach was abandoned because cone mode cannot strip upstream path prefixes). External contributors without strategy-submodule access see empty mount-points but no hard error (gate #3, SMI-4829).

**Rebasing**: `./scripts/rebase-worktree.sh <worktree-path> [target-branch]` handles git-crypt filter management, submodule cross-fetching, and branch verification. Handles all submodules in `.gitmodules` (post-SMI-4829: `docs/internal` + 3 strategy mounts). Use `--dry-run` to preview. Pass `--allow-submodule-ahead=<path>` for per-submodule advance permission (or unscoped `--allow-submodule-ahead` for global). Manual fallback: [git-crypt-guide.md](.claude/development/git-crypt-guide.md#rebasing-with-git-crypt).

---

## Branch Management (SMI-2536)

Git-crypt smudge filters can silently switch branches during stash/pop (including lint-staged). Defense-in-depth: run `git branch --show-current` before first edit, and after every `commit` / `stash pop` / `checkout` (stash pop is the most common trigger; checkout can report false success). **Pre-commit auto-restore** (SMI-2747) and **post-commit fallback recovery**: [branch-management.md](.claude/development/branch-management.md).

**Syncing main**: `./scripts/sync-main.sh` (quiet, ~75 tokens vs ~5k git-crypt noise). Then `git checkout -b <branch-name>`.

**Risk-first wave ordering (SMI-2596)**: Waves with database migrations or production behavior changes execute first, regardless of implementation readiness. If deviating from risk order, document the rationale explicitly in the wave plan.

**Wave branch stacking (SMI-2597)**: When multiple waves modify overlapping files, branch sequentially (Wave N+1 from Wave N's branch) instead of all from main. This prevents merge conflicts from squash-merges. Tradeoff: earlier waves must merge before later waves can start CI.

**Direct-to-main SQL fixes (SMI-2598)**: see [branch-management.md § Direct-to-Main Commits](.claude/development/branch-management.md#direct-to-main-commits-smi-2598).

---

## Varlock Security

**All secrets via Varlock. Never expose API keys in terminal output.** Commit `.env.schema` (defines `@sensitive`) and `.env.example` (placeholders); **never** `.env`. Run with secrets: `varlock run -- npm test`. Validate: `varlock load` (masked). **Never** `echo $SECRET` or `cat .env`. Never ask users to paste secrets in chat. See [AI Agent Secret Handling](docs/internal/architecture/standards-security.md#411-ai-agent-secret-handling-smi-1956).

**Supabase pooler access**: `SUPABASE_POOLER_URL` has a literal `[YOUR-PASSWORD]` placeholder. Use the canonical helper: `varlock run -- ./scripts/pooler-psql.sh`. Routes through transaction pooler (port 6543), avoiding PostgREST's 8s `statement_timeout`. Requires Docker container running. Full rationale: script header.

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

**Common mistakes**: `scripts/__tests__/` (use `scripts/tests/`), `packages/core/test/` (use `tests/` plural), `src/foo.test.ts` (must be inside a package). Reference: `vitest.config.ts`. Split rationale (SMI-3502/4557): [ci-reference.md § Vitest Split Rationale](.claude/development/ci-reference.md#vitest-split-rationale).

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
| `skill_diff` | Diff two installed skill versions side-by-side |
| `skill_audit` | Audit skill for security advisories (Team+) |
| `skill_inventory_audit` | Audit local `~/.claude/` inventory for namespace collisions; returns rename + edit suggestions (SMI-4590) |
| `apply_namespace_rename` | Apply a rename suggestion from an audit (`apply` / `custom` / `skip`) (SMI-4590) |
| `apply_recommended_edit` | Apply a recommended prose edit; gated on `APPLY_TEMPLATE_REGISTRY` (SMI-4590) |
| `audit_export` | Export audit log events for a time range (Enterprise) |
| `audit_query` | Query audit logs with filters (Enterprise) |
| `siem_export` | Export audit events for SIEM ingestion (Enterprise) |

**Auth**: Personal API Key (`X-API-Key: sk_live_*`, tier-based), Supabase Anon Key (30/min), No Auth (10 trial). Configure in `~/.skillsmith/config.json` or `SKILLSMITH_API_KEY` env. Shell exports don't reach MCP subprocesses. Team-tool resolution chain (SMI-4312/ADR-116), trust tiers, CLI surface: see [mcp-tools-guide.md](.claude/development/mcp-tools-guide.md).

---

## Supabase Edge Functions

**Project refs — do not confuse (SMI-4252 retro 2026-04-17)**:

| Ref | Role | Used for |
|-----|------|----------|
| `vrcnzpmndtroqxxoqkzy` | **Prod** | `.env` `SUPABASE_URL` / `SUPABASE_PROJECT_REF`; all `supabase functions deploy`; `audit_logs` / `v_indexer_health` / `/functions/v1/stats` when validating prod |
| `ovhcifugwqnzoebwfuku` | Staging | Low-cadence — data lags prod; never curl this when verifying a prod deploy |

When verifying a prod edge function via `curl`, always use `$SUPABASE_URL` (under `varlock run --`) or the literal `https://vrcnzpmndtroqxxoqkzy.supabase.co`. Function-auth matrix (21 rows) and auto-deploy mechanics: see [edge-function-patterns.md § Function Auth Matrix](.claude/development/edge-function-patterns.md#function-auth-matrix).

**Adding anonymous functions** (CI validates): add to `supabase/config.toml` with `verify_jwt = false`, to `NO_VERIFY_JWT_FUNCTIONS` in `scripts/audit-standards.mjs`, and to the deploy block below. **Deploy commands** (`--no-verify-jwt` required — CI scans CLAUDE.md for these):

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
npx supabase functions deploy skills-outreach-preferences --no-verify-jwt
npx supabase functions deploy admin-grant-subscription --no-verify-jwt
npx supabase functions deploy advance-notice-email --no-verify-jwt
npx supabase functions deploy auth-device-code --no-verify-jwt
npx supabase functions deploy auth-device-token --no-verify-jwt
npx supabase functions deploy quota-monitor --no-verify-jwt
```

**Gateway-verified auth** (SMI-4291; deploy without `--no-verify-jwt`): `webhook-dlq`, `auth-device-approve`, `auth-device-preview`. **CORS, auto-deploy & monitoring**: [deployment-guide.md](.claude/development/deployment-guide.md), [edge-function-patterns.md § Auto-deploy](.claude/development/edge-function-patterns.md#auto-deploy).

---

## Monitoring & Alerts

High-cadence: Skill Indexer (4× daily 00/06/12/18 UTC, `indexer`), Metadata Refresh (hourly :30, `skills-refresh-metadata`), Quota Monitor (30 min, GHA), Edge Function Deploy (on merge to main, GHA). Full table: [deployment-guide.md § Scheduled Jobs](.claude/development/deployment-guide.md#scheduled-jobs). Alerts to `support@smithhorn.ca` via Resend on failures. All jobs log to `audit_logs` table.

---

## Ruflo MCP Server + MCP Registry

**Ruflo** (hive mind, agent spawning): auto-configured via `.mcp.json`. Tools `mcp__claude-flow__{swarm_init, agent_spawn, task_orchestrate, memory_usage, swarm_destroy}`. Agent types: architect, coder, tester, reviewer, researcher. Full guide: [claude-flow-guide.md](.claude/development/claude-flow-guide.md). **MCP Registry**: `io.github.smith-horn/skillsmith` on [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/), auto-published via CI; sync `packages/mcp-server/{package,server}.json`. Auth: GitHub Actions OIDC (SMI-4534). Full guide: [mcp-registry.md](.claude/development/mcp-registry.md).

---

## Publishing Packages

**Release prep**: `docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --all=patch` (also `--core=minor --cli=patch`, `--dry-run`). **Publish (CI-only)**: `git push && gh workflow run publish.yml -f dry_run=false`. Cadence: weekly (Sun 03:00 UTC) OR `[Unreleased]` ≥ 15 entries ([ADR-114](docs/internal/adr/114-release-cadence-and-gh-release-alignment.md)). Order: core → mcp-server, cli, enterprise. Local fallback deprecated (SMI-4533). Pre-publish checklist, version-pin rules, break-glass: [publishing-guide.md](.claude/development/publishing-guide.md).

---

## VS Code Extension

Published as `skillsmith-vscode` on [Marketplace](https://marketplace.visualstudio.com/items?itemName=skillsmith.skillsmith-vscode). No Docker (ADR-113). Build: `cd packages/vscode-extension && npm run build && npm run package:check`. CI publish, PAT rotation, changelog rules: [vscode-publishing-guide.md](.claude/development/vscode-publishing-guide.md).

---

## Skills & Embedding

Project skills load from the `.claude/skills/` mount-point of the `skillsmith-strategy` submodule. `LocalIndexer.index()` returns `[]` (not throws) when the directory is absent OR present-but-empty (gate #2, SMI-4829). Embedding: real ONNX (~50ms) or mock (`SKILLSMITH_USE_MOCK_EMBEDDINGS=true`); see [ADR-009](docs/internal/adr/009-embedding-service-fallback.md). Disable auto-update: `SKILLSMITH_AUTO_UPDATE_CHECK=false`.

---

## Session Priming (SMI-4451)

`SessionStart` hooks fire on `source=startup` for branches containing an SMI/wave token anywhere in the name (`smi-NNN` or `wave-NNN`; covers `fix/smi-…`, `chore/smi-…`, etc — SMI-4809 broadened the matcher from literal-prefix only). Deny list: `main`, `hotfix-*`, `dependabot/*`, `renovate/*`, `release/*`, `revert/*`. Two hooks: priming (`scripts/session-start-priming.sh`, requires `SKILLSMITH_PROJECT_DIR_ENCODED`, disable via `SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING=1`) + audit (SMI-4590 — Team/Enterprise namespace audit, 24h debounce, fail-soft, tier-gated; disable via `SKILLSMITH_SESSION_AUDIT_DISABLE=1`). Full mechanism: [ruvector-dev-tooling.md § Session Priming](.claude/development/ruvector-dev-tooling.md#session-priming-smi-4451).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Container won't start | `docker compose --profile dev down && docker volume rm skillsmith_node_modules && docker compose --profile dev up -d` |
| Native module errors | `docker exec skillsmith-dev-1 npm rebuild better-sqlite3 onnxruntime-node` |
| Platform mismatch (SIGKILL 137) | `rm -rf packages/*/node_modules/better-sqlite3 packages/*/node_modules/onnxruntime-node` then rebuild |
| Node ABI mismatch | WASM fallback auto-activates (core ≥0.4.10). Restore native: rebuild in Docker + `./scripts/repair-host-native-deps.sh` (SMI-4549) |
| "invalid ELF header" in Docker (SMI-4698) | [git-crypt-guide.md § Host Native Bindings](.claude/development/git-crypt-guide.md#host-native-bindings--sessionstart-instrumentation-smi-4549) |
| Worktree `npm run build` fails (SMI-4689) | SMI-4738 postinstall auto-regenerates override; bounce worktree container. Drift: `./scripts/repair-worktrees.sh` from main repo. macOS only. [Details](.claude/development/git-crypt-guide.md#worktree-docker-bind-mounts-smi-4689) |
| Docker DNS failure | `docker network prune -f` then restart |
| Stale CJS artifacts | `docker exec skillsmith-dev-1 bash -c 'find /app/packages -path "*/src/*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -type f -delete'` |
| Tool missing in `skillsmith-dev-1` (e.g. `psql: executable file not found`) after a Dockerfile change merged on `main` (SMI-4820) | Stale local image — your container predates the Dockerfile commit. `docker compose --profile dev down && docker compose --profile dev build --no-cache dev && docker compose --profile dev up -d`. `--no-cache` ensures the cached `dev` layer doesn't shadow new `RUN apt-get install` lines. |
| Orphaned agents | `./scripts/cleanup-orphans.sh` (`--dry-run` to preview) |
| Symlink outside skills root (SMI-4287) | Set `allowSymlinksOutsideRoot: true` in `LocalFilesystemConfig` to opt in |
| Session-start audit unexpected stderr (SMI-4590) | `export SKILLSMITH_SESSION_AUDIT_DISABLE=1`. Logs: `~/.skillsmith/logs/session-audit-<date>.log` |
| Strategy submodule uninitialized | Empty `.claude/{skills,plans,hive-mind}/` mount-points are expected for external contributors. Skillsmith team members: `git submodule update --init .claude/skills .claude/plans .claude/hive-mind` (each pinned to its own branch in `smith-horn/skillsmith-strategy` per shape b′; no extra setup script). |

**Detailed diagnostics**: [docker-guide.md](.claude/development/docker-guide.md#troubleshooting).

---

## Key References

- **Architecture**: [System Overview](docs/internal/architecture/system-design/system-overview.md), [Skill Dependencies](docs/internal/architecture/system-design/skill-dependencies.md), [Index](docs/internal/architecture/index.md)
- **Standards**: [Engineering](docs/internal/architecture/standards.md), [DB](docs/internal/architecture/standards-database.md), [Astro](docs/internal/architecture/standards-astro.md), [Security](docs/internal/architecture/standards-security.md)
- **Process**: [Context Compaction](docs/internal/process/context-compaction.md), [Linear Hygiene](docs/internal/process/linear-hygiene-guide.md), [Wave Checklist](docs/internal/process/wave-completion-checklist.md)
- **Testing**: [Stripe](.claude/development/stripe-testing.md), [Neural](.claude/development/neural-testing.md), [Benchmarks](.claude/development/benchmarks.md)
- **Billing**: [Admin Grants](docs/internal/runbooks/admin-complimentary-subscriptions.md), [Stripe Ops](docs/internal/runbooks/stripe-operations.md)
- **Website**: [skillsmith.app/docs](https://skillsmith.app/docs); deploy `cd packages/website && vercel --prod`

**Linear**: Skillsmith initiative (SMI-xxx). Authoritative standards: `docs/internal/architecture/standards.md`.

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
NEVER say "worth a note for next time" or "consider X in future". If something is worth noting, act on it immediately: create the Linear issue, update the doc, fix the config. Observations without immediate action are noise.
After context compaction or session continuation, ALWAYS verify claimed-complete work by reading the actual files before proceeding. Never trust the summary alone — compaction can conflate "planned" with "implemented".
After EVERY commit, run `/governance` to review the changed code. Resolve ALL issues it surfaces before pushing. No exceptions — do not skip, defer, or downgrade findings.
After EVERY commit, update the relevant Linear issue(s) in the Skillsmith initiative (SMI-xxx) to reflect progress. Add a comment with the commit SHA and a brief summary of what changed. Move the issue status forward if the commit completes the work (e.g., "In Progress" → "Done"). If no Linear issue exists for the work, create one under the appropriate project before pushing.
After EVERY PR is merged, run `/governance` as a retrospective on the full PR diff. Resolve ALL issues it surfaces immediately — create follow-up commits or Linear issues as needed. Do not close the session until the retro is clean.
After the governance retro, update any `index.md` files in directories where files were added or removed during the PR. Check `docs/internal/`, `.claude/development/`, and `.claude/templates/`. If the root `docs/internal/index.md` folder counts have drifted, update those too.
