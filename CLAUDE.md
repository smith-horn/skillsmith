# Claude Code Configuration - Skillsmith

## Sub-Documentation

Detailed guides extracted via progressive disclosure. CLAUDE.md contains essentials; sub-docs contain deep dives.

| Document | Description |
|----------|-------------|
| [docker-guide.md](.claude/development/docker-guide.md) | Container rebuild scenarios, DNS failure, native modules, troubleshooting |
| [git-crypt-guide.md](.claude/development/git-crypt-guide.md) | Unlock, worktree setup, rebase workaround, smudge filter fixes |
| [ci-reference.md](.claude/development/ci-reference.md) | Branch protection, change classification, Turborepo, CI scripts |
| [deployment-guide.md](.claude/development/deployment-guide.md) | Edge function deploy commands, CORS, website, monitoring & alerts |
| [claude-flow-guide.md](.claude/development/claude-flow-guide.md) | Ruflo (formerly claude-flow) — agent types, swarm examples, hive mind, SPARC modes |
| [cloudinary-guide.md](.claude/development/cloudinary-guide.md) | Blog image upload workflow, URL transforms, folder conventions |
| [vscode-publishing-guide.md](.claude/development/vscode-publishing-guide.md) | VS Code Marketplace publishing, local/CI workflow, PAT rotation |
| [subagent-tool-permissions-guide.md](.claude/development/subagent-tool-permissions-guide.md) | Subagent tool access by type, foreground/background behavior, skill author checklist |
| [supabase-migration-safety.md](.claude/development/supabase-migration-safety.md) | Pre/post-apply query catalog, ACCESS EXCLUSIVE lock discipline, rollback convention, pooler rules. Invoke via `supabase-migration-reviewer` skill for automated review. |
| [ruvector-dev-tooling.md](.claude/development/ruvector-dev-tooling.md) | `skillsmith-doc-retrieval` MCP — local semantic doc search (SMI-4417). Setup, tool surface, privacy boundary, post-commit hook, token-delta gate. |
| [smoke-prod-guide.md](.claude/development/smoke-prod-guide.md) | Post-deploy smoke harness (SMI-4459). Surface manifest, adding new surfaces, failure triage, phase rollout. |
| [vercel-deploy-hook.md](.claude/development/vercel-deploy-hook.md) | One-time Vercel→GitHub `repository_dispatch` setup that triggers `smoke-prod.yml` after a website deploy. |

**Implementation plan template**: [.claude/templates/implementation-plan.md](.claude/templates/implementation-plan.md) — use this structure for all plans in `docs/internal/implementation/`.

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
| Test co-update | Source file changes must include related test updates |

**New source files must be under 500 lines.** Split into companion files (e.g., `foo.helpers.ts`, `foo.types.ts`) if approaching the limit. The `audit:standards` script enforces this.

**When CI fails**: Don't merge. Check logs. Run `docker exec skillsmith-dev-1 npm run preflight` locally. Create Linear issue if non-trivial.

**Post-deploy smoke (SMI-4459)**: `.github/workflows/smoke-prod.yml` runs `scripts/smoke-prod.sh` against real prod after every merge. Each surface in `scripts/smoke-prod/surfaces.json` whose `trigger_globs` match changed files is exercised end-to-end. Failure → Linear issue + email. Skip via `[skip-smoke]` in PR body. Full guide: [smoke-prod-guide.md](.claude/development/smoke-prod-guide.md).

**npm overrides** (transitive vulnerability fixes in root `package.json`):

- **Before adding an override**, check if the target is exact-pinned: `docker exec skillsmith-dev-1 node -e "console.log(require('<pkg>/package.json').dependencies['<dep>'])"`. If no `^`/`~` prefix, a flat override alone **will not work** — npm cannot replace exact-pinned versions. However, `npm update <pkg>` may resolve it via dedup if another chain pulls in the patched version. Verify with `npm ls <dep>` after update. If the exact-pinned copy persists, dismiss the alert with documented rationale.
- `ajv`: scoped overrides only (`"parent": { "ajv": "^8.18.0" }`). A global override breaks ESLint (`ajv@6.x` → `8.x` API incompatible).
- `typescript-eslint` is a meta-package — always update `typescript-eslint`, `@typescript-eslint/parser`, and `@typescript-eslint/eslint-plugin` together (they share internal version locks). Dependabot groups them automatically (see `.github/dependabot.yml`).

**Change tiers**: `docs` (~30s), `config` (validation), `code` (~11 min full), `deps` (rebuild + audit). Mixed commits trigger full CI. Details: [ci-reference.md](.claude/development/ci-reference.md).

**Build**: Uses Turborepo (`npm run build`). Legacy fallback: `npm run build:legacy`. See [ADR-106](docs/internal/adr/106-turborepo-build-orchestration.md).

**Branch protection**: 13 required checks for code PRs, 2 for docs-only. Admin bypass for emergencies. Details: [ci-reference.md](.claude/development/ci-reference.md#branch-protection).

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

**Not encrypted** (always readable): `.claude/settings.json`, `supabase/config.toml`, `.claude/development/`, `.claude/templates/`.

**Worktrees**: Unlock main repo first, then `./scripts/create-worktree.sh`. Remove with `./scripts/remove-worktree.sh --prune`.

**Hooks in worktrees (SMI-4377)**: Pre-commit hooks work inside worktrees via two mechanisms: (1) `.husky/_/` is tracked in git (husky's dispatch stubs) so hook discovery inherits through checkout; (2) `scripts/create-worktree.sh` symlinks `node_modules` from the main repo so `lint-staged`, `eslint`, `prettier`, and `scripts/check-file-length.mjs` resolve. **One-time host setup required** (after fresh clone): `npm install --ignore-scripts` to populate `$REPO_ROOT/node_modules` — Docker named-volume installs don't populate the host path. Caveats: (a) do not run `npm install` in the main repo while a pre-commit is active in a worktree — re-run the commit if it aborts; (b) Phase 2 typecheck falls back to host `tsc` when invoked from a worktree (the Docker bind-mount covers only the main repo; SMI-4381 tracks the proper fix); (c) repair existing worktrees with `./scripts/repair-worktrees.sh` (idempotent).

**Rebasing**: `./scripts/rebase-worktree.sh <worktree-path> [target-branch]` handles git-crypt filter management, submodule cross-fetching, and branch verification. Use `--dry-run` to preview. Manual fallback: [git-crypt-guide.md](.claude/development/git-crypt-guide.md#rebasing-with-git-crypt).

**Full guide**: [git-crypt-guide.md](.claude/development/git-crypt-guide.md)

---

## Branch Management (SMI-2536)

Git-crypt smudge filters can silently switch branches during stash/pop operations (including lint-staged in pre-commit hooks). The pre-commit hook detects and aborts if this happens, but follow this protocol as defense-in-depth:

1. **Before first edit**: `git branch --show-current` — confirm you're on the feature branch
2. **After `git commit`**: `git branch --show-current` — verify the commit landed correctly
3. **After `git stash pop`**: `git branch --show-current` — stash pop is the most common trigger
4. **After `git checkout`**: `git branch --show-current` — checkout can report false success

**If branch switched during pre-commit**, the hook auto-restores to the correct branch
and exits 1 (SMI-2747). You will see:

```text
  ✓ Restored to <branch>. Staged changes preserved.
    Re-run: git commit

  Emergency bypass: git commit --no-verify
```

Re-run `git commit` — staged changes are preserved.

**If branch switched during commit** (post-commit fallback, rare), the post-commit hook prints
recovery commands:

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

**Supabase pooler access**: `SUPABASE_POOLER_URL` in `.env` contains a literal `[YOUR-PASSWORD]` placeholder by design — passwords with URL-special characters (`@ / : !`) break URI parsing, so every caller must build the connection from parts. Use the canonical helper instead of hand-rolling it:

```bash
echo 'SELECT COUNT(*) FROM skills;' | varlock run -- ./scripts/pooler-psql.sh
varlock run -- ./scripts/pooler-psql.sh -c 'SELECT version();'
cat query.sql | varlock run -- ./scripts/pooler-psql.sh
```

The script routes through the transaction pooler (port 6543) which avoids PostgREST's 8s `statement_timeout` on `audit_logs` LIKE queries (error 57014). Requires Docker container `skillsmith-dev-1` running. See `scripts/pooler-psql.sh` header for the full rationale.

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
| `skill_diff` | Diff two installed skill versions side-by-side |
| `skill_audit` | Audit skill for security advisories (Team+) |
| `audit_export` | Export audit log events for a time range (Enterprise) |
| `audit_query` | Query audit logs with filters (Enterprise) |
| `siem_export` | Export audit events for SIEM ingestion (Enterprise) |

**Auth**: Personal API Key (`X-API-Key: sk_live_*`, tier-based), Supabase Anon Key (30/min), No Auth (10 trial). Configure in `~/.skillsmith/config.json` or `SKILLSMITH_API_KEY` env in Claude settings. Shell exports don't reach MCP subprocesses.

**Team-scoped tools** (`team_workspace`, `share_skill`, `private_registry_*`) additionally require `SKILLSMITH_LICENSE_KEY` to resolve the caller's team AND `SUPABASE_SERVICE_ROLE_KEY` on the MCP host for downstream CRUD (SMI-4312 / ADR-116 — the MCP subprocess has no user JWT, so anon-key RLS policies deny). Resolution path: `SKILLSMITH_LICENSE_KEY` env → SHA-256 → `license_keys.key_hash` → `subscriptions` → `teams.subscription_id`, via the `resolve_team_from_license` RPC (migration 071, SECURITY DEFINER, invoked via anon client). Missing/invalid keys return a typed error (not stub data) when Supabase is configured; missing service-role key surfaces `Team workspace operations require SUPABASE_SERVICE_ROLE_KEY`.

**Trust tiers**: verified (official), community (reviewed), experimental (new/beta).

**CLI**: `skillsmith` or `sklx` — `author subagent/transform/mcp-init`, `sync/status/config`. See [ADR-018](docs/internal/adr/018-registry-sync-system.md).

---

## Supabase Edge Functions

**Project refs — do not confuse (SMI-4252 retro 2026-04-17)**:

| Ref | Role | Used for |
|-----|------|----------|
| `vrcnzpmndtroqxxoqkzy` | **Prod** | `.env` `SUPABASE_URL` / `SUPABASE_PROJECT_REF`; all `supabase functions deploy`; `audit_logs` / `v_indexer_health` / `/functions/v1/stats` when validating prod |
| `ovhcifugwqnzoebwfuku` | Staging | Low-cadence — data lags prod; never curl this when verifying a prod deploy |

When verifying a prod edge function via `curl`, always use `$SUPABASE_URL` (under `varlock run --`) or the literal `https://vrcnzpmndtroqxxoqkzy.supabase.co`. Hardcoding `ovhcifugwqnzoebwfuku` will make a healthy prod deploy look stale — a 2026-04-17 session burned ~7 minutes on this.

| Function | Auth | `--no-verify-jwt` |
|----------|------|--------------------|
| `early-access-signup`, `contact-submit`, `stats`, `checkout`, `stripe-webhook`, `events` | Anonymous | Yes |
| `skills-search`, `skills-get`, `skills-recommend` | API Key | Yes |
| `health` | Anonymous (health check) | Yes |
| `email-inbound` | Anonymous (Resend webhook) | Yes |
| `generate-license`, `regenerate-license`, `create-portal-session`, `list-invoices` | Authenticated (internal JWT) | Yes |
| `skills-outreach-preferences` | Authenticated (User JWT, handler-level) | Yes |
| `admin-grant-subscription` | Authenticated (Admin JWT) | Yes |
| `webhook-dlq` | Authenticated (User JWT, gateway-verified for RLS) | No |
| `update-seat-count` | Authenticated | No |
| `indexer`, `skills-refresh-metadata`, `ops-report`, `alert-notify` | Service Role | No |
| `process-pending-subscription` | Service Role | No |
| `expire-complimentary` | Service Role (daily 3 AM UTC cron) | No |
| `skills-outreach` | Service Role | No |
| `advance-notice-email` | Service Role | Yes |
| `auth-device-code` | Anonymous (RFC 8628 device auth) | Yes |
| `auth-device-token` | Anonymous (RFC 8628 token poll) | Yes |
| `auth-device-approve` | Authenticated (User JWT, gateway-verified) | No |
| `auth-device-preview` | Authenticated (User JWT, gateway-verified) | No |

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
npx supabase functions deploy skills-outreach-preferences --no-verify-jwt
npx supabase functions deploy admin-grant-subscription --no-verify-jwt
npx supabase functions deploy advance-notice-email --no-verify-jwt
npx supabase functions deploy auth-device-code --no-verify-jwt
npx supabase functions deploy auth-device-token --no-verify-jwt
```

**Gateway-verified auth** (SMI-4291 — relies on `auth.uid()` for RLS; no `--no-verify-jwt`):

```bash
npx supabase functions deploy webhook-dlq
npx supabase functions deploy auth-device-approve
npx supabase functions deploy auth-device-preview
```

**Auto-deploy**: Edge functions are automatically deployed when changes to `supabase/functions/**` are merged to main. The `deploy-edge-functions.yml` workflow detects changed functions and deploys only those. `_shared/` changes trigger a full deploy of all 30 functions. Manual full deploy: `gh workflow run deploy-edge-functions.yml -f deploy_all=true`.

**CORS & monitoring details**: [deployment-guide.md](.claude/development/deployment-guide.md)

---

## Monitoring & Alerts

| Job | Schedule | Function |
|-----|----------|----------|
| Skill Indexer | 4× daily (00 UTC maintenance + 06/12/18 UTC discovery) | `indexer` |
| Metadata Refresh | Hourly :30 | `skills-refresh-metadata` |
| Ops Report | Monday 9 AM UTC | `ops-report` |
| Quality Outreach | Manual (beta) | `skills-outreach` |
| Expire Complimentary | Daily 3 AM UTC | GitHub Actions (`expire-complimentary.yml`) |
| Weekly Analytics | Monday 9 AM UTC | GitHub Actions (`analytics-report.yml`) |
| Billing Monitor | Monday 9 AM UTC | GitHub Actions |
| Edge Function Deploy | On merge to main | GitHub Actions (`deploy-edge-functions.yml`) |

Alerts to `support@smithhorn.ca` via Resend on failures. All jobs log to `audit_logs` table. Manual trigger & audit log details: [deployment-guide.md](.claude/development/deployment-guide.md#monitoring--alerts).

---

## Ruflo MCP Server (formerly Claude-Flow)

Required for hive mind and agent spawning. Auto-configured via `.mcp.json`. Manual: `claude mcp add ruflo -s project -- npx ruflo@latest mcp start`.

**Tools**: `swarm_init`, `agent_spawn`, `task_orchestrate`, `memory_usage`, `swarm_destroy` (prefixed `mcp__claude-flow__` for backwards compatibility).

**Agent types**: architect, coder, tester, reviewer, researcher.

**Full guide**: [claude-flow-guide.md](.claude/development/claude-flow-guide.md)

---

## MCP Registry

Published as `io.github.smith-horn/skillsmith` on [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/). Auto-published via CI. **Version sync required**: update both `packages/mcp-server/package.json` and `packages/mcp-server/server.json`. Full guide: [mcp-registry.md](.claude/development/mcp-registry.md).

---

## Publishing Packages

**Release preparation** (version bump + changelog + commit):

```bash
docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --all=patch   # bump all
docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --core=minor --cli=patch  # selective
docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --dry-run --all=patch  # preview
```

The script updates all 6 version locations (package.json, VERSION constants, server.json), generates changelog entries, and creates a commit. See `docs/internal/implementation/release-automation.md` for details.

**Release cadence**: weekly (Sunday 03:00 UTC) OR when root `CHANGELOG.md [Unreleased]` ≥ 15 entries. Automation per [ADR-114](docs/internal/adr/114-release-cadence-and-gh-release-alignment.md); contributor-facing docs in [CONTRIBUTING.md § Releases](CONTRIBUTING.md#releases).

**Publishing — CI workflow** (preferred, avoids local npm auth/OTP issues):

```bash
git push
gh workflow run publish.yml -f dry_run=false
gh run watch <run-id> --exit-status              # Monitor progress
```

Uses `SKILLSMITH_NPM_TOKEN` secret. Publishes in dependency order (core → mcp-server, cli, enterprise) with validation, smoke tests, and MCP Registry publish. Always try this first.

**Local fallback** (when CI fails due to unrelated build issues): Uses `SKILLSMITH_NPM_TOKEN` from `.env` (granular access token with bypass 2FA). See [publishing-guide.md](.claude/development/publishing-guide.md) for full checklist and the working publish command.

**Publish order** (dependencies before consumers):

1. `@skillsmith/core`
2. `@skillsmith/mcp-server` and `@skillsmith/cli` (both depend on core)

**Pre-publish checklist** (manual publishes — only if CI workflow fails):

1. Build in Docker: `docker exec skillsmith-dev-1 npm run build`
2. Run preflight: `docker exec skillsmith-dev-1 npm run preflight`
3. Verify dependency versions are committed and pushed
4. Check dependency is published:

   ```bash
   VERSION=$(node -e "console.log(require('./packages/core/package.json').version)")
   npm view @skillsmith/core@$VERSION version   # must return the version
   ```

5. If dependency not published: publish it first with `./scripts/publish-packages.sh core`
6. Run `npm pack --dry-run` in the package dir to inspect tarball contents
7. Publish (from repo root — workspace `.npmrc` is ignored by npm):

   ```bash
   source .env && printf '%s\n' "//registry.npmjs.org/:_authToken=$SKILLSMITH_NPM_TOKEN" >> ~/.npmrc
   npm publish --ignore-scripts -w packages/<pkg>
   sed -i '' '/registry.npmjs.org/d' ~/.npmrc
   ```

8. Post-publish: `npx tsx scripts/smoke-test-published.ts @skillsmith/<pkg> <version>`

**Never** publish a consumer before its dependency. **Never** publish with an exact-pinned workspace dep (use `^` prefix). Workspace resolution masks version-pin errors locally — only fresh `npm install` from the registry reveals mismatches. See [retro: mcp-server@0.4.5](docs/internal/retros/2026-03-19-mcp-server-0.4.5-hotfix.md).

**Note**: `packaging-test.yml` (weekly CI) installs from local tarballs, not the npm registry. It does NOT catch version-pin-against-unpublished-npm scenarios. The post-publish smoke test (`scripts/smoke-test-published.ts`) is the only check that exercises actual npm resolution.

---

## VS Code Extension

Published to [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=skillsmith.skillsmith-vscode) as `skillsmith-vscode` (unscoped — vsce rejects `@skillsmith/` prefix). No Docker required (ADR-113).

```bash
cd packages/vscode-extension
npm run build                    # esbuild bundle
npm run package:check            # Validate VSIX contents
varlock run -- sh -c 'npx @vscode/vsce publish --no-dependencies --pat "$VSCE_SKILLSMITH"'  # Publish
```

**CI publish**: `gh workflow run publish-vscode.yml -f dry_run=false` — see [vscode-publishing-guide.md](.claude/development/vscode-publishing-guide.md).

**PAT**: `VSCE_SKILLSMITH` in `.env` (Varlock), `VSCE_PAT` in GitHub Actions. 90-day rotation.

**Changelog**: user-facing only — no `SMI-xxxx`, PR #, ADR, or GitHub issue refs. Ships on the Marketplace "Changelog" tab. See [vscode-publishing-guide.md § Changelog Authoring](.claude/development/vscode-publishing-guide.md#changelog-authoring).

---

## Skills & Embedding

**Project skills** (`.claude/skills/`): [governance](.claude/skills/governance/SKILL.md) (standards enforcement), [worktree-manager](.claude/skills/worktree-manager/SKILL.md) (parallel development).

**User skills** (`~/.claude/skills/`): linear, mcp-decision-helper, flaky-test-detector, version-sync, ci-doctor, docker-optimizer, security-auditor, session-cleanup (end-of-session housekeeping — `/session-cleanup`).

**Embedding**: Real ONNX (~50ms) or mock (<1ms, `SKILLSMITH_USE_MOCK_EMBEDDINGS=true`). See [ADR-009](docs/internal/adr/009-embedding-service-fallback.md). Auto-update check: `SKILLSMITH_AUTO_UPDATE_CHECK=false` to disable.

---

## Session Priming (SMI-4451)

A `SessionStart` hook (`scripts/session-start-priming.sh`) writes a transient priming index to `/tmp/session-priming-${SESSION_ID}.md` and pipes the same content into initial context as `additionalContext`. Fires only on `source=startup` and `smi-*`/`wave-*` branches; otherwise no-op. The transient file is mode 0600 and swept after 24h. Disable with `SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING=1`. The underlying retrieval index lives in `packages/doc-retrieval-mcp/`.

**Per-class rank boost (SMI-4468)**: `rerank.ts` multiplies similarity by 1.5x for `class: feedback`/`project` chunks and 0.85x for `class: wave-spec`/`plans-review` chunks before applying absorption/supersession penalties. Tunable via `SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY` and `SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS` (clamped to [0.1, 5.0]).

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
| Symlink outside skills root skipped (SMI-4287) | LocalFilesystemAdapter rejects symlinks whose target resolves outside `rootDir` (GitHub #600). Set `allowSymlinksOutsideRoot: true` in `LocalFilesystemConfig` to opt in; caller accepts the security tradeoff. |

**Detailed diagnostics** (Symptoms / Root Cause / Fix): [docker-guide.md](.claude/development/docker-guide.md#troubleshooting)

---

## Key References

| Category | Documents |
|----------|-----------|
| Architecture | [System Overview](docs/internal/architecture/system-design/system-overview.md), [Skill Dependencies](docs/internal/architecture/system-design/skill-dependencies.md), [Index](docs/internal/architecture/index.md) |
| Standards | [Engineering](docs/internal/architecture/standards.md), [Database](docs/internal/architecture/standards-database.md), [Astro](docs/internal/architecture/standards-astro.md), [Security](docs/internal/architecture/standards-security.md) |
| Process | [Context Compaction](docs/internal/process/context-compaction.md), [Linear Hygiene](docs/internal/process/linear-hygiene-guide.md), [Wave Checklist](docs/internal/process/wave-completion-checklist.md) |
| Development | [Docker](.claude/development/docker-guide.md), [Git-Crypt](.claude/development/git-crypt-guide.md), [CI](.claude/development/ci-reference.md), [Deploy](.claude/development/deployment-guide.md), [Ruflo](.claude/development/claude-flow-guide.md) |
| Testing | [Stripe](.claude/development/stripe-testing.md), [Neural](.claude/development/neural-testing.md), [Benchmarks](.claude/development/benchmarks.md) |
| Billing | [Admin Grants](docs/internal/runbooks/admin-complimentary-subscriptions.md), [Stripe Ops](docs/internal/runbooks/stripe-operations.md) |
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
NEVER say "worth a note for next time" or "consider X in future". If something is worth noting, act on it immediately: create the Linear issue, update the doc, fix the config. Observations without immediate action are noise.
After context compaction or session continuation, ALWAYS verify claimed-complete work by reading the actual files before proceeding. Never trust the summary alone — compaction can conflate "planned" with "implemented".
After EVERY commit, run `/governance` to review the changed code. Resolve ALL issues it surfaces before pushing. No exceptions — do not skip, defer, or downgrade findings.
After EVERY commit, update the relevant Linear issue(s) in the Skillsmith initiative (SMI-xxx) to reflect progress. Add a comment with the commit SHA and a brief summary of what changed. Move the issue status forward if the commit completes the work (e.g., "In Progress" → "Done"). If no Linear issue exists for the work, create one under the appropriate project before pushing.
After EVERY PR is merged, run `/governance` as a retrospective on the full PR diff. Resolve ALL issues it surfaces immediately — create follow-up commits or Linear issues as needed. Do not close the session until the retro is clean.
After the governance retro, update any `index.md` files in directories where files were added or removed during the PR. Check `docs/internal/`, `.claude/development/`, and `.claude/templates/`. If the root `docs/internal/index.md` folder counts have drifted, update those too.
