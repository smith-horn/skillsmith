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
