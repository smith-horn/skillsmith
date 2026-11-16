# Claude Code Configuration - Skillsmith

## Sub-Documentation

Detailed guides extracted via progressive disclosure. CLAUDE.md contains essentials; sub-docs contain deep dives.

| Document | Description |
|----------|-------------|
| [docker-guide.md](.claude/development/docker-guide.md) | Container rebuild scenarios, DNS failure, native modules, troubleshooting |
| [troubleshooting.md](.claude/development/troubleshooting.md) | Symptom-to-fix recipes for every Troubleshooting symptom listed in CLAUDE.md (SMI-7219) |
| [git-crypt-guide.md](.claude/development/git-crypt-guide.md) | Unlock, worktree setup, hooks-in-worktrees, Docker bind-mounts (SMI-4689/4738), pre-push (SMI-4767), rebase workaround, smudge filter fixes |
| [ci-reference.md](.claude/development/ci-reference.md) | Branch protection, change classification, Turborepo, npm overrides, release-PR `Package Validation`, vitest split rationale |
| [deployment-guide.md](.claude/development/deployment-guide.md) | Edge function deploy, CORS, website, full monitoring & alerts table |
| [branch-management.md](.claude/development/branch-management.md) | Pre-commit auto-restore prose, post-commit fallback recovery, direct-to-main SQL rule (SMI-2598) |
| [edge-function-patterns.md](.claude/development/edge-function-patterns.md) | Function-auth matrix, project refs, auto-deploy mechanics |
| [mcp-tools-guide.md](.claude/development/mcp-tools-guide.md) | Team-tool resolution chain (SMI-4312/ADR-116), CLI surface (SMI-4590) |
| [publishing-guide.md](.claude/development/publishing-guide.md) | Local-fallback deprecation (SMI-4533), publish-order rationale, version-pin rules |
| [claude-flow-guide.md](.claude/development/claude-flow-guide.md) | Agent spawning, swarm orchestration, hive mind, SPARC modes; `scripts/mcp-ruflo-launcher.sh` (guard checks, exit codes) serving the dedicated `skillsmith-ruflo-1` compose service (ADR-170) |
| [cloudinary-guide.md](.claude/development/cloudinary-guide.md) | Blog image upload workflow, URL transforms, folder conventions |
| [vscode-publishing-guide.md](.claude/development/vscode-publishing-guide.md) | VS Code Marketplace publishing, local/CI workflow, PAT rotation |
| [subagent-tool-permissions-guide.md](.claude/development/subagent-tool-permissions-guide.md) | Subagent tool access by type, foreground/background behavior, skill author checklist |
| [supabase-migration-safety.md](.claude/development/supabase-migration-safety.md) | Pre/post-apply query catalog, ACCESS EXCLUSIVE locks, rollback, pooler, R-Grant explicit grants (SMI-7151). Invoke via `supabase-migration-reviewer` skill |
| [ruvector-dev-tooling.md](.claude/development/ruvector-dev-tooling.md) | `skillsmith-doc-retrieval` MCP (SMI-4417) — local semantic doc search, post-commit hook, token-delta gate |
| [skill-invoke-telemetry-guide.md](.claude/development/skill-invoke-telemetry-guide.md) | Skill-invocation telemetry pipeline (SMI-5012) — wire format, consent gate, dispatcher coverage, rotation policy |
| [smoke-prod-guide.md](.claude/development/smoke-prod-guide.md) | Post-deploy smoke harness (SMI-4459) — surface manifest, failure triage, phase rollout |
| [vercel-deploy-hook.md](.claude/development/vercel-deploy-hook.md) | Vercel→GitHub `repository_dispatch` triggering `smoke-prod.yml` post-deploy |
| [e2e-staging-runbook.md](.claude/development/e2e-staging-runbook.md) | `device-login-roundtrip.yml` (SMI-4460) — secret rotation, Docker carve-out, prod-ref grep gate |
| [eval-cron-setup.md](.claude/development/eval-cron-setup.md) | Canonical-dev retrieval-eval cron (SMI-4764 W2) — launchd/systemd, heartbeat, replacement protocol |
| [edge-function-attribution-queries.md](.claude/development/edge-function-attribution-queries.md) | Canonical pooler queries for edge function attribution monitoring (SMI-4370 / Wave 4d) |
| [concurrency-patterns.md](.claude/development/concurrency-patterns.md) | Pattern-to-incident-to-canonical-fix index for the six `concurrency-auditor` patterns (SMI-4895/4896/4861/4887/6428) |
| [guards-and-opt-outs.md](docs/internal/process/guards-and-opt-outs.md) | Canonical Guards & Opt-Outs registry (guard → trigger → marker → disable var → scope) — SMI-5418 DoD #5 |
| [upstash-redis-operations.md](docs/internal/runbooks/upstash-redis-operations.md) | Upstash Redis architecture (4 consumers), setup, credential rotation, health-check monitoring |

**Implementation plan template**: [.claude/templates/implementation-plan.md](.claude/templates/implementation-plan.md) — use this structure for all plans in `docs/internal/implementation/`.

---

## Docker-First Development

**All code execution MUST happen in Docker** for any path that loads native modules (`better-sqlite3`, `onnxruntime-node`, etc.). Native modules require glibc — see [ADR-002](docs/internal/adr/002-docker-glibc-requirement.md), whose scope is narrowly the choice of `node:22-slim` over Alpine, *not* a project-wide mandate that every CI job run in Docker.

**CI carve-out (SMI-4647)**: one pure-JS job runs on the host runner — `quality-checks` (bundles lint + typecheck + audit:standards since SMI-4908, and the audit report artifact since SMI-7174 retired `code-review`). New jobs default to Docker; opt-in requires `# audit:carveout-pure-js` marker. Full rationale: [ci-reference.md § Docker-First CI Carve-out](.claude/development/ci-reference.md#docker-first-ci-carve-out-smi-4647).

```bash
docker compose --profile dev up -d                    # Start container (REQUIRED first)
docker exec skillsmith-dev-1 npm run build             # Build
docker exec skillsmith-dev-1 npm test                  # Test
docker exec skillsmith-dev-1 npm run lint              # Lint
docker exec skillsmith-dev-1 npm run typecheck         # Typecheck
docker exec skillsmith-dev-1 npm run audit:standards   # Standards audit
docker exec skillsmith-dev-1 npm run preflight         # All checks before push
```

**From a worktree (SMI-5559)**: the `docker exec skillsmith-dev-1 <cmd>` form above is for the **main checkout only** — its container is long-lived, so that exact command silently "succeeds" from any worktree even if the worktree's own container never started. From `.worktrees/<name>/`, use `./scripts/worktree-docker.sh exec -- <cmd>` instead — it resolves the container matching your actual cwd and errors loudly (not silently) if it isn't running, e.g. `./scripts/worktree-docker.sh exec -- npm run preflight`. **Starting the container is the same trap (SMI-4298, retro 2026-08-25)**: a bare `docker compose --profile dev up -d` in a worktree publishes an EXTRA host port 3001 alongside the worktree's own bucketed pair (Compose concatenates `ports:` across `-f` files rather than replacing them), colliding with the main checkout's `skillsmith-dev-1` if it's already running. Use `./scripts/worktree-docker.sh start` instead — it exports `DEV_PORT` from the worktree's own override before `up`, so no extra port is published and no manual `.env` `DEV_PORT=` hack is needed.

**`git push` from a worktree (SMI-5570/SMI-5074)**: pre-push routes through **this worktree's own dedicated container**, not `skillsmith-dev-1` — an earlier default (SMI-5548) routed through main's shared container reached via the worktree's nested path, which silently tested main's own dependency state instead of the worktree branch's own (a Docker `mount(2)` behavior, not macOS-specific). Start this worktree's container before pushing (`./scripts/worktree-docker.sh start`, not a bare `docker compose --profile dev up -d` — see the SMI-4298 note above); pre-push hard-fails with the exact remediation command if it isn't running, unless the push is docs-only or you opt out with `SKILLSMITH_PRE_PUSH_HOST=1` (one push) or `SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1` (registered in [guards-and-opt-outs.md](docs/internal/process/guards-and-opt-outs.md)).

**After pulling**: post-merge never installs (SMI-6614, ADR-158). If it prints one info line, the lockfile change was cosmetic and there's nothing to do. If it prints a refresh sequence, a real dependency changed: run that sequence yourself from the main checkout, in order, and don't substitute a bare `npm install` on the host or in a container. **Full rebuild** (native modules, major upgrades): [docker-guide.md](.claude/development/docker-guide.md#full-rebuild-thorough). **Stop**: `docker compose --profile dev down`. **Logs**: `docker logs skillsmith-dev-1`. **Submodule**: `git submodule update --init` before `docker compose up` if internal docs needed inside container.

**Auto-recovery (SMI-5245)**: the `dev` service sets `restart: unless-stopped`, so the container comes back on its own after a Docker Desktop / machine restart — this keeps the `skillsmith-doc-retrieval` + `skillsmith` MCP servers (launched via `docker exec` in `.mcp.json`) from silently dropping with a `-32000` reconnect error. An explicit `docker compose --profile dev down` or `docker stop` is still honored (stays down). If you ever see the container *restart-looping* after a reboot, it hit a degraded environment (wiped volume / ABI mismatch) — run the **Container won't start** Troubleshooting recipe. **Both MCP servers require the container to be running** — there is no fallback path; if the container is down, `/mcp` will report `Failed to reconnect` and all MCP tools will be unavailable until `docker compose --profile dev up -d` is run.

**After a fresh clone**: run `docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install && npm run build'` before the `skillsmith` MCP server can connect (after a *volume wipe* use the **Container won't start** Troubleshooting row and the ordered refresh sequence instead — a wiped root volume re-seeds from the image rather than coming back empty, SMI-6674) — exit non-zero with no npm/build output means at least one of the container's node_modules paths (root, or a `packages/*/node_modules`) isn't currently mounted with a volume-shaped root (SMI-6516/SMI-6520/SMI-6614), so the container needs recreating first (`docker compose --profile dev up -d --force-recreate dev`, from the main checkout), not another install attempt. Both MCP servers now have their own preflight launcher: `skillsmith` via `scripts/mcp-skillsmith-launcher.sh` (SMI-5049) and `skillsmith-doc-retrieval` via `scripts/mcp-doc-retrieval-launcher.sh` (SMI-5718) — each prints actionable stderr in the `/mcp` panel's per-server log when `node_modules/` or `dist/` is missing, or when a runtime dependency is corrupt/unresolvable (e.g. an empty nested `node_modules` dir shadowing the hoisted copy after an interrupted npm install, SMI-5451/SMI-5452) — surfaced when you expand the failing entry. `skillsmith-doc-retrieval` additionally checks that the `skillsmith-dev-1` container itself is running before it tries to `docker exec` into it (it is Docker-only — native module `better-sqlite3`).

---

## CI Health Requirements

Zero ESLint warnings/errors. TypeScript strict (no unjustified `any`). All files Prettier-formatted. 100% test pass. No high-severity vulns. **<500 lines/file** — the **blocking** gate is pre-commit, not CI: `lint-staged.config.js` routes every staged `*.{ts,sh}` through `scripts/check-file-length.mjs`, which hard-fails (exit 1) on any file over the limit outside `scripts/check-file-length.ignore`. `audit:standards` Check 3 is the CI-side *observer* of the same policy and only `warn()`s, and only over `packages/` + `apps/` — so a `.mjs`, a `scripts/` file, or anything committed with `--no-verify` can land over-limit with CI green (threshold + test-file exemption are shared via `scripts/file-length-policy.mjs`; the scope/severity divergence is deliberate and tracked in SMI-5994). Split into `foo.helpers.ts`/`foo.types.ts` if approaching, or — for a command whose `withTelemetry`-wrapped action handlers push it over — a `foo.action.ts` sibling holding the impls + wrapped exports while `foo.ts` keeps the commander factory, SMI-5127+). >80% coverage. Source-file changes must include related test updates — for a new SQL migration extending an existing mechanism, check whether the thing it extends already has a dedicated test file (e.g. a sibling claim/heartbeat/GC function set) and add the matching coverage; a SQL-correctness-focused adversarial review round will check the logic without ever flagging that it's untested (SMI-6015 retro).

**When CI fails**: don't merge. Run `docker exec skillsmith-dev-1 npm run preflight` locally. Linear issue if non-trivial.

**Concurrency prevention (SMI-4891/4892/4902)**: shared-state / race-condition gating via the `concurrency-auditor` skill (Mode A plan-audit, Mode B diff-audit) and the `concurrency-audit-pr.yml` PR workflow, which comments on findings but does not block a merge (its gate is still non-blocking; the flip to blocking is tracked in SMI-5591). Lazy-helper convention for browser globals (`window.__SUPABASE_CLIENT__` reads only via `getSupabaseClient()`) enforced by the `no-raw-window-global` ESLint rule. Pattern reference + canonical-fix PRs: [concurrency-patterns.md](.claude/development/concurrency-patterns.md). Opt-out marker: `[concurrency-audit-ack]` in PR body (boolean shape, reason as prose paragraph).

**A fix for a race condition needs its own confirmation review round, not just the round that found it (SMI-6015 retro).** The fix for one race can introduce a second, more subtle one — a round-2 adversarial-review fix for a GC-vs-active-claim abandonment race introduced a round-3 finding (a Postgres READ COMMITTED snapshot-staleness gap) inside that same fix, which a single additional confirmation pass caught. After any race/lock/CAS-shaped fix, run at least one more adversarial-review round scoped narrowly to the fix itself before trusting it — don't stop at the first clean pass.

**A regression test you have not run against the unfixed code is unverified. Revert the fix, confirm the test FAILS, restore (SMI-6598).** **And confirm it fails for the stated reason.** A mutation that fails in unrelated compilation, module loading, setup, mocking or test infrastructure turns the suite red while proving nothing, and in any summary that red is indistinguishable from a real one. **Declare the expected failure before you mutate, then confirm it arrived that way** — a reviewer who mutates first and reads whatever red appears will find a reason it counts. For a runtime mutation, confirm from the full failure and its stack that execution reached the intended observation and failed there because of the mutation; for a type-level mutation, confirm the expected diagnostic lands at the intended site, where execution never reaches a runtime observation and need not. Never classify from the summary string: a correct assertion failure may read generically, and an unrelated one may name the mutated identifier by coincidence. An experiment you cannot repair leaves the assertion unverified, not passed (SMI-6932). A green suite proves the tests pass; it does not prove they constrain anything. Three tests written to pin a fix in SMI-6598 passed identically with that fix removed — each used a value that was syntactically valid but changed no outcome, so it exercised the code without testing it. That is the same invisible-success class as the defects the tests existed to catch, and the only thing that distinguishes a real test from a decorative one is watching it fail. This generalises the race-fix rule above: **a fix for any silent-success path is itself a silent-success risk**, because the new code's failure mode is the same silence it was written to remove. **Watching it fail is necessary, not sufficient (SMI-6497, 2026-09-15).** The author picks the mutation, so the author's blind spot picks it too. SMI-6497 needed four encodings to pin four command-line flags -- `"$*"`, then `|`-delimiters, then whole-line matching, then per-record validation -- and every one of them passed its author's own red-test before a cross-family reviewer named an attack class the author had not imagined. So: red-test your own work, then have someone who did not write it name the mutation you would not have chosen. When a reviewer finds a defect *inside* your fix, expect the next round to find one inside that fix -- three consecutive rounds did on SMI-6497. Don't assume they converge: each round's own fix -- prose included -- gives the next round new material, so set the stopping rule before a round runs, not after seeing what it found (SMI-6651). **Assert the property that makes the code correct, not the value a correct implementation happens to emit (SMI-6732, 2026-09-19).** Those agree until someone changes the implementation, which is the moment a regression test exists for. A cross-family mutation hunt replaced `randomBytes(16).toString('hex')` with a constant and 6,454 tests stayed green, because the assertion matched the 32-hex *shape* rather than requiring two park names to *differ* -- and unpredictability is the whole reason that rename makes a recursive delete un-raceable. Eleven same-family rounds, two of them specifically about races, had not checked it. The tell: a test that would still pass if the code computed its value some other way is pinning an output format, not a behaviour. **And the converse case has its own trap: a passing test can be pinning the defect, so your fix breaking it looks like a regression (SMI-6733 and SMI-6744, independently, 2026-09-28).** A test that reaches the behaviour under test *through* the buggy path passes only while the bug is present — fix the bug and it goes red, which invites you to revert the fix or weaken the assertion. Both instances that day had the same shape: the test's *trigger* depended on a write that should never have happened, while its *assertion* was correct and worth keeping. So when a fix turns a green test red, ask what the test does to reach its assertion before you touch either: if the trigger rides on the defect, re-point the trigger and leave the assertion alone — then prove the new trigger still drives the assertion by disabling it and watching the test fail, because a re-pointed trigger that silently never fires passes forever while asserting nothing.

**Measure, don't reason. A checkable claim about behaviour gets executed before it enters a plan, an issue, a commit message or a PR body (SMI-6505 retro, 2026-09-10).** Plausibility is not evidence, and a confident wrong claim costs more than an open question. SMI-6505 holds the case tables and rejected drafts from the wave that produced this rule.

Three habits carry most of the value:

- **Execute predicate/regex/precedence claims against a case table, in the actual runtime**, before writing the mechanism down — `node -e` for JavaScript, but a shell, SQL, PCRE or RE2 predicate must be tested with its actual engine, since engines can differ on the very edge cases a case table exists to probe. Include the negative cases: a draft that handles the reported input correctly can still fail one nobody has written down yet. That is how each rejected attempt in SMI-6505 got caught.
- **Prefer a direct test of the property over an inference from metadata.** A mount flag is an inference; a successful write at the exact target path demonstrates that that operation succeeds in that context — and no more, since a failure can also mean permissions, path resolution or quota rather than a read-only mount. Container metadata reporting a path writable while a real write to it returned `EROFS` is the case that motivated this — so check the write call's own result and errno, not the mount table. **And a direct test has three blind spots of its own.** It can be satisfied by a **fallback**: a probe that exercises the feature passes when a silent degraded path serves it, so assert the mechanism, not the outcome. It is true only **at the instant it ran** — a state a probe confirmed can change before the work using it finishes, so a clean probe before a long operation is not evidence about that operation (SMI-6516 measured a container healthy, then degraded **within** 42 minutes, with no restart in between -- the window is an upper bound on the interval, not a measured point). And it can be **answering a different question than the one asked**: the same-shaped command returns a different answer about the same tree at the same moment depending on which directory it ran from, what its own matcher syntax actually supports, or which of several inconsistent conventions its output mixes — and a probe that would return a plausible-looking value whichever of the two states it exists to distinguish is true is not a test of either one. Check the instrument hardest when the number looks cleanest, because a wrong instrument returns a plausible answer, never a visibly broken one (SMI-6488 holds the measured instances; SMI-6720 holds the cleanest single one, a grep that returned 0 for the very design it was used to veto). When the **first two** blind spots cannot be ruled out, the reliable postures are continuous observation, after-the-fact attribution at the point of failure, or making the operation itself fail loudly rather than fall through; [ADR-165](docs/internal/adr/165-detecting-unpreventable-environment-degradation.md) chooses among them for the environment-degradation case. None of those three reaches the **third** blind spot, and "fail loudly" is the wrong instinct for it — a wrong instrument does not fail; it answers. Its own remedy is below.
- **Never conclude from truncated output.** `| head`/`| tail` can hide the decisive line, and it changes which exit status you see: a POSIX pipeline's status is its **last** command's, so `git push … | tail -3` can report 0 when the push failed. **Capture the producer's output and status separately** — run it to completion, save the status immediately, truncate only when displaying. `set -o pipefail` is not a general substitute: it was standardised only in POSIX Issue 8 (2024) so support varies by shell, and with an early-closing consumer like `head` it can report failure for a producer that was fine.

- **Measure reachability separately from mechanism.** Verifying every frame of a call chain establishes that a defect's *mechanism* is real and says nothing about whether anything calls the outermost frame — so a severity derived from a correctly-verified mechanism can still be wrong by the whole distance between "this code would destroy every record" and "no user can reach it." Before writing or accepting a severity, check that the entry point has a production caller, and check it like the negative claim it is, with a known-positive control. This is not the same failure as the ones above: every individual measurement can be correct and the conclusion still unfounded, because the gap is in the question set rather than the rigour. SMI-6733 holds the case — an Urgent data-loss issue whose description had been re-derived line by line, whose destructive path sat inside a function that four separate repo locations already recorded as having no caller, one of them a docblock four lines above the signature being read.

**A wrong disproof is worse than the original claim**, because it closes a line of inquiry that was correct: hold retractions to a higher evidentiary bar than the claims they retract. That obligation binds the **reader** too, and the bias has a direction. Truncation can only *manufacture absence* — `head` hides an entry, it never invents one — so a negative claim ("X is not present", "there is no Y") is simultaneously the least likely to be re-checked and the most likely to be corrupt. Re-derive a load-bearing negative from the artifact before writing it into a durable record, whoever stated it, and note that flagging a claim "unverified" does not transfer that obligation to the next reader (SMI-6488 instance 12, 2026-09-18). And when something genuinely cannot be checked, say so and name what was not investigated — an open gap is correct, a plausible story filling it is not. The third blind spot has one remedy, and it is not denominator reporting: **run the probe against a known-positive and a known-negative before trusting its verdict.** An instrument that returns the same value for both is measuring nothing, and no amount of scope reporting reveals that — a perfectly-scoped check against the wrong subject is still wrong, and will happily report the population it examined. Denominator reporting is the remedy for the narrower *scope* problem (a check that ran over the wrong or empty file set), which is a different failure with a different fix; SMI-6488 separates the two deliberately and records that scope reporting does not detect a wrong subject. Both rules are worth having. Do not let one stand in for the other. This rule itself has no enforcement surface and binds by recall, like the rules covered by § Important Instruction Reminders' own enforcement-status note.

**Durable rules instruct; they don't describe.** In an always-loaded file, write the instruction and leave the evidence in the tracking issue. An instruction stays correct as the system changes around it; a factual claim about the system — a version, a line number, a commit SHA, an exit code, a count, a file path — begins rotting the moment it is written, and nothing in the file tells a later reader which claims have gone stale. So when a rule seems to need evidence before it will be believed, cite the issue holding that evidence rather than restating it here. The same applies to an issue's own description: correct it in place when it goes stale, because a correction added below a wrong description leaves two surfaces disagreeing, and the wrong one is read first.

**Post-deploy smoke (SMI-4459)**: `smoke-prod.yml` runs `scripts/smoke-prod.sh` against prod after each merge. Failure → Linear + email. Skip: `[skip-smoke]` in PR body. [smoke-prod-guide.md](.claude/development/smoke-prod-guide.md).

**Build**: Turborepo (`npm run build`); legacy fallback `npm run build:legacy` ([ADR-106](docs/internal/adr/106-turborepo-build-orchestration.md)). **Change tiers**: `docs` ~30s, `config` validation, `code` ~11 min full, `deps` rebuild+audit. **Branch protection**: the declared required-check set is `.github/branch-protection.json` — **read it; never trust a count written anywhere else, including here.** `--fix` applies that FILE to GitHub via a whole-object PUT, so a stale or incomplete file *removes* protection rather than adding it; never run it to "repair" protection without first diffing the file against live. `scripts/validate-branch-protection.sh --dry-run` compares a strict subset — `required_status_checks.contexts` and `.strict`, plus `enforce_admins`, `allow_force_pushes`, `allow_deletions` — and nothing else, so it is not a full arbiter; read the script, not a tally of it. Docs-only PRs require a smaller subset. What the file does and does not guarantee: [ci-reference.md](.claude/development/ci-reference.md); gaps tracked in SMI-6968. **npm overrides, release-PR `Package Validation` (which passes — there is no carve-out and no `--admin` path, SMI-4920), vitest split rationale**: [ci-reference.md](.claude/development/ci-reference.md).

**Dependabot lockfile stability (SMI-5272)**: the root `jose: "5.10.0"` devDependency was added as an anchor for an otherwise optional-peer-only `jose@5.10.0` reachable via `ruflo → @claude-flow/cli → fastmcp`, pinned as a regular root edge so Dependabot's lockfile regen couldn't drop it. **SMI-6744 Wave 4 removes the root `ruflo` devDependency (Checkpoint 4 row 5)**, so the `fastmcp` edge is gone from the lockfile; the host tree follows at the post-merge refresh, after which the root `jose` copy is an ordinary hoisted dependency of `@vercel/oidc` (`^5.9.6`). The anchor is kept anyway — removing it is a separate lockfile change from Wave 4's — and if Dependabot or `npm ci` ever fails with `Missing: jose@5.10.0 from lock file`, the fix is still to restore it. Root cause + manual-consolidated-bump fallback: [ci-reference.md § Dependabot lockfile regen](.claude/development/ci-reference.md).

---

## Project Overview

Skillsmith is a registry for sharing, scanning, and tracking agent skills (discovery, installation, updates, and management), delivered as an MCP server, CLI, and VS Code extension. Packages: `@skillsmith/core` (DB, repositories, services), `@skillsmith/mcp-server` (MCP tools), `@skillsmith/cli`. License: [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) — all packages, source-available ([ADR-119](docs/internal/adr/119-unified-elastic-license.md)). Quick Start: [README](README.md).

| Tier | Price | API Calls/Month |
|------|-------|-----------------|
| Community | Free | 100 |
| Individual | $9.99/mo | 1,000 |
| Team | $25/user/mo | 10,000 |
| Enterprise | Custom (unpublished, "Contact Sales") | Unlimited |

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

**Syncing main**: `./scripts/sync-main.sh` (quiet, ~75 tokens vs ~5k git-crypt noise). Then `git checkout -b <branch-name>`. If it refuses, follow its `next:` line. Never resolve a sync refusal with `git reset --hard`, `git stash`, or by checking out a branch you did not create ([ADR-184](docs/internal/adr/184-shared-main-checkout-fast-forward-only.md)).

**Branch naming**: `<type>/<slug>` — `feature/`, `fix/`, `chore/`, `docs/` (matches the commit-type prefixes). Do not prefix branches with a personal username (e.g. `ryansmith108/...`); a growing number of `ryansmith108/`-prefixed branches has drifted from this convention and should be renamed/avoided going forward. **Never embed any person's name anywhere in a branch name** — not as a prefix, and not in the descriptive slug either (e.g. a plan triaging an external reporter's bug report should branch as `docs/cursor-integration-readiness-plan`, not `docs/<their-handle>-cursor-integration-plan`). Describe the *work*, not *who* is attached to it. This persists on GitHub even after the branch is deleted — a merged PR's head-ref name is immutable history, so catch this before the first push, not after (SMI-5893 retro, 2026-07-30: a plan-triage branch briefly carried the reporting tester's GitHub handle; caught and renamed before it reached the remote, but a same-shaped mistake already landed in that PR's commit body and is now permanent). Linear's own auto-suggested `gitBranchName` field prefixes branches with the assignee's username (e.g. `ryansmith108/smi-5893-...`) — don't copy that suggestion verbatim; follow the `<type>/<slug>` convention above instead.

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

**Tooling**: MCP Linear tools when connected; fallback `varlock run -- node scripts/linear-api.mjs` (never `npm run linear:done` — broken). Team: **Smith Horn Group**. Always set `project` + a detailed description + labels on issue creation.

**This one rule is already machine-checked at three layers** — don't rely on remembering it, but do know all three are still *warn-only*: (1) `scripts/linear-issue-creation-guard.mjs`, a `PreToolUse` hook on `mcp__linear__save_issue` **create** calls (SMI-5846); (2) `scripts/linear-api.mjs create-issue`'s own gate on the CLI fallback path (SMI-5853, bypass `--force`); (3) `.github/workflows/lint-linear-issues.yml`, a daily CI backstop catching whatever slipped past both (SMI-5841). All three validate against the same contract in `scripts/lib/linear-issue-validation.mjs`, and **all three ship shadow-default (warn, never block) with a shadow-end review target of `2026-08-09` that has already lapsed** — so today a non-compliant issue is *reported*, not *prevented*. Disable vars for each are registered in [guards-and-opt-outs.md](docs/internal/process/guards-and-opt-outs.md). Everything else in this section (comment-per-commit, status advance, project update per PR) has **no** enforcement surface at all — see the § Important Instruction Reminders note below. Full conventions: [linear-hygiene-guide.md](docs/internal/process/linear-hygiene-guide.md).

---

## Varlock Security

**All secrets via Varlock. Never expose API keys in terminal output.** Commit `.env.schema` (defines `@sensitive`) and `.env.example` (placeholders); **never** `.env`. Run with secrets: `varlock run -- npm test`. Validate: `varlock load` (default pretty format — masked) or `varlock load --quiet` (validation only). **Never** `varlock load --format json` / `json-full` / `json-full-compact` / `env` — those emit **unmasked** values. This ban and the file-read ban below are **enforced, not advisory**: `scripts/env-read-guard.mjs` runs as a `PreToolUse` Bash hook and *denies* the call (it unwraps `sudo` / `docker exec` / `docker compose` / `varlock run --` wrappers first, so neither a wrapper nor argument reordering evades it). See the `[env-read-guard]` Troubleshooting row for the false-positive escape hatch. **Never** read the contents of `.env`, `.env.registry`, or any `.worktrees/**/.env` via *any* command — `cat`, `grep`, `head`, `tail`, `sed`, `awk`, `less`, `strings`, `xxd`, an inline `python3 -c` / `node -e`, or a `docker exec skillsmith-dev-1 …` wrapper around any of them (the repo root is bind-mounted at `/app`, so `/app/.env` is the same file). **Never** `echo $SECRET`. The one sanctioned exception is an output-free presence check — `grep -qE '^KEY=' .env` (exit code only, no content). `.env.schema` and `.env.example` are always safe to read. Never ask users to paste secrets in chat. See [AI Agent Secret Handling](docs/internal/architecture/standards-security.md#411-ai-agent-secret-handling-smi-1956).

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
| `skill_compare` | Compare two skills side-by-side |
| `skill_suggest` | Suggest skills based on current project context (counts against monthly quota) |
| `skill_outdated` | Check installed skills for staleness and dependency status |
| `index_local` | Index skills from a local directory |
| `skill_publish` | Prepare a local skill for publishing |
| `skill_rescan` | Re-scan an installed skill's content |
| `skill_recover_source` | Recover the canonical GitHub source of locally-installed skills (read-only) |
| `inventory_push` | Push this machine's installed-skill inventory to your Skillsmith account for the web dashboard |
| `skill_updates` | Check registry for newer skill versions (Individual+) |
| `skill_diff` | Diff two installed skill versions side-by-side (Individual+) |
| `skill_pack_audit` | Audit all skills in a directory (Individual+) |
| `skill_audit` | Audit skill for security advisories (Team+) |
| `skill_inventory_audit` | Audit every installed AI coding client's skill inventory (plus Claude Code's own commands/agents/CLAUDE.md rules) for local namespace collisions; returns rename + edit suggestions (Community; SMI-4590; multi-client SMI-6077) |
| `apply_namespace_rename` | Apply a rename suggestion from a local namespace-collision audit (`apply` / `custom` / `skip` / `revert`) (Community; SMI-4590; `revert` SMI-5671) |
| `apply_recommended_edit` | Apply a recommended prose edit; gated on `APPLY_TEMPLATE_REGISTRY` (Community; SMI-4590) |
| `undo_apply` | Session-scoped undo of the most recent apply_namespace_rename/apply_recommended_edit changeset(s), restored from the apply tool's own backup (Community; SMI-5456/SMI-5470) |
| `apply_manifest_reconcile` | Repair a corrupted or ambiguous `~/.skillsmith/manifest.json` entry through a supported path — `mark_local` / `relink` / `drop_entry` / `verify` / `revert` (Community; SMI-6343 Wave 4, ADR-144 §6 / ADR-145) |
| `team_workspace` | Manage team workspaces: create, list, get, delete (Team+) |
| `share_skill` | Add, remove, or list skills in a team workspace (Team+) |
| `publish_private` | Mark a skill private on this device, hidden from your own search results (Team+) |
| `team_analytics_dashboard` | Per-user tool usage counts, top tools, daily trend (Team+) |
| `team_usage_report` | Weekly/monthly usage summary with period comparison (Team+) |
| `private_registry_publish` | Publish a skill version to your team's private registry as a pending submission (Enterprise) |
| `private_registry_manage` | List/get/install/deprecate/undeprecate/namespace/submissions/approve/reject on your team's private registry via the `action` parameter (Enterprise) |
| `audit_export` | Export audit log events for a time range (Enterprise) |
| `audit_query` | Query audit logs with filters (Enterprise) |
| `siem_export` | Export audit events for SIEM ingestion (Enterprise) |
| `analytics_dashboard` | Recommendation accuracy, adoption curves, team aggregation (Enterprise) |
| `usage_report` | Comprehensive usage report with all metrics (Enterprise) |
| `configure_sso` | Configure SSO/SAML integration: set, test, remove, claim_domain, verify_domain (Enterprise) |
| `sso_settings` | View current SSO/SAML configuration (Enterprise) |
| `rbac_manage` | Inspect and adjust per-role permissions: `list_roles` / `get_role` / `set_role_permission` / `reset_role_permission` (Enterprise) |
| `rbac_assign_role` | Assign, revoke or list role assignments: assign, revoke, list_assignments (Enterprise) |
| `rbac_create_policy` | Bulk-set, clear or list per-role permission overrides: `create` / `list` / `delete` (Enterprise) |
| `webhook_configure` | Configure HMAC-SHA256-signed webhooks for skill lifecycle events: create, list, get, delete, test, rotate_secret (Enterprise; in preview, SMI-4135) |
| `api_key_manage` | Manage API keys for programmatic access: create, list, revoke, get (Enterprise; in preview, SMI-4135) |
| `compliance_report` | Generate SOC2, CycloneDX SBOM, or JSON compliance reports (Team+) |

**Auth**: Personal API Key (`X-API-Key: sk_live_*`, tier-based), Supabase Anon Key (30/min; one bucket per edge endpoint, shared across all anon-key callers, including every keyless MCP client), No Auth (10 trial, plus a 100/min per-IP cap; any direct HTTP request that fails to authenticate). Configure in `~/.skillsmith/config.json` or `SKILLSMITH_API_KEY` env. Shell exports don't reach MCP subprocesses. Team-tool resolution chain (SMI-4312/ADR-116), trust tiers, CLI surface: see [mcp-tools-guide.md](.claude/development/mcp-tools-guide.md).

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
npx supabase functions deploy registry-sync --no-verify-jwt
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
npx supabase functions deploy private-registry-get --no-verify-jwt
npx supabase functions deploy release-cadence-heartbeat-monitor --no-verify-jwt
npx supabase functions deploy sso-domain-reverify --no-verify-jwt
npx supabase functions deploy indexer-lock-starvation-monitor --no-verify-jwt
npx supabase functions deploy registry-audit-volume-monitor --no-verify-jwt
```

**Gateway-verified auth** (SMI-4291; deploy without `--no-verify-jwt`): `webhook-dlq`, `auth-device-approve`, `auth-device-preview`, `indexer-dispatch` (SMI-4852), `team-invite-send` (SMI-4294), `sync-stripe-email` (SMI-5168), `sync-oauth-email` (SMI-5173), `inventory-upload` (SMI-5389), `purge-inventory` (SMI-5510), `audit-notify` (SMI-5541), `team-sso-manage` (SMI-6204), `sso-link-notify` (SMI-6205). **CORS, auto-deploy & monitoring**: [deployment-guide.md](.claude/development/deployment-guide.md), [edge-function-patterns.md § Auto-deploy](.claude/development/edge-function-patterns.md#auto-deploy).

**New public tables, views and sequences get no API access by default (SMI-7151, ADR-182).** In the migration that creates one, GRANT `service_role` and the client roles explicitly (and `USAGE` on the sequence behind a `serial` column), or mark the relation with an `audit:check-77-ack ... none` reason. Never grant `anon`/`authenticated` `ALL`, `TRUNCATE`, `REFERENCES`, `TRIGGER` or `MAINTAIN`. `audit:standards` Check 77 enforces this; pattern and triage: [supabase-migration-safety.md § R-Grant](.claude/development/supabase-migration-safety.md#r-grant--a-new-relation-with-no-explicit-grants-smi-7151-adr-182).

---

## Supabase Agent-Skills Plugin

The official `supabase/agent-skills` marketplace ships two separate plugins. Only one is team-standard here:

```bash
claude plugin marketplace add supabase/agent-skills
claude plugin install postgres-best-practices@supabase-agent-skills
claude plugin disable supabase@supabase-agent-skills
```

The generic `supabase` plugin is disabled (not uninstalled — `claude plugin enable supabase@supabase-agent-skills` reverts it) because it collides by skill name with this repo's own `supabase` skill and advises against `SECURITY DEFINER`, which conflicts with this schema's deliberate use of `SECURITY DEFINER` helpers to fix RLS recursion (SMI-4306). `postgres-best-practices` has no such conflicts and registers the same bundled MCP server, so nothing is lost by disabling the other one.

SMI-4590's Team/Enterprise tier-gating for the session-start namespace audit covers this automatically (confirmed via code read, SMI-6228: `session-start-audit-helper.ts` calls `runInventoryAudit()`, which calls `scanLocalInventory()` then `detectCollisions()`; the collision detector matches purely on `identifier` and never branches on `client`/`origin`, so a plugin-vs-project collision surfaces through the existing tier-gated audit with no extra wiring). No manual invocation needed on Team/Enterprise; on Community/Individual, invoke `skill_inventory_audit` directly to check for this class of collision.

**The live MCP server `postgres-best-practices` registers (`mcp.supabase.com`) is disabled, repo-wide guidance (SMI-6308).** Confirmed live: Supabase's OAuth grant for this server is fixed at `.well-known/oauth-protected-resource/mcp` (full Management API read/write — `projects:write`, `database:write`, `secrets:read`, `edge_functions:write`, etc.) and cannot be narrowed via the `?features=docs` URL parameter regardless of what it claims to scope; Supabase's own tracker (`supabase/mcp#239`) confirms feature-based scope narrowing isn't implemented upstream. Since this repo only wants the plugin's static skill content (the reference files), not a live server, disable the connector per-project via `/mcp` → toggle the `supabase` (postgres-best-practices) server off — this writes `"plugin:postgres-best-practices:supabase"` into that project's `disabledMcpServers` in `~/.claude.json`, survives plugin updates, and leaves the skill content fully active. **Do this once per worktree** — the disable is per-project-path, not global, even though the plugin itself is enabled globally. `scripts/lib/mcp-command-guard.mjs` now flags any `mcp.supabase.com` entry that isn't disabled, regardless of `features=` value.

---

## Monitoring & Alerts

Scheduled jobs: Skill Indexer, Metadata Refresh, Quota Monitor, the status page, and the shadow-default monitors. Alerts to `support@smithhorn.ca` via Resend on failures; jobs log to the `audit_logs` table; `prod-deploy-cancel-monitor` and `pointer-autorepair` are deliberate exceptions that open GitHub Issues and never write `audit_logs`. Each monitor's cadence, arms, shadow variable and kill switch: [deployment-guide.md § Monitor details](.claude/development/deployment-guide.md#monitor-details-smi-7219). Full schedule table: [deployment-guide.md § Scheduled Jobs](.claude/development/deployment-guide.md#scheduled-jobs). An alert's fix recipe: [troubleshooting.md](.claude/development/troubleshooting.md).

---

## Ruflo MCP Server + MCP Registry

**Ruflo** (hive mind, agent spawning): auto-configured via `.mcp.json`. Tools `mcp__ruflo__{swarm_init, agent_spawn, coordination_orchestrate, swarm_shutdown}`, plus `mcp__ruflo__memory_retrieve`, `mcp__ruflo__memory_delete` (`mcp__ruflo__memory_list` is denied, SMI-7184; SMI-5777 — `task_orchestrate`/`memory_usage`/`swarm_destroy` do not exist in the live registry; `memory_store` and `memory_bridge_status` **do** exist, confirmed against the served build (SMI-6744; tool count and the unclassified `mission_*` tools: `docs/internal/architecture/ruflo-tool-classification.md`), and `memory_store` stays in `.claude/settings.json`'s `permissions.deny` until A6.1 consent — SMI-6744 A1.7). Agent types: architect, coder, tester, reviewer, researcher. Full guide: [claude-flow-guide.md](.claude/development/claude-flow-guide.md). **MCP Registry**: `io.github.smith-horn/skillsmith` on [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/), auto-published via CI; sync `packages/mcp-server/{package,server}.json`. Auth: GitHub Actions OIDC (SMI-4534). Full guide: [mcp-registry.md](.claude/development/mcp-registry.md).

---

## Default Execution Model — Ruflo Queen + Worktrees + Model Tiering

**Default for any substantive, multi-step task: run a Ruflo queen-coordinator hive on a dedicated worktree** (`./scripts/create-worktree.sh`; the parent session is the queen). Trivial or purely conversational turns may run solo on the current branch.

**Worktrees are the default workspace.** Doing implementation work directly on `main` (or in the main checkout) requires an **explicitly approved exception** — state the rationale and get sign-off before proceeding. This keeps parallel sessions from colliding (SMI-4776) and keeps `main` clean. **An approved exception doesn't make uncommitted work in the main checkout safe**: another session in the same shared tree can still discard it (`git reset --hard`, `git checkout -- <path>`, `git checkout -f`) or move it onto the shared stash stack (`git stash`), where any session can pop it. So commit early (a reset can still move a branch past a commit, but the commit stays recoverable from the reflog, and uncommitted edits don't), and move to a worktree the moment the work outgrows a small fix (SMI-6465, SMI-7192).

**A `fork`-type subagent cannot itself act as the queen for model-tiered delegation.** Forks share the parent's context and always run on the parent's model by design, and are barred from spawning their own Agent-tool subagents — so a fork told to delegate work across the model tiers below will instead do all of it itself, in one long single-model run (observed: a fork handed a 4-PR queen-coordination task did exactly this, needing ~250 tool uses and two turn-limit resumes across ~2 hours). If the queen role itself needs to run in the background, keep the top-level/foreground session as the queen issuing model-tiered `Agent` calls directly, or use a fresh (non-fork) background subagent as the queen instead. A fork is still the right call for a single large task that doesn't need further fan-out.

**Route worker tasks by difficulty across model tiers** (the queen assigns each task to the cheapest tier that can do it well):

| Model | Role | Tasks |
|-------|------|-------|
| **Opus** | Hardest reasoning / adversarial | Detection-rule & algorithm design, FP/FN tuning, security & data-integrity design, adversarial review, plan-review, interpreting ambiguous findings |
| **Sonnet** | Core implementation | Feature code, edge<->core twin ports, tests, refactors, harness & report drafting |
| **Haiku** | Mechanical / high-volume | Fixture scaffolding, regression-baseline bumps, CSV/data wrangling, `index.md` edits, drafting Linear comments, doc formatting |
| **Codex (`gpt-5.6-sol` via NEEDLE)** | Cross-provider second opinion / burst capacity | Cross-provider second opinion on an already-drafted Opus design (different model family, not more reasoning depth — Skillsmith-internal adversarial review stays Opus), OpenAI-specific surfaces, burst work under Claude-quota constraints |

**The queen owns all side effects.** Workers/subagents never commit, push, post to Linear, or touch git — they hand their output (file edits, plus any `index.md` or Linear-comment drafts) back to the queen, who verifies and applies it. The `governance-specialist` subagent in particular must never commit to `main` or delete branches (SMI-5060). Foreground subagents only for interactive prompts; background subagents auto-deny unapproved tools. **This rule outranks this file's own blanket "after every commit"/"after every PR merge" instructions below** (incident, 2026-07-20: a subagent explicitly told not to commit/push/PR/merge instead did all four plus a Linear close-out, reasoning from those blanket lines — never filed as its own Linear issue; a prior version of this line miscited "SMI-5778," which is an unrelated npm-audit CI issue from the same day) — a subagent's own task prompt scoping is authoritative for that subagent; the blanket instructions bind only the top-level coordinating session.

**Codex dispatch (SMI-5668, ADR-128).** Codex-tier tasks are never routed through Ruflo or the Agent/Task tool — dispatch via `scripts/needle/dispatch.sh --workspace <worktree> --title ... --body-file ... [--expect-write]`, which shells out to a separately-authenticated `codex exec` process through NEEDLE. Sandbox is read-only, no override; Codex output is text the queen reads and applies, same as any subagent. **A task requiring actual file writes cannot succeed under the current read-only-only adapter** — pass `--expect-write` for write-intent prompts so `dispatch.sh` can detect and flag the sandbox-rejected-write false-success case (SMI-5700) instead of silently reporting success; omit it for analysis/review-only prompts, where "no diff" is the expected outcome. See `scripts/needle/README.md`'s Troubleshooting section for the full mechanism. Not for tasks depending on this session's accumulated context (no shared memory between harnesses), and not for anything a Sonnet/Haiku worker would finish in under ~2 minutes — a defensive default against Codex's own workspace-file auto-discovery surfacing unexpected priming content in an unusual workspace, not an expected per-dispatch tax (see `scripts/needle/README.md`). `dispatch.sh`'s terminal outcomes: `success` is **final** — consume the result, never re-dispatch, even when the results log also carries an incidental `sandbox_write_rejected=yes` note (expected steady-state under the read-only sandbox on an analysis-only prompt, not a partial result). Every other outcome (`blocked-by-sandbox`, `no-diff-despite-expected-write`, `success-without-agent-message`, or an unclassifiable failure) means the queen re-dispatches the task through normal Claude-tier routing rather than treating a Codex-dispatch failure as final. A pre-flight refusal (exit 2 — the target `--workspace` already holds stale `open`/`in_progress` beads, SMI-5847) is **not** a dispatch failure: clear the stale beads (`bf close <id> --workspace <dir>`) or wait for a legitimately concurrent dispatch to finish, then retry the identical dispatch — do not fall back to Claude-tier for an exit-2 refusal. One-time personal setup: `scripts/needle/README.md`.

Full agent catalog, swarm topologies, and hive-mind examples: [claude-flow-guide.md](.claude/development/claude-flow-guide.md); for SPARC methodology (not a v3 CLI subcommand), see the `sparc-methodology` skill.

---

## Publishing Packages

**Release prep**: `docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --all=patch` (also `--core=minor --cli=patch`, `--dry-run`). **Publish (CI-only)**: push the release-prep branch, open a PR, **merge it to `main`**, then `gh workflow run publish.yml -f dry_run=false` — the workflow always dispatches against `main` (no `--ref` defaults to the repo's default branch), never the release-prep branch itself, so publishing before merge silently republishes whatever was already on `main`. Cadence: weekly (Sun 03:00 UTC) OR `[Unreleased]` ≥ 15 entries ([ADR-114](docs/internal/adr/114-release-cadence-and-gh-release-alignment.md)). Order: core → mcp-server, cli, enterprise. **Local fallback isn't just deprecated — it's blocked** (SMI-4533): `scripts/lib/forbid-local-publish.mjs` is wired as `prepublishOnly` in every publishable package and refuses unless the process is a canonical-repo (`smith-horn/skillsmith`) GitHub Actions runner; break-glass is `SKILLSMITH_PUBLISH_OVERRIDE="SMI-NNNN <≥18-char rationale>"`, which appends an audit row to `~/.skillsmith-publish-overrides.log`. Known bypass: `npm publish --ignore-scripts` skips the hook entirely — npm trusted-publisher OIDC is the actual binding gate. Pre-publish checklist, version-pin rules, break-glass: [publishing-guide.md](.claude/development/publishing-guide.md).

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

`SessionStart` hooks fire on `source=startup` for branches containing an SMI/wave token anywhere in the name (`smi-NNN` or `wave-NNN`; covers `fix/smi-…`, `chore/smi-…`, etc — SMI-4809 broadened the matcher from literal-prefix only). Deny list: `main`, `hotfix-*`, `dependabot/*`, `renovate/*`, `release/*`, `revert/*`. **This branch-token gate applies to the priming hook only** — the audit and MCP-guard hooks below fire on every `startup` regardless of branch. **The priming hook additionally fires on `source=compact` and `source=resume`** (SMI-6423) — a second `SessionStart` matcher entry (`"compact|resume"`) runs `session-start-priming.sh` alone, so the banner survives mid-session context compaction and `--resume` instead of only appearing once at the very first `startup`; the audit and MCP-guard hooks deliberately stay `startup`-only (24h-debounced diagnostics, not per-turn context injection — rerunning them every compaction would be pure overhead). Three hooks: priming (`scripts/session-start-priming.sh`, disable via `SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING=1`) + audit (SMI-4590 — Team/Enterprise namespace audit, 24h debounce, fail-soft, tier-gated; disable via `SKILLSMITH_SESSION_AUDIT_DISABLE=1`) + MCP command guard (SMI-5642 — warns on bare-command MCP server configs vulnerable to nvm-drift ENOENT, plus (SMI-6229) hosted MCP servers not scoped to docs-only across this repo's own configs and enabled plugin-installed ones, 24h-debounced per finding, fail-soft; disable via `SKILLSMITH_MCP_COMMAND_GUARD_DISABLE=1`). Three state-consumers surface diagnostics in the priming banner without being hooks: (a) the **auto-heal consumer** reads `~/.skillsmith/retrieval-autoheal.state` to surface a failing host native-binding repair (SMI-5426; disable: `SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE=1`), (b) the **liveness consumer** reads `~/.skillsmith/retrieval-liveness.state` to surface when the telemetry feed is stale (SMI-5432; disable: `SKILLSMITH_RETRIEVAL_LIVENESS_DISABLE=1`), and (c) the **reindex consumer** reads `~/.skillsmith/reindex.state` to surface a failed, anomalous, or hung doc-retrieval reindex (SMI-5786 follow-up; disable: `SKILLSMITH_REINDEX_STALENESS_DISABLE=1`). All three are *consumers of state, not hooks* — the underlying remediation (auto-heal), detection (liveness check), and reindex trigger (`.husky/post-commit`, main-checkout commits only) are driven by their own schedules/triggers (post-merge, weekly eval cron, and main-checkout commits respectively). Full mechanism: [ruvector-dev-tooling.md § Session Priming](.claude/development/ruvector-dev-tooling.md#session-priming-smi-4451).

---

## Troubleshooting

Fix recipes for every symptom below are in [troubleshooting.md](.claude/development/troubleshooting.md). Each bullet is that row's symptom cell, verbatim; search the file for it. A new row goes there, with its symptom added here.

- A `grep`/`head`/`sed`/`cat`/inline-interpreter read of `.env` or `.env.registry` — or a `docker exec … /app/.env` wrapper around one — is denied with an `[env-read-guard]` reason; or Bash calls are blocked with no guard reason at all (SMI-7157)
- `gh pr create`, `node scripts/*.mjs`, or a relative `--workspace`/path CLI argument (e.g. `scripts/needle/dispatch.sh`) fails after an earlier `cd` into a worktree or its `docs/internal` submodule (SMI-5978)
- Scan-coverage alert fired (`scan_coverage_degraded`, SMI-5866)
- `indexer_degraded` alert fired (SMI-6220)
- `indexer_upsert_blocked` alert fired (SMI-7113)
- `indexer_lock_starvation` alert fired (SMI-6209)
- Backfill auto-chain stopped and emailed an alert (SMI-6246)
- Backfill dispatch switch `BACKFILL_AUTOCHAIN_DISABLE` (SMI-7112): the autochain went red on a variable-read failure (an `autochain-read-enable` error line, or the `indexer_backfill_autochain_failed` email), or `backfill-rollout-driver.sh` exits 2 with `must read exactly 1`
- `refresh_unhealthy` alert fired (SMI-7114)
- `refresh_observer_dead` alert fired (SMI-7114)
- Backfill autochain alert fired: `indexer_backfill_autochain_halted`, `_needs_intervention`, `_multiple_deferrals`, `_kill_switch_stop`, `_campaign_complete`, or the pg_cron watcher's `_stalled` / `_unreconciled` / `_resume_dispatch_failed`, or the silent-stop detector's `_silent_stop` / `_dispatch_ambiguous` (SMI-7121, SMI-7142, SMI-7167)
- `fatal: <path>: clean filter 'git-crypt' failed` (worktree creation, `git status`, or `git-crypt unlock` itself hangs/fails with this)
- `npm install`/`npm ci` fails with `EACCES` on a `rename`/`rmdir` under `node_modules` on the HOST (main checkout), even though `ls -la` shows normal ownership/permissions (SMI-6034)
- `npm run build --workspace=packages/website` (or the full `npm run build`) fails in a Docker container with `EACCES, Permission denied '/app/packages/website/.vercel/output/_functions/'`, or `npm run audit:standards` crashes outright with an unhandled `ENOENT` inside `getFilesRecursive` (SMI-6192, shipped)
- `npm run build` fails only for `@skillsmith/website` with `EXDEV: cross-device link not permitted, rename '/app/packages/website/.vercel/output/server/.prerender/_astro/<file>' -> '/app/packages/website/dist/client/_astro/<file>'` (SMI-6426, open; SMI-6476 is a duplicate)
- `npm run lint` exits 1 with ~14 `no-unused-vars` errors, every one of them under `.claude/skills/concurrency-auditor/tests/pattern-6/fixtures/` (SMI-6562 et al., open)
- `npm run preflight` exits 1 with `❌ Found N missing dependencies`, naming packages your diff does not touch (SMI-6474 et al., open; that issue holds the current list)
- `npm run build`/`astro check` fails inside a worktree container with "Turborepo did not find the correct binary for your platform" or "Cannot find native binding"/"Cannot find module '@rolldown/binding-...'" for a build tool (turbo, Rollup/Rolldown, Astro's compiler, Lightning CSS, Tailwind Oxide, ruvector, Wrangler/workerd) (SMI-6050, shipped)
- `dev` container OOM-kills or a build/test run under heavy concurrent-worktree load hits the per-container ceiling (SMI-6064)
- Container won't start
- Native module errors
- A pre-push failure prints `✗ Native SQLite binding is broken in the dev container` with a `Mount check: <STATE> -- cause: <CAUSE>` line (SMI-6684/SMI-6687, ADR-165)
- `hnswlib-node` fails validation after rebuild (`ignore-scripts=true` in `.npmrc` blocks node-gyp — see SMI-5200)
- `skillsmith` MCP CONNECTION_CLOSED, host process dies in <1s with exit 137 and zero stderr
- Platform mismatch (SIGKILL 137)
- Node ABI mismatch
- Host retrieval autoheal failed or in cooldown
- Retrieval-telemetry liveness alert fired (GitHub issue `telemetry-liveness`)
- `status-external-outage` GitHub Issue fired
- `prod-deploy-approval-cancelled` GitHub Issue fired
- `submodule-pointer-regression`-labeled GitHub Issue fired (SMI-6260)
- "invalid ELF header" in Docker (SMI-4698)
- A worktree's edits to `.husky/*` or `scripts/*` don't take effect on `git push`/`git commit`, though `bash scripts/<x>.sh` run directly does (SMI-6334)
- Worktree `npm run build` fails (SMI-4689)
- Worktree container hits `EROFS` writing `node_modules/.vite-temp` or `node_modules/.astro` (SMI-5705/SMI-5722)
- Worktree container boot log shows `[repair] Could not link ... (non-fatal)` or `... missing/read-only — alias ... not linked` (SMI-5650)
- Worktree edits not reaching the container (stale `wc -l`, prettier "No files matching", stale test runs)
- Docker Desktop hung on "Turning off the Docker Engine..." (SMI-5616/SMI-5750)
- A `verify_jwt = false` admin function rejects a currently-valid `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` bearer with 401 (SMI-6082)
- An edge function, the website or a CLI call gets `42501 permission denied for table <x>` (or `for sequence <x>_seq`) on a relation a recent migration created (SMI-7151)
- Docker DNS failure
- Stale CJS artifacts
- Tool missing in `skillsmith-dev-1` (e.g. `psql: executable file not found`) after a Dockerfile change merged on `main` (SMI-4820)
- Orphaned agents
- `scripts/needle/dispatch.sh` refuses with exit 2, "already holds N open/in_progress bead(s)" (SMI-5847)
- Pushed a fix to a release-cadence branch but CI never triggers, PR shows a stale `headRefOid`, or `gh api .../pulls/<N>/commits` is empty (SMI-5663, recurring — 6 weeks running as of PR #1959)
- A PR's CI never triggers — `gh pr checks <N>` reports nothing, `gh api repos/.../commits/<sha>/check-runs` returns `total_count: 0`, across multiple pushes — but the PR is still OPEN (rules out SMI-5663 above, whose symptom is a closed/reopened PR with a stale `headRefOid`) (SMI-6458)
- `release-cadence.yml`'s Sunday scheduled trigger looks like it hasn't fired yet (SMI-6052)
- `publish.yml`'s `Verify X on npm` step failed (SMI-6493)
- `StuckLockError` on `~/.skillsmith/config.json.lock` or `~/.skillsmith/audits/security-acceptance.json.lock` (SMI-5883)
- The `ruflo` MCP server fails to connect and its `/mcp` log shows a `[ruflo] guard:` line with an exit code (SMI-6744, ADR-170 § 4)
- Symlink outside skills root (SMI-4287)
- Session-start audit unexpected stderr (SMI-4590)
- Session-priming banner shows a reindex failure/anomaly/hung warning
- Session-priming banner shows a `[ruflo-bridge]` warning (SMI-6744 A5.5.2 delta)
- Strategy submodule uninitialized
- Local typecheck/vitest fails with missing \`marked\`/\`sanitize-html\`/\`@types/sanitize-html\` (TS2688 / "Cannot find package"), or any package a workspace declares but a command can't resolve (SMI-6006 correction)
- MCP server logs `Failed to close database on shutdown`
- The `Edge Functions Typecheck` CI job fails, or `bash scripts/ci/typecheck-edge-functions.sh` fails locally (SMI-6897)
- `skillsmith-doc-retrieval` shows `Failed to reconnect` or `MCP error -32603: schema._def.shape is not a function` in `/mcp`

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

**Architecture decisions get their own ADR (standing rule since 2026-08-24, prospective only).** A plan doc capturing *what* changed isn't the same as an ADR capturing *why one structurally different approach was chosen over another*. When a plan's own architecture decision is genuine (not just an implementation detail), flag it and ask whether it warrants a dedicated `docs/internal/adr/` entry — `plan-review-skill`'s VP Engineering rubric checks for this.

---

## Important Instruction Reminders

**If you are a dispatched subagent** (spawned via the Agent/Task tool) and your own task prompt says not to commit, push, open/merge a PR, or touch Linear: that scoping wins over every "after every commit"/"after every PR merge" instruction below, no exceptions. Those blanket instructions bind the top-level coordinating session only. Hand your work back to the dispatcher instead.

**If a system-reminder reports that the `skillsmith` or `skillsmith-doc-retrieval` MCP server disconnected** (e.g. "N deferred tools are no longer available (MCP server disconnected)"): treat this as always directly relevant, never as suppressible ambient context — surface it to the user in your very next response, name which server dropped, and tell them to run `/mcp` → select that server → Reconnect. This is a best-effort backstop for the case where the tool vanishes from your toolset before any call is attempted (SMI-5941) — the underlying container can be perfectly healthy the entire time, and nothing else in the harness will tell the user unless you do.

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.
NEVER defer fixes to "later" or "a future pass". If a code review or audit surfaces an issue in scope, fix it immediately in the same PR. Do not label findings as "informational" or "non-blocking" if they can be resolved now.
NEVER say "worth a note for next time" or "consider X in future". If something is worth noting, act on it immediately: create the Linear issue, update the doc, fix the config. Observations without immediate action are noise.
After context compaction or session continuation, ALWAYS verify claimed-complete work by reading the actual files before proceeding. Never trust the summary alone — compaction can conflate "planned" with "implemented".
After EVERY commit, run `/governance` to review the changed code. Resolve ALL issues it surfaces before pushing. No exceptions — do not skip, defer, or downgrade findings.
**The one carve-out: a prose-only commit skips `/governance`.** It reviews changed *code*; a commit with none yields a finding-free report that reads as coverage it never gave. **Take the carve-out only when every changed file ends in `.md` and merely describes existing behaviour for a human reader.** If a file prescribes behaviour, serves as a template or specification, or its classification is uncertain, run `/governance`. Two exclusions, and they are different rules: these paths are always excluded whatever they contain — `CLAUDE.md`, `.claude/{skills,agents,commands,templates}/**`, `.github/PULL_REQUEST_TEMPLATE.md`; and separately, exclude any other `.md` that a script, hook, workflow or agent reads as input. A commit is also not prose-only if its prose is generated by, consumed by, or semantically coupled to code elsewhere in the same branch or PR — splitting a change across two commits does not buy the exemption. **Do not settle this by watching the push hook**: its positive allowlist admits files of any type under `docs/`, `.claude/development/`, `.claude/templates/` and `.github/ISSUE_TEMPLATE/` — executable scripts included — except paths vetoed under `tests/` or `fixtures/` (SMI-6620). State the skip in the commit that takes it — an unrecorded exception to a no-exceptions rule is indistinguishable from ignoring it (SMI-6617). For the post-merge retro below, skip only when every file in the whole PR diff meets this definition.
After EVERY commit, update the relevant Linear issue(s) in the Skillsmith initiative (SMI-xxx) to reflect progress. Add a comment with the commit SHA and a brief summary of what changed. Move the issue status forward if the commit completes the work (e.g., "In Progress" → "Done"). If no Linear issue exists for the work, create one under the appropriate project before pushing.
Before every `gh pr create`, use the `pr-description` skill — PR bodies lead with a plain-language Business Summary, not technical detail first.
Before merging any PR, run the `pr-reviewer` skill's full pre-merge check gate, dispatched to a model from a different family than whatever wrote the PR — for Claude-authored work, that means GPT-5.6-Sol via `scripts/needle/dispatch.sh` (ADR-128), never the skill's own default same-family Claude subagent path. Resolve every finding (zero-deferral) before merging; note any check as SKIP only when its trigger condition genuinely isn't present in the diff.
**Carve-out: a pointer-bump or docs-only PR skips this gate.** Those checks read a *code* diff — migrations, RLS, exports, enums, upsert callers, edge-function surfaces — so a PR carrying none presents no trigger for any of them, and running it yields an all-SKIP report that reads as coverage it never gave, the same defect the prose-only carve-out above exists to avoid. **Take it only when every changed path in the PR diff is either a `.md` file or a submodule gitlink whose registered range touches no executable file** — and check the range, not the gitlink: `git -C <submodule> diff --name-only <old>..<new>` must list no `.sh`, `.ts`, `.mjs`, `.sql`, or workflow YAML. A `.claude/skills` bump is never exempt, matching that carve-out's own always-excluded paths; a `docs/internal` bump normally is. Its `.md` test cannot settle this on its own, because a gitlink is not a `.md` file and its contents are opaque at the diff — a real PR hit exactly that gap (SMI-6701, PR #2867). State the skip in the PR body.
After EVERY PR is merged, run `/governance` as a retrospective on the full PR diff. Resolve ALL issues it surfaces immediately — create follow-up commits or Linear issues as needed. Do not close the session until the retro is clean.
After the governance retro, update any `index.md` files in directories where files were added or removed during the PR. Check `docs/internal/`, `.claude/development/`, and `.claude/templates/`. If the root `docs/internal/index.md` folder counts have drifted, update those too. **Partial machine coverage exists for exactly one of those**: `.github/workflows/docs-folder-index.yml` (SMI-4932) fails any PR that touches `docs/internal/**` or `.gitmodules` while the root `docs/internal/index.md` "Folder Reference" table is stale — so the folder-count half of this line is caught for you on the pointer-bump PR. Nothing checks `.claude/development/index.md`, `.claude/templates/`, or per-subdirectory `index.md` files; those stay manual.

**Enforcement status of the reminders above (SMI-6407 audit, 2026-09-05).** Everything from "After EVERY commit, run `/governance`" through this line is **enforced only by prose — no hook, no CI check, nothing observes whether it happened.** So is "Never save working files, text/mds and tests to the root folder," the zero-deferral rule, and the branch-naming rule under § Branch Management. That is a known gap, not an oversight: the migration candidates and their proposed enforcement surfaces are laid out in [smi-6407-claude-md-memory-governance-enforcement-migration.md](docs/internal/implementation/smi-6407-claude-md-memory-governance-enforcement-migration.md), each of which is an ADR-109 infra change requiring SPARC + plan-review before implementation. Until one of those lands, these lines bind by recall alone — treat them accordingly rather than assuming a guard would have caught a miss.
