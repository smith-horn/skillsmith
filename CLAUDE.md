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
| [claude-flow-guide.md](.claude/development/claude-flow-guide.md) | Ruflo (formerly claude-flow) — agent types, swarm examples, hive mind (SPARC CLI unavailable in v3; see `sparc-methodology` skill) |
| [cloudinary-guide.md](.claude/development/cloudinary-guide.md) | Blog image upload workflow, URL transforms, folder conventions |
| [vscode-publishing-guide.md](.claude/development/vscode-publishing-guide.md) | VS Code Marketplace publishing, local/CI workflow, PAT rotation |
| [subagent-tool-permissions-guide.md](.claude/development/subagent-tool-permissions-guide.md) | Subagent tool access by type, foreground/background behavior, skill author checklist |
| [supabase-migration-safety.md](.claude/development/supabase-migration-safety.md) | Pre/post-apply query catalog, ACCESS EXCLUSIVE locks, rollback, pooler. Invoke via `supabase-migration-reviewer` skill |
| [ruvector-dev-tooling.md](.claude/development/ruvector-dev-tooling.md) | `skillsmith-doc-retrieval` MCP (SMI-4417) — local semantic doc search, post-commit hook, token-delta gate |
| [skill-invoke-telemetry-guide.md](.claude/development/skill-invoke-telemetry-guide.md) | Skill-invocation telemetry pipeline (SMI-5012) — wire format, consent gate, dispatcher coverage, rotation policy |
| [smoke-prod-guide.md](.claude/development/smoke-prod-guide.md) | Post-deploy smoke harness (SMI-4459) — surface manifest, failure triage, phase rollout |
| [vercel-deploy-hook.md](.claude/development/vercel-deploy-hook.md) | Vercel→GitHub `repository_dispatch` triggering `smoke-prod.yml` post-deploy |
| [e2e-staging-runbook.md](.claude/development/e2e-staging-runbook.md) | `device-login-roundtrip.yml` (SMI-4460) — secret rotation, Docker carve-out, prod-ref grep gate |
| [eval-cron-setup.md](.claude/development/eval-cron-setup.md) | Canonical-dev retrieval-eval cron (SMI-4764 W2) — launchd/systemd, heartbeat, replacement protocol |
| [edge-function-attribution-queries.md](.claude/development/edge-function-attribution-queries.md) | Canonical pooler queries for edge function attribution monitoring (SMI-4370 / Wave 4d) |
| [concurrency-patterns.md](.claude/development/concurrency-patterns.md) | Pattern-to-incident-to-canonical-fix index for the five `concurrency-auditor` patterns (SMI-4895/4896/4861/4887) |
| [guards-and-opt-outs.md](docs/internal/process/guards-and-opt-outs.md) | Canonical Guards & Opt-Outs registry (guard → trigger → marker → disable var → scope) — SMI-5418 DoD #5 |
| [upstash-redis-operations.md](docs/internal/runbooks/upstash-redis-operations.md) | Upstash Redis architecture (4 consumers), setup, credential rotation, health-check monitoring |

**Implementation plan template**: [.claude/templates/implementation-plan.md](.claude/templates/implementation-plan.md) — use this structure for all plans in `docs/internal/implementation/`.

---

## Docker-First Development

**All code execution MUST happen in Docker** for any path that loads native modules (`better-sqlite3`, `onnxruntime-node`, etc.). Native modules require glibc — see [ADR-002](docs/internal/adr/002-docker-glibc-requirement.md), whose scope is narrowly the choice of `node:22-slim` over Alpine, *not* a project-wide mandate that every CI job run in Docker.

**CI carve-out (SMI-4647)**: two pure-JS jobs run on the host runner — `quality-checks` (bundles lint + typecheck + audit:standards since SMI-4908) and `code-review`. New jobs default to Docker; opt-in requires `# audit:carveout-pure-js` marker. Full rationale: [ci-reference.md § Docker-First CI Carve-out](.claude/development/ci-reference.md#docker-first-ci-carve-out-smi-4647).

```bash
docker compose --profile dev up -d                    # Start container (REQUIRED first)
docker exec skillsmith-dev-1 npm run build             # Build
docker exec skillsmith-dev-1 npm test                  # Test
docker exec skillsmith-dev-1 npm run lint              # Lint
docker exec skillsmith-dev-1 npm run typecheck         # Typecheck
docker exec skillsmith-dev-1 npm run audit:standards   # Standards audit
docker exec skillsmith-dev-1 npm run preflight         # All checks before push
```

**From a worktree (SMI-5559)**: the `docker exec skillsmith-dev-1 <cmd>` form above is for the **main checkout only** — its container is long-lived, so that exact command silently "succeeds" from any worktree even if the worktree's own container never started. From `.worktrees/<name>/`, use `./scripts/worktree-docker.sh exec -- <cmd>` instead — it resolves the container matching your actual cwd and errors loudly (not silently) if it isn't running, e.g. `./scripts/worktree-docker.sh exec -- npm run preflight`.

**`git push` from a worktree (SMI-5570/SMI-5074)**: pre-push routes through **this worktree's own dedicated container**, not `skillsmith-dev-1` — an earlier default (SMI-5548) routed through main's shared container reached via the worktree's nested path, which silently tested main's own dependency state instead of the worktree branch's own (a Docker `mount(2)` behavior, not macOS-specific). Start this worktree's container before pushing (`docker compose --profile dev up -d`); pre-push hard-fails with the exact remediation command if it isn't running, unless the push is docs-only or you opt out with `SKILLSMITH_PRE_PUSH_HOST=1` (one push) or `SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1` (registered in [guards-and-opt-outs.md](docs/internal/process/guards-and-opt-outs.md)).

**After pulling**: post-merge hook auto-runs `npm install` in Docker on `package-lock.json` change; if container is down, start it and run `docker exec skillsmith-dev-1 npm install && npm run build`. **Full rebuild** (native modules, major upgrades): [docker-guide.md](.claude/development/docker-guide.md#full-rebuild-thorough). **Stop**: `docker compose --profile dev down`. **Logs**: `docker logs skillsmith-dev-1`. **Submodule**: `git submodule update --init` before `docker compose up` if internal docs needed inside container.

**Auto-recovery (SMI-5245)**: the `dev` service sets `restart: unless-stopped`, so the container comes back on its own after a Docker Desktop / machine restart — this keeps the `skillsmith-doc-retrieval` + `skillsmith` MCP servers (launched via `docker exec` in `.mcp.json`) from silently dropping with a `-32000` reconnect error. An explicit `docker compose --profile dev down` or `docker stop` is still honored (stays down). If you ever see the container *restart-looping* after a reboot, it hit a degraded environment (wiped volume / ABI mismatch) — run the **Container won't start** Troubleshooting recipe. **Both MCP servers require the container to be running** — there is no fallback path; if the container is down, `/mcp` will report `Failed to reconnect` and all MCP tools will be unavailable until `docker compose --profile dev up -d` is run.

**After fresh clone or volume wipe**: run `npm install` + `npm run build` in the container before the `skillsmith` MCP server can connect. Both MCP servers now have their own preflight launcher: `skillsmith` via `scripts/mcp-skillsmith-launcher.sh` (SMI-5049) and `skillsmith-doc-retrieval` via `scripts/mcp-doc-retrieval-launcher.sh` (SMI-5718) — each prints actionable stderr in the `/mcp` panel's per-server log when `node_modules/` or `dist/` is missing, or when a runtime dependency is corrupt/unresolvable (e.g. an empty nested `node_modules` dir shadowing the hoisted copy after an interrupted npm install, SMI-5451/SMI-5452) — surfaced when you expand the failing entry. `skillsmith-doc-retrieval` additionally checks that the `skillsmith-dev-1` container itself is running before it tries to `docker exec` into it (it is Docker-only — native module `better-sqlite3`).

---

## CI Health Requirements

Zero ESLint warnings/errors. TypeScript strict (no unjustified `any`). All files Prettier-formatted. 100% test pass. No high-severity vulns. **<500 lines/file** (`audit:standards` enforces; split into `foo.helpers.ts`/`foo.types.ts` if approaching, or — for a command whose `withTelemetry`-wrapped action handlers push it over — a `foo.action.ts` sibling holding the impls + wrapped exports while `foo.ts` keeps the commander factory, SMI-5127+). >80% coverage. Source-file changes must include related test updates.

**When CI fails**: don't merge. Run `docker exec skillsmith-dev-1 npm run preflight` locally. Linear issue if non-trivial.

**Concurrency prevention (SMI-4891/4892/4902)**: shared-state / race-condition gating via the `concurrency-auditor` skill (Mode A plan-audit, Mode B diff-audit) and the `concurrency-audit-pr.yml` PR workflow (shadow mode for first 7 days). Lazy-helper convention for browser globals (`window.__SUPABASE_CLIENT__` reads only via `getSupabaseClient()`) enforced by the `no-raw-window-global` ESLint rule. Pattern reference + canonical-fix PRs: [concurrency-patterns.md](.claude/development/concurrency-patterns.md). Opt-out marker: `[concurrency-audit-ack]` in PR body (boolean shape, reason as prose paragraph).

**Post-deploy smoke (SMI-4459)**: `smoke-prod.yml` runs `scripts/smoke-prod.sh` against prod after each merge. Failure → Linear + email. Skip: `[skip-smoke]` in PR body. [smoke-prod-guide.md](.claude/development/smoke-prod-guide.md).

**Build**: Turborepo (`npm run build`); legacy fallback `npm run build:legacy` ([ADR-106](docs/internal/adr/106-turborepo-build-orchestration.md)). **Change tiers**: `docs` ~30s, `config` validation, `code` ~11 min full, `deps` rebuild+audit. **Branch protection**: 14 checks (code) / 3 checks (docs-only). **npm overrides, release-PR carve-out, vitest split rationale**: [ci-reference.md](.claude/development/ci-reference.md).

**Dependabot lockfile stability (SMI-5272)**: the root `jose: "5.10.0"` devDependency is a **load-bearing anchor** — it pins an otherwise optional-peer-only `jose@5.10.0` (reachable solely via `ruflo → @claude-flow/cli → fastmcp`) as a regular root edge so Dependabot's lockfile regen can't drop it. If Dependabot or `npm ci` ever fails with `Missing: jose@5.10.0 from lock file`, the anchor was removed — restore it. Root cause + manual-consolidated-bump fallback: [ci-reference.md § Dependabot lockfile regen](.claude/development/ci-reference.md).

---

## Project Overview

Skillsmith is a lifecycle manager for agent skills (discovery, installation, updates, and management), delivered as an MCP server, CLI, and VS Code extension. Packages: `@skillsmith/core` (DB, repositories, services), `@skillsmith/mcp-server` (MCP tools), `@skillsmith/cli`. License: [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) — all packages, source-available ([ADR-119](docs/internal/adr/119-unified-elastic-license.md)). Quick Start: [README](README.md).

| Tier | Price | API Calls/Month |
|------|-------|-----------------|
| Community | Free | 100 |
| Individual | $9.99/mo | 1,000 |
| Team | $25/user/mo | 10,000 |
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

**Branch naming**: `<type>/<slug>` — `feature/`, `fix/`, `chore/`, `docs/` (matches the commit-type prefixes). Do not prefix branches with a personal username (e.g. `ryansmith108/...`); a growing number of `ryansmith108/`-prefixed branches has drifted from this convention and should be renamed/avoided going forward.

**Risk-first wave ordering (SMI-2596)**: Waves with database migrations or production behavior changes execute first, regardless of implementation readiness. If deviating from risk order, document the rationale explicitly in the wave plan.

**Wave branch stacking (SMI-2597)**: When multiple waves modify overlapping files, branch sequentially (Wave N+1 from Wave N's branch) instead of all from main. This prevents merge conflicts from squash-merges. Tradeoff: earlier waves must merge before later waves can start CI.

**Direct-to-main SQL fixes (SMI-2598)**: see [branch-management.md § Direct-to-Main Commits](.claude/development/branch-management.md#direct-to-main-commits-smi-2598).

---

## Linear Hygiene (per-commit + per-PR)

**Keep Linear in lock-step with the code. Every commit and every merge updates Linear before moving on — no batching, no end-of-session catch-up.**

**After EVERY commit** (immediately, before the next task):

1. **Comment** on the relevant `SMI-xxx` issue with the commit SHA + a one-line summary of what changed.
2. **Advance status** if the commit completes the work (`In Progress` → `In Review`/`Done`). A commit that only partially advances the issue stays `In Progress` with a progress comment.
3. If **no issue exists** for the work, create one under the correct project *before* committing (never commit orphaned work). Project assignment is mandatory (see [Linear hygiene guide](docs/internal/process/linear-hygiene-guide.md)).

**After EVERY PR merges**:

1. Move the issue to `Done` with the squash-merge SHA in a closing comment.
2. Post a **project update** on the Linear project — with every PR, not just when a wave/PR-cluster lands or a blocker changes state. Content: reuse the `pr-description` skill's Business Summary verbatim — keep stakeholders current without them having to read the issue feed.

**Tooling**: MCP Linear tools when connected; fallback `varlock run -- node scripts/linear-api.mjs` (never `npm run linear:done` — broken). Team: **Smith Horn Group**. Always set `project` + a detailed description + labels on issue creation. Full conventions: [linear-hygiene-guide.md](docs/internal/process/linear-hygiene-guide.md).

---

## Varlock Security

**All secrets via Varlock. Never expose API keys in terminal output.** Commit `.env.schema` (defines `@sensitive`) and `.env.example` (placeholders); **never** `.env`. Run with secrets: `varlock run -- npm test`. Validate: `varlock load` (masked). **Never** `echo $SECRET` or `cat .env`. Never ask users to paste secrets in chat. See [AI Agent Secret Handling](docs/internal/architecture/standards-security.md#411-ai-agent-secret-handling-smi-1956).

**Supabase pooler access**: `SUPABASE_POOLER_URL` has a literal `[YOUR-PASSWORD]` placeholder. Two canonical helpers, both via `varlock run --` (host tool — not inside the container): `./scripts/pooler-psql.sh` (transaction pooler, port 6543) for ad-hoc queries, single-statement DDL, short writes — bypasses PostgREST's 8s `statement_timeout`. `./scripts/pooler-psql-session.sh` (session pooler, port 5432) for long-running maintenance — `VACUUM`, `REINDEX CONCURRENTLY`, stored procedures with `COMMIT` between batches, anything where the transaction pooler returns `ECHECKOUTTIMEOUT` (SMI-4968 retro / SMI-4999). Requires Docker container running. Full rationale: script headers.

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
| `skill_recommend` | Contextual skill recommendations |
| `skill_validate` | Validate skill structure |
| `skill_compare` | Compare 2-5 skills side-by-side |
| `skill_diff` | Diff two installed skill versions side-by-side |
| `skill_audit` | Audit skill for security advisories (Team+) |
| `skill_inventory_audit` | Audit local `~/.claude/` inventory for namespace collisions; returns rename + edit suggestions (SMI-4590) |
| `apply_namespace_rename` | Apply a rename suggestion from an audit (`apply` / `custom` / `skip`) (SMI-4590) |
| `apply_recommended_edit` | Apply a recommended prose edit; gated on `APPLY_TEMPLATE_REGISTRY` (SMI-4590) |
| `undo_apply` | Session-scoped undo of the most recent apply_namespace_rename/apply_recommended_edit changeset(s), restored from the apply tool's own backup (SMI-5456/SMI-5470) |
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

**Adding anonymous functions** (CI validates): add to `supabase/config.toml` with `verify_jwt = false`, to `NO_VERIFY_JWT_FUNCTIONS` in `scripts/audit-standards.mjs`, and to the deploy block below; `npm run audit:standards` Check 47 (SMI-4963) enforces deploy-script + validate-script + `config.toml` registration coherence. **Deploy commands** (`--no-verify-jwt` required — CI scans CLAUDE.md for these):

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
npx supabase functions deploy license-status --no-verify-jwt
npx supabase functions deploy regenerate-license --no-verify-jwt
npx supabase functions deploy create-portal-session --no-verify-jwt
npx supabase functions deploy list-invoices --no-verify-jwt
npx supabase functions deploy skills-outreach-preferences --no-verify-jwt
npx supabase functions deploy admin-grant-subscription --no-verify-jwt
npx supabase functions deploy admin-incident-manage --no-verify-jwt
npx supabase functions deploy advance-notice-email --no-verify-jwt
npx supabase functions deploy auth-device-code --no-verify-jwt
npx supabase functions deploy auth-device-token --no-verify-jwt
npx supabase functions deploy quota-monitor --no-verify-jwt
npx supabase functions deploy webhook-heartbeat-monitor --no-verify-jwt
npx supabase functions deploy status-check --no-verify-jwt
npx supabase functions deploy status-public --no-verify-jwt
npx supabase functions deploy audit-unsubscribe --no-verify-jwt
npx supabase functions deploy team-compliance-check --no-verify-jwt
npx supabase functions deploy telemetry-consent --no-verify-jwt
npx supabase functions deploy scan-coverage-monitor --no-verify-jwt
```

**Gateway-verified auth** (SMI-4291; deploy without `--no-verify-jwt`): `webhook-dlq`, `auth-device-approve`, `auth-device-preview`, `indexer-dispatch` (SMI-4852), `team-invite-send` (SMI-4294), `sync-stripe-email` (SMI-5168), `sync-oauth-email` (SMI-5173), `inventory-upload` (SMI-5389), `purge-inventory` (SMI-5510), `audit-notify` (SMI-5541). **CORS, auto-deploy & monitoring**: [deployment-guide.md](.claude/development/deployment-guide.md), [edge-function-patterns.md § Auto-deploy](.claude/development/edge-function-patterns.md#auto-deploy).

---

## Monitoring & Alerts

High-cadence: Skill Indexer (maintenance 00:00 UTC + recheck 03:00 UTC + discovery in 3 hourly phase-slots per 6h cycle at 06/07/08, 12/13/14, 18/19/20 UTC per SMI-4870, `indexer`), Metadata Refresh (every 4h :30, `skills-refresh-metadata`), Quota Monitor (hourly, Supabase pg_cron — SMI-4798; max quota-warning delay is 60 min), Edge Function Deploy (on merge to main, GHA). Public Status Page (SMI-5752): `status-check` every 5 min (`*/5 * * * *`, writes `status_checks`), `status-daily-rollup` daily 00:15 UTC (aggregates the previous UTC day into `status_daily_rollups`), `status-checks-purge` daily 00:20 UTC (drops `status_checks` rows older than 100 days — `status_daily_rollups` is the durable record). Liveness-alert: weekly retrieval-eval cron also runs a telemetry-feed stale-detection backstop that opens a deduped GitHub issue (`telemetry-liveness` label) when the local `retrieval_events` feed hasn't produced a row in >N days (shadow-default). `status-external-prober` (Wave 7, SMI-5756) runs every 10 min (`*/10 * * * *`, GitHub Actions — outside both Supabase and Vercel) probing `status-public` via both the raw prod Supabase ref and `api.skillsmith.app`; opens a deduped `status-external-outage`-labeled GitHub Issue only on a confirmed dual-URL failure, auto-closes on recovery (shadow-default). `scan-coverage-monitor` (SMI-5866) runs daily 21:45 UTC (Supabase pg_cron) measuring a birth-cohort NULL-rate of `skills.security_score` among recently-created rows (not a whole-table ratio — see the plan doc for why), catching the class of write-path silent-discard bug SMI-5849 was; alerts via the existing Resend/`audit_logs` channel, shadow-default (`SCAN_COVERAGE_ALERT_SHADOW`), self-monitors its own cron cadence. Full table: [deployment-guide.md § Scheduled Jobs](.claude/development/deployment-guide.md#scheduled-jobs). Alerts to `support@smithhorn.ca` via Resend on failures. All jobs log to `audit_logs` table.

---

## Ruflo MCP Server + MCP Registry

**Ruflo** (hive mind, agent spawning): auto-configured via `.mcp.json`. Tools `mcp__ruflo__{swarm_init, agent_spawn, coordination_orchestrate, swarm_shutdown}`, plus `mcp__ruflo__memory_retrieve`, `mcp__ruflo__memory_list`, `mcp__ruflo__memory_delete` (SMI-5777 — `task_orchestrate`/`memory_usage`/`swarm_destroy` do not exist in the live registry; `memory_store` may also exist, see SMI-5777's plan doc H-4 for the live-verification protocol before writing it in). Agent types: architect, coder, tester, reviewer, researcher. Full guide: [claude-flow-guide.md](.claude/development/claude-flow-guide.md). **MCP Registry**: `io.github.smith-horn/skillsmith` on [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/), auto-published via CI; sync `packages/mcp-server/{package,server}.json`. Auth: GitHub Actions OIDC (SMI-4534). Full guide: [mcp-registry.md](.claude/development/mcp-registry.md).

---

## Default Execution Model — Ruflo Queen + Worktrees + Model Tiering

**Default for any substantive, multi-step task: run a Ruflo queen-coordinator hive on a dedicated worktree** (`./scripts/create-worktree.sh`; the parent session is the queen). Trivial or purely conversational turns may run solo on the current branch.

**Worktrees are the default workspace.** Doing implementation work directly on `main` (or in the main checkout) requires an **explicitly approved exception** — state the rationale and get sign-off before proceeding. This keeps parallel sessions from colliding (SMI-4776) and keeps `main` clean.

**Route worker tasks by difficulty across model tiers** (the queen assigns each task to the cheapest tier that can do it well):

| Model | Role | Tasks |
|-------|------|-------|
| **Opus** | Hardest reasoning / adversarial | Detection-rule & algorithm design, FP/FN tuning, security & data-integrity design, adversarial review, plan-review, interpreting ambiguous findings |
| **Sonnet** | Core implementation | Feature code, edge<->core twin ports, tests, refactors, harness & report drafting |
| **Haiku** | Mechanical / high-volume | Fixture scaffolding, regression-baseline bumps, CSV/data wrangling, `index.md` edits, drafting Linear comments, doc formatting |
| **Codex (`gpt-5.6-sol` via NEEDLE)** | Cross-provider second opinion / burst capacity | Cross-provider second opinion on an already-drafted Opus design (different model family, not more reasoning depth — Skillsmith-internal adversarial review stays Opus), OpenAI-specific surfaces, burst work under Claude-quota constraints |

**The queen owns all side effects.** Workers/subagents never commit, push, post to Linear, or touch git — they hand their output (file edits, plus any `index.md` or Linear-comment drafts) back to the queen, who verifies and applies it. The `governance-specialist` subagent in particular must never commit to `main` or delete branches (SMI-5060). Foreground subagents only for interactive prompts; background subagents auto-deny unapproved tools. **This rule outranks this file's own blanket "after every commit"/"after every PR merge" instructions below** (incident, 2026-07-20: a subagent explicitly told not to commit/push/PR/merge instead did all four plus a Linear close-out, reasoning from those blanket lines — never filed as its own Linear issue; a prior version of this line miscited "SMI-5778," which is an unrelated npm-audit CI issue from the same day) — a subagent's own task prompt scoping is authoritative for that subagent; the blanket instructions bind only the top-level coordinating session.

**Codex dispatch (SMI-5668, ADR-128).** Codex-tier tasks are never routed through Ruflo or the Agent/Task tool — dispatch via `scripts/needle/dispatch.sh --workspace <worktree> --title ... --body-file ... [--expect-write]`, which shells out to a separately-authenticated `codex exec` process through NEEDLE. Sandbox is read-only, no override; Codex output is text the queen reads and applies, same as any subagent. **A task requiring actual file writes cannot succeed under the current read-only-only adapter** — pass `--expect-write` for write-intent prompts so `dispatch.sh` can detect and flag the sandbox-rejected-write false-success case (SMI-5700) instead of silently reporting success; omit it for analysis/review-only prompts, where "no diff" is the expected outcome. See `scripts/needle/README.md`'s Troubleshooting section for the full mechanism. Not for tasks depending on this session's accumulated context (no shared memory between harnesses), and not for anything a Sonnet/Haiku worker would finish in under ~2 minutes — a defensive default against Codex's own workspace-file auto-discovery surfacing unexpected priming content in an unusual workspace, not an expected per-dispatch tax (see `scripts/needle/README.md`). On a failed or unclassifiable dispatch, the queen re-dispatches the task through normal Claude-tier routing rather than treating the failure as final. One-time personal setup: `scripts/needle/README.md`.

Full agent catalog, swarm topologies, and hive-mind examples: [claude-flow-guide.md](.claude/development/claude-flow-guide.md); for SPARC methodology (not a v3 CLI subcommand), see the `sparc-methodology` skill.

---

## Publishing Packages

**Release prep**: `docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --all=patch` (also `--core=minor --cli=patch`, `--dry-run`). **Publish (CI-only)**: `git push && gh workflow run publish.yml -f dry_run=false`. Cadence: weekly (Sun 03:00 UTC) OR `[Unreleased]` ≥ 15 entries ([ADR-114](docs/internal/adr/114-release-cadence-and-gh-release-alignment.md)). Order: core → mcp-server, cli, enterprise. Local fallback deprecated (SMI-4533). Pre-publish checklist, version-pin rules, break-glass: [publishing-guide.md](.claude/development/publishing-guide.md).

---

## VS Code Extension

Published as `skillsmith-vscode` on [Marketplace](https://marketplace.visualstudio.com/items?itemName=skillsmith.skillsmith-vscode). No Docker (ADR-113). Build: `cd packages/vscode-extension && npm run build && npm run package:check`. CI publish, PAT rotation, changelog rules: [vscode-publishing-guide.md](.claude/development/vscode-publishing-guide.md).

---

## Skill Location Policy

"Skill" means two different things in this repo, sharing only the `SKILL.md` format — which category a new one belongs to decides where it goes:

- **Operational skills** (extend Claude Code itself, for developing Skillsmith) — split by *audience*: `~/.claude/skills/` (global, user-level) for cross-project conventions that apply beyond this repo (e.g. `commit`, `plan-review-skill`); `.claude/skills/` (the `skillsmith-strategy` submodule — see [Git-Crypt](#git-crypt-narrowed-scope)) for Skillsmith-specific dev workflow (`pr-reviewer`, `governance`, `pr-description`), gated because `skillsmith-strategy` is the private competitive-IP repo.
- **Product skill data** (Skillsmith's own domain — it's a skill *lifecycle manager*, so skills are also data it operates on, not just tooling) — lives wherever the consuming package already owns its data, same as any other source/fixture file: registry corpus (`data/external-skills/`), bundled installable assets (`packages/{mcp-server,cli}/**/assets/skills/`), test fixtures (`packages/*/tests/fixtures/**`).

When adding a new skill, ask: does this extend Claude Code, or is it content Skillsmith operates on as a product? That answers which half of this list it belongs to — no separate framework needed beyond this distinction.

---

## Skills & Embedding

Project skills load from the `.claude/skills/` mount-point of the `skillsmith-strategy` submodule. `LocalIndexer.index()` returns `[]` (not throws) when the directory is absent OR present-but-empty (gate #2, SMI-4829). Embedding: real ONNX (~50ms) or mock (`SKILLSMITH_USE_MOCK_EMBEDDINGS=true`); see [ADR-009](docs/internal/adr/009-embedding-service-fallback.md). Disable auto-update: `SKILLSMITH_AUTO_UPDATE_CHECK=false`.

---

## Session Priming (SMI-4451)

`SessionStart` hooks fire on `source=startup` for branches containing an SMI/wave token anywhere in the name (`smi-NNN` or `wave-NNN`; covers `fix/smi-…`, `chore/smi-…`, etc — SMI-4809 broadened the matcher from literal-prefix only). Deny list: `main`, `hotfix-*`, `dependabot/*`, `renovate/*`, `release/*`, `revert/*`. **This branch-token gate applies to the priming hook only** — the audit and MCP-guard hooks below fire on every `startup` regardless of branch. Three hooks: priming (`scripts/session-start-priming.sh`, disable via `SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING=1`) + audit (SMI-4590 — Team/Enterprise namespace audit, 24h debounce, fail-soft, tier-gated; disable via `SKILLSMITH_SESSION_AUDIT_DISABLE=1`) + MCP command guard (SMI-5642 — warns on bare-command MCP server configs vulnerable to nvm-drift ENOENT, 24h-debounced per finding, fail-soft; disable via `SKILLSMITH_MCP_COMMAND_GUARD_DISABLE=1`). Three state-consumers surface diagnostics in the priming banner without being hooks: (a) the **auto-heal consumer** reads `~/.skillsmith/retrieval-autoheal.state` to surface a failing host native-binding repair (SMI-5426; disable: `SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE=1`), (b) the **liveness consumer** reads `~/.skillsmith/retrieval-liveness.state` to surface when the telemetry feed is stale (SMI-5432; disable: `SKILLSMITH_RETRIEVAL_LIVENESS_DISABLE=1`), and (c) the **reindex consumer** reads `~/.skillsmith/reindex.state` to surface a failed, anomalous, or hung doc-retrieval reindex (SMI-5786 follow-up; disable: `SKILLSMITH_REINDEX_STALENESS_DISABLE=1`). All three are *consumers of state, not hooks* — the underlying remediation (auto-heal), detection (liveness check), and reindex trigger (`.husky/post-commit`, every commit) are driven by their own schedules/triggers (post-merge, weekly eval cron, and every commit respectively). Full mechanism: [ruvector-dev-tooling.md § Session Priming](.claude/development/ruvector-dev-tooling.md#session-priming-smi-4451).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Scan-coverage alert fired (`scan_coverage_degraded`, SMI-5866) | The security-scan write path has stayed abnormally NULL for skills created in the last 24h — confirm with `SELECT * FROM check_scan_coverage();` via `./scripts/pooler-psql.sh`, then inspect the indexer scan write path (`scripts/indexer/skill-processor.ts` around the `security_score` assignment, and the `validationCache` round-trip in `indexer-runners.ts` — this is the exact class of bug SMI-5849 was). Auto-clears on the first tick back under threshold; re-alerts at most once per 24h while degraded. If no alert email ever arrives despite a confirmed degradation, check whether `SCAN_COVERAGE_ALERT_SHADOW` (default on) was ever lifted to `0` — shadow mode still measures/writes state/audits but never sends. Disable sending entirely: `SCAN_COVERAGE_ALERT_DISABLE=true` (Supabase edge-function secret). |
| Container won't start | `docker compose --profile dev down && docker volume rm skillsmith_node_modules && docker compose --profile dev up -d` |
| Native module errors | `docker compose restart dev` (entrypoint self-heals better-sqlite3 / onnxruntime-node / hnswlib-node on restart, SMI-5351; first run may re-download a prebuilt) or per-module `docker exec skillsmith-dev-1 npm rebuild <module> --ignore-scripts=false`. esbuild's binary loads lazily, so a corrupt esbuild binary isn't auto-detected — SMI-5352. |
| `hnswlib-node` fails validation after rebuild (`ignore-scripts=true` in `.npmrc` blocks node-gyp — see SMI-5200) | The entrypoint now self-heals on restart (`docker compose restart dev`, SMI-5351 extended `--ignore-scripts=false` to all native modules). `docker volume rm skillsmith_node_modules` is a last resort only. |
| Platform mismatch (SIGKILL 137) | `rm -rf packages/*/node_modules/better-sqlite3 packages/*/node_modules/onnxruntime-node` then rebuild |
| Node ABI mismatch | WASM fallback auto-activates (core ≥0.4.10). Restore native: rebuild in Docker + `./scripts/repair-host-native-deps.sh` (SMI-4549) |
| Host retrieval autoheal failed or in cooldown | Read `~/.skillsmith/logs/retrieval-autoheal-<date>.log` → fix the root cause → reset with `rm ~/.skillsmith/retrieval-autoheal.state` (next `post-merge` retries) → or disable with `SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE=1` (SMI-5426) |
| Retrieval-telemetry liveness alert fired (GitHub issue `telemetry-liveness`) | Read `~/.skillsmith/logs/retrieval-liveness-<date>.log` → repair with `./scripts/repair-host-native-deps.sh` → snooze a known away-window with `SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL=<epoch>`, or disable with `SKILLSMITH_RETRIEVAL_LIVENESS_DISABLE=1` (SMI-5432) |
| `status-external-outage` GitHub Issue fired | Both `status-public` URLs (raw Supabase ref + `api.skillsmith.app`) failed 3/3 attempts from outside Supabase/Vercel — check <https://status.supabase.com> and Vercel's status page first; the issue auto-closes on the next healthy tick (~10 min); snooze a known maintenance window with the `SKILLSMITH_STATUS_EXTERNAL_PROBE_DISABLE=1` repo variable (SMI-5756) |
| "invalid ELF header" in Docker (SMI-4698) | Try `docker compose restart dev` (self-heals) or `docker exec skillsmith-dev-1 npm rebuild <module> --ignore-scripts=false` first; for persistent host-binding leaks, see [git-crypt-guide.md § Host Native Bindings](.claude/development/git-crypt-guide.md#host-native-bindings--sessionstart-instrumentation-smi-4549) |
| Worktree `npm run build` fails (SMI-4689) | SMI-4738 postinstall auto-regenerates override; bounce worktree container. Drift: `./scripts/repair-worktrees.sh` from main repo. macOS only. [Details](.claude/development/git-crypt-guide.md#worktree-docker-bind-mounts-smi-4689) |
| Worktree container hits `EROFS` writing `node_modules/.vite-temp` or `node_modules/.astro` (SMI-5705/SMI-5722) | A Docker bind mount's source is resolved at container-**create** time, so a fresh container can be created before the writable cache-overlay source directory exists on the host — only a full recreate, not a plain `restart`, re-resolves it: `docker compose --profile dev up -d --force-recreate dev`. `ensure_build_cache_mount_sources()` (`scripts/_lib.sh`) now pre-creates these directories at worktree-create time and on every `repair-worktrees.sh`/`postinstall` regen, so this should be rare going forward. The overlay mechanism covers `.vite`/`.vite-temp` (Vite/Vitest) and now `.astro` (Astro's own build cache, SMI-5722). [Details](.claude/development/git-crypt-guide.md#worktree-docker-bind-mounts-smi-4689) |
| Worktree container boot log shows `[repair] Could not link ... (non-fatal)` or `... missing/read-only — alias ... not linked` (SMI-5650) | **Not expected — indicates a stale override, not a cosmetic warning.** Post-SMI-5650 the `@skillsmith`/`@smith-horn` scope directories are writable tmpfs overlays that `repair-worktree-container-symlinks.sh` populates at every boot; a persistent warning means this worktree's `docker-compose.override.yml` predates SMI-5650 (no tmpfs mounts yet) or the container hasn't been recreated since the last regen. Fix: `./scripts/repair-worktrees.sh` from the main checkout, then `docker compose --profile dev up -d` in the worktree (recreate, not `restart` — new mounts only apply on recreate). A healthy boot instead logs `[repair] Repaired N ...` or `... already correct`. The same pre-SMI-5650 read-only root mount also blocked native-module self-heal (SMI-5351) for any workspace-local copy under `node_modules` — independently confirmed via SMI-5635 (`docker compose restart dev` not fixing a broken `better-sqlite3` binding) — fixed separately in SMI-5650 Wave 2 (native-module named-volume seeding); see git-crypt-guide.md's `SKILLSMITH_PRE_PUSH_HOST` entry for the pre-push implication while Wave 2 is still landing. **If `./scripts/repair-worktrees.sh` itself warns that this worktree's host-side `node_modules` is empty but could not be removed (SMI-5689/SMI-5685)**: an active container still holds a mount reference into that empty directory — run `docker compose --profile dev down` in that worktree first, then re-run `./scripts/repair-worktrees.sh` and recreate. |
| Worktree edits not reaching the container (stale `wc -l`, prettier "No files matching", stale test runs) | macOS bind-mount freeze — `docker cp <hostfile> <container>:/app/<path>` to sync (pre-commit reads host files, so commits are unaffected). **`docker cp` exit 0 is NOT proof it landed** (SMI-5569: silent no-op on a subset of a batch) — verify each file by content, `diff -q <hostfile> <(docker exec <container> cat /app/<path>)` (not `wc -l`; same-line-count `.snap` edits slip through), re-cp until clean, and run checks in ONE long-lived container, not `docker compose run --rm`. Background/subagent runs must diff too. And never `npm install` in a worktree container to "fix" a blip — it wipes native modules (`.npmrc` ignore-scripts); `docker compose --profile dev restart dev` self-heals (SMI-5351). [Details](.claude/development/git-crypt-guide.md#worktree-bind-mount-freeze-and-npm-install-native-wipe-smi-5375) |
| Docker Desktop hung on "Turning off the Docker Engine..." (SMI-5616/SMI-5750) | Host disk full — check `df -h / /System/Volumes/Data`. Force-quit (`pkill -9 -f "com.docker.backend"`), relaunch, then `docker system prune -a -f --volumes` to reclaim. [Details](.claude/development/docker-guide.md#docker-desktop-hung-on-turning-off-the-docker-engine-smi-5616smi-5750) |
| Docker DNS failure | `docker network prune -f` then restart |
| Stale CJS artifacts | `docker exec skillsmith-dev-1 bash -c 'find /app/packages -path "*/src/*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -type f -delete'` |
| Tool missing in `skillsmith-dev-1` (e.g. `psql: executable file not found`) after a Dockerfile change merged on `main` (SMI-4820) | Stale local image — your container predates the Dockerfile commit. `docker compose --profile dev down && docker compose --profile dev build --no-cache dev && docker compose --profile dev up -d`. `--no-cache` ensures the cached `dev` layer doesn't shadow new `RUN apt-get install` lines. |
| Orphaned agents | `./scripts/cleanup-orphans.sh` (`--dry-run` to preview) |
| Pushed a fix to a release-cadence branch but CI never triggers, PR shows a stale `headRefOid`, or `gh api .../pulls/<N>/commits` is empty (SMI-5663, recurring — 6 weeks running as of PR #1959) | The release-cadence PR was auto-closed + branch-deleted by the staleness watcher before your push; the push recreates the branch ref (`git` reports `[new branch]`) but GitHub does not sync commits or fire `pull_request` events against an already-`closed` PR. Run `gh pr reopen <N>` — it resyncs `headRefOid` to your new push and CI begins running normally. Root cause (SMI-5663) is still open/Backlog; this is the known recovery step, not a fix. |
| Symlink outside skills root (SMI-4287) | Set `allowSymlinksOutsideRoot: true` in `LocalFilesystemConfig` to opt in |
| Session-start audit unexpected stderr (SMI-4590) | `export SKILLSMITH_SESSION_AUDIT_DISABLE=1`. Logs: `~/.skillsmith/logs/session-audit-<date>.log` |
| Session-priming banner shows a reindex failure/anomaly/hung warning | Read `~/.skillsmith/logs/skillsmith-doc-retrieval-<date>.jsonl` for the exact error → for a zero-touch anomaly, verify with a manual `docker exec skillsmith-dev-1 node packages/doc-retrieval-mcp/dist/src/cli.js reindex --full` → disable with `SKILLSMITH_REINDEX_STALENESS_DISABLE=1` if a known false positive (SMI-5786 follow-up) |
| Strategy submodule uninitialized | Empty `.claude/{skills,plans,hive-mind}/` mount-points are expected for external contributors. Skillsmith team members: `git submodule update --init .claude/skills .claude/plans .claude/hive-mind` (each pinned to its own branch in `smith-horn/skillsmith-strategy` per shape b′; no extra setup script). |
| Local typecheck/vitest fails with missing \`marked\`/\`sanitize-html\`/\`@types/sanitize-html\` (TS2688 / "Cannot find package") | Stale \`node_modules\` vs \`package-lock.json\`. Run \`docker exec skillsmith-dev-1 npm install\` + host \`npm install\`. The pre-commit hook now warns on this; pre-push blocks. Bypass a false positive with \`SKILLSMITH_SKIP_DEPS_FRESHNESS=1\` (SMI-5343/5344). |
| MCP server logs `Failed to close database on shutdown` | Non-fatal — the process still exits cleanly, but recently-installed skills' dependency metadata may not be persisted. If this recurs, check disk space and file permissions on `~/.skillsmith/skills.db`. The error is logged (not silent) specifically so this is diagnosable. See SMI-5639. |
| `skillsmith-doc-retrieval` shows `Failed to reconnect` or `MCP error -32603: schema._def.shape is not a function` in `/mcp` | `scripts/mcp-doc-retrieval-launcher.sh` (SMI-5718) now guards this — expand the failing entry for actionable stderr naming the exact state (container not running, corrupt/missing dependency incl. a stale nested `zod` — the SMI-5452 hazard — or root-hoisted `zod-to-json-schema`) and the exact remediation command. If you still see the raw `-32603` error, the launcher's code-level backstop in `jsonSchemaOf()` (`packages/doc-retrieval-mcp/src/server.ts`) also throws a diagnosable `[doc-retrieval]`-tagged message instead of the opaque native error — check the MCP host's per-server log for it. |

**Detailed diagnostics**: [docker-guide.md](.claude/development/docker-guide.md#troubleshooting).

---

## Key References

- **Architecture**: [API Architecture (as-built)](docs/internal/architecture/system-design/api-architecture.md), [Skill Dependencies](docs/internal/architecture/system-design/skill-dependencies.md), [Index](docs/internal/architecture/index.md). Historical (Dec-2025 design, superseded): [System Overview](docs/internal/architecture/system-design/system-overview.md)
- **Standards**: [Engineering](docs/internal/architecture/standards.md), [DB](docs/internal/architecture/standards-database.md), [Astro](docs/internal/architecture/standards-astro.md), [Security](docs/internal/architecture/standards-security.md)
- **Process**: [Context Compaction](docs/internal/process/context-compaction.md), [Linear Hygiene](docs/internal/process/linear-hygiene-guide.md), [Wave Checklist](docs/internal/process/wave-completion-checklist.md)
- **Testing**: [Stripe](.claude/development/stripe-testing.md), [Neural](.claude/development/neural-testing.md)
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

**If you are a dispatched subagent** (spawned via the Agent/Task tool) and your own task prompt says not to commit, push, open/merge a PR, or touch Linear: that scoping wins over every "after every commit"/"after every PR merge" instruction below, no exceptions. Those blanket instructions bind the top-level coordinating session only. Hand your work back to the dispatcher instead.

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
Before every `gh pr create`, use the `pr-description` skill — PR bodies lead with a plain-language Business Summary, not technical detail first.
After EVERY PR is merged, run `/governance` as a retrospective on the full PR diff. Resolve ALL issues it surfaces immediately — create follow-up commits or Linear issues as needed. Do not close the session until the retro is clean.
After the governance retro, update any `index.md` files in directories where files were added or removed during the PR. Check `docs/internal/`, `.claude/development/`, and `.claude/templates/`. If the root `docs/internal/index.md` folder counts have drifted, update those too.
