# CI Reference

Detailed CI pipeline configuration, change classification, branch protection, and build orchestration.

## Change Classification (SMI-2186)

The CI system classifies changes into tiers to run appropriate checks:

| Tier | Trigger | Workflow | Jobs Run |
|------|---------|----------|----------|
| `docs` | Only `docs/**`, `*.md` | `docs-only.yml` | Secret scan, markdown lint (~30s) |
| `config` | Only config files | `ci.yml` | Validation jobs |
| `code` | `packages/**`, `supabase/**` | `ci.yml` | Full pipeline (~11 min) |
| `deps` | `package*.json` changes | `ci.yml` | Docker rebuild, security audit |

### Docs Tier Path Patterns

| Pattern | Examples |
|---------|----------|
| `docs/**` | ADRs, implementation plans, architecture docs |
| `**/*.md` | README.md, CLAUDE.md, any markdown file |
| `LICENSE` | License file changes |
| `.github/ISSUE_TEMPLATE/**` | Issue templates |
| `.github/CODEOWNERS` | Code owners file |

**Important**: Mixed commits (docs + code) trigger full CI. Docs-only commits run lightweight `docs-only.yml`. See [ADR-105](../adr/105-ci-path-filtering.md).

### CI Scripts

| Script | Purpose |
|--------|---------|
| `scripts/ci/classify-changes.ts` | Classifies commits into tiers |
| `scripts/ci/detect-affected.ts` | Detects affected packages |

## Turborepo Build Orchestration (SMI-2196)

```bash
docker exec skillsmith-dev-1 npm run build          # Normal (Turbo, recommended)
docker exec skillsmith-dev-1 npm run build:legacy    # Manual ordering (debugging)
```

Benefits:

- Dependency-aware task scheduling (builds packages in correct order)
- Incremental builds with content hashing (10x faster on cache hit)
- Local cache in `.turbo/` directory (gitignored)

See [ADR-106](../adr/106-turborepo-build-orchestration.md).

## Branch Protection

The `main` branch is protected. Config: `.github/branch-protection.json`.

### Required Checks

| Check | Workflow | Purpose |
|-------|----------|---------|
| Secret Scan | ci.yml, docs-only.yml | Detect committed credentials |
| Classify Changes | ci.yml | Categorize change type |
| Package Validation | ci.yml | Verify package.json scope |
| Edge Function Validation | ci.yml | Validate Supabase function structure |
| Build Docker Image | ci.yml | Build development container |
| Lint | ci.yml | ESLint and Prettier |
| Type Check | ci.yml | TypeScript type checking |
| Security Audit | ci.yml | npm audit and security tests |
| Standards Compliance | ci.yml | Governance standards audit |
| Build | ci.yml | Build all packages via Turborepo |
| Markdown Lint | docs-only.yml | Documentation quality |

### How It Works

- **Code PRs**: All 11 checks must pass
- **Docs-only PRs**: Only Secret Scan + Markdown Lint (from `docs-only.yml`)
- **Mixed PRs**: Full CI runs

### Emergency Bypass

If required checks are stuck or GitHub Actions is down:

1. Verify urgency (production deployment or critical security fix?)
2. Check [GitHub Status](https://www.githubstatus.com/)
3. Navigate to PR, select "Merge without waiting for requirements to be met"
4. Add comment explaining bypass reason

`enforce_admins: false` allows admin bypass during emergencies.

### Troubleshooting

**"Required checks not found"**: Someone renamed a job without updating branch protection. Fix: update `.github/branch-protection.json` and re-apply.

**All PRs blocked after workflow changes**: Required check name no longer exists. Use emergency bypass, then update config.

### Configuration Drift Detection

```bash
./scripts/validate-branch-protection.sh
```

### Applying Changes

```bash
gh api repos/Smith-Horn/skillsmith/branches/main/protection -X PUT --input .github/branch-protection.json
```

## `continue-on-error` Audit (SMI-3217)

Check 21 in `audit-standards.mjs` flags `continue-on-error: true` steps that lack downstream outcome checks — the pattern that caused 18 days of silent zero-data in `ab-results.yml`.

### Rules

A step with `continue-on-error: true` must either:

1. Have an `id:` field **and** that id must be referenced downstream via `steps.<id>.outcome`, `steps.<id>.outputs`, or `steps.<id>.conclusion`
2. Be explicitly exempted with `# audit:allow-continue-on-error`

### Exemption Syntax

Add the comment inline or within 3 lines above the `continue-on-error` directive:

```yaml
# Inline (preferred)
continue-on-error: true # audit:allow-continue-on-error — reason

# Above the directive
# audit:allow-continue-on-error — reason
continue-on-error: true
```

Steps with `|| true` in their `run:` block are auto-exempted (intent is clear).

### When to Exempt

- Artifact uploads/downloads (storage quota or missing artifacts)
- Cosmetic PR comments or report generation
- Best-effort cache downloads with npm install fallback

### When NOT to Exempt

- Data-fetching steps where zero/empty results would go unnoticed
- Steps whose failure should change downstream behavior
- API calls without HTTP status or error message checking

## Wave Merge CI Polling (SMI-3010)

When monitoring CI between sequential wave merges, always use `${VAR:-0}` not `$VAR` for `jq | length` results:

```bash
# WRONG — returns "" when statusCheckRollup is empty (checks not yet started)
FAILED=$(gh pr view $PR --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.conclusion == "FAILURE")] | length')
[ "$FAILED" != "0" ] && echo "FAILED"  # "" != "0" is TRUE → false FAILURE

# CORRECT — defaults to 0 when jq returns empty string
FAILED=$(gh pr view $PR --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.conclusion == "FAILURE")] | length')
[ "${FAILED:-0}" != "0" ] && echo "FAILED"
```

**Rule**: Always wait for Wave N CI to show green before starting Wave N+1 rebase. Starting early saves <30s but risks a reflog recovery if Wave N's checks later fail.

## Docker BuildKit Cache Policy (SMI-3531, SMI-3539, SMI-3653)

Three workflows build Docker images with BuildKit GHA cache. All Docker build jobs have a **20-minute timeout** to accommodate cold builds (~15 min for native module compilation).

| Workflow | Scope | Mode | Timeout | Purpose |
|----------|-------|------|---------|---------|
| `ci.yml` | `scope=ci` | `mode=min` | 20 min | PR and push CI |
| `e2e-tests.yml` | `scope=e2e` | `mode=min` | 20 min | End-to-end tests |
| `publish.yml` | `scope=publish` | `mode=min` | 20 min | npm publish |

**Cache lifecycle** (SMI-3653):

| Trigger | `cache-from` (read) | `cache-to` (write) |
|---------|---------------------|---------------------|
| Push to main | Yes | Yes |
| Pull request | Yes (reads main's cache) | **No** |
| `workflow_dispatch` from main | Yes | Yes |
| `workflow_dispatch` from branch | Yes | No |

Only main-branch pushes write BuildKit blobs. PR branches read from main's cache but do not write their own blob copies. This prevents per-PR blob accumulation that filled the 10 GB GHA cache limit (70 blobs, 7.44 GB in 24 hours — SMI-3653). Implementation uses an env-var (`CACHE_TO`) set conditionally in a prior step.

**Latency note**: The first PR opened after a lockfile change merges to main — but before main's post-merge CI build completes (~6 min) — may see a longer Docker build because main's cache is stale.

**Dual-layer cache architecture** (ci.yml only):

ci.yml uses two cache mechanisms in sequence:

1. **Mechanism 1** (`actions/cache@v5`): Keyed on `Dockerfile + package-lock.json + .dockerignore + .nvmrc`. On hit, loads a pre-built image tarball and skips Docker build entirely. On miss, falls through to mechanism 2.
2. **Mechanism 2** (`build-push-action` with BuildKit GHA cache): Runs the full Docker build using BuildKit layer cache.

E2E and publish workflows only use mechanism 2 (no `actions/cache` tarball layer). This means E2E PR builds rely entirely on main's BuildKit cache — if main's cache is stale, E2E gets a cold build (~6 min).

**Key decisions**:

- `scope=` isolates each workflow's cache entries. Without scope, workflows evict each other's entries when the 10 GB GHA cache cap is reached.
- All workflows use `mode=min` (final image layers only). `mode=max` was trialed for CI in PR #344 (SMI-3539) but rolled back in SMI-3547 after 72h verification showed cache pressure (10.45 GB, publish scope evicted). The marginal benefit (~3–5 min on ~1–2 lockfile-change builds/week) did not justify the cache eviction risk.

**Monitoring commands**:

```bash
# Total cache usage (should be under 5 GB)
gh api repos/smith-horn/skillsmith/actions/cache/usage

# Cache breakdown by scope
gh api "repos/smith-horn/skillsmith/actions/caches?per_page=100" --paginate \
  --jq '[.actions_caches[] | {prefix: (.key | split("-")[0:2] | join("-")), size: .size_in_bytes}] | group_by(.prefix) | map({prefix: .[0].prefix, count: length, total_gb: ([.[].size] | add / 1073741824 * 100 | floor / 100)}) | sort_by(-.total_gb) | .[]'

# Verify scope indexes (ci, e2e, publish should all be present)
gh api "repos/smith-horn/skillsmith/actions/caches?per_page=100" --paginate \
  --jq '.actions_caches[] | select(.key | test("index-")) | {key, last_accessed_at}'

# Prune all BuildKit blobs (run when no CI is in progress)
gh api repos/smith-horn/skillsmith/actions/caches --paginate \
  --jq '.actions_caches[] | select(.key | startswith("buildkit-blob")) | .id' \
  | xargs -I{} gh api -X DELETE repos/smith-horn/skillsmith/actions/caches/{}
```

- **Cache-miss Step Summary** (SMI-3539): ci.yml docker-build writes cache hit/miss status to `$GITHUB_STEP_SUMMARY` so PR authors know when a cold build is expected.

## Artifact Retention Policy (SMI-3531)

| Artifact Type | Retention | Rationale |
|---------------|-----------|-----------|
| CI Docker image + node_modules | 1 day | Same-run only; rebuilt each CI run |
| Test results (unit, E2E) | 7 days | Debugging window for flaky tests |
| Security scan reports | 14 days | Forensic timeline; SARIF in GitHub Code Scanning is permanent |
| Publish artifacts | 1 day | Same-run only |

## CodeQL Scope (SMI-3531)

CodeQL runs on push/PR to main with the same `paths-ignore` as `ci.yml` (docs, templates, markdown, LICENSE, issue templates). Weekly scheduled scan (Monday 2 AM UTC) runs unconditionally on all paths — no security coverage regression.
