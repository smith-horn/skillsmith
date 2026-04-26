# Contributing to Skillsmith

## Code of Conduct

This project and everyone participating in it is governed by the
[Skillsmith Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to
uphold it. Report unacceptable behavior to `support@skillsmith.app`.

## Development Workflow

### Prerequisites

- Docker Desktop running
- Node.js >=22.22.0 (matches Docker dev container `node:22-slim`)
- `LINEAR_API_KEY` in environment (maintainers only - not required for contributors)

### Getting Started

```bash
# 1. Clone the repository (or fork first for contributions)
git clone https://github.com/smith-horn/skillsmith.git
cd skillsmith

# 2. Start Docker container
docker compose --profile dev up -d

# 3. Install dependencies
docker exec skillsmith-dev-1 npm install

# 4. Run tests to verify setup
docker exec skillsmith-dev-1 npm test
```

## Linear Integration

Skillsmith uses [Linear](https://linear.app) for issue tracking. Issue IDs follow the pattern `SMI-XXX`.

### For Contributors

External contributors **do not need Linear access**. You can contribute without any Linear API key.

**Reference issues in commits:**

```bash
# Include issue ID for traceability
git commit -m "feat(cache): implement tiered caching (SMI-644)"

# Multiple issues
git commit -m "fix(security): address vulnerabilities (SMI-683, SMI-684)"
```

**Auto-close issues when merged:**

The `Resolves:` syntax automatically closes Linear issues via GitHub webhook:

```bash
git commit -m "feat(auth): implement SSO integration

Resolves: SMI-1234"
```

| Keyword | Effect |
|---------|--------|
| `Resolves: SMI-XXX` | Auto-closes issue when merged to main |
| `Fixes: SMI-XXX` | Same (alias for bug fixes) |
| `Closes: SMI-XXX` | Same (alias) |

> **How it works**: The auto-close feature uses GitHub's webhook integration with Linear. You're not calling Linear's API directly - GitHub processes your commit message and updates Linear using the org's credentials. This means you can reference and close issues without any API access.

### For Maintainers

Maintainers with `LINEAR_API_KEY` can update issues directly:

```bash
# These commands require LINEAR_API_KEY environment variable
npm run linear:done SMI-619      # Mark as done
npm run linear:wip SMI-640       # Mark as in progress
npm run linear:check             # Check issues in recent commits
npm run linear:sync              # Auto-update from last commit
```

**Issue Status Flow:**

```text
Backlog → Todo → In Progress → Done
```

| Action | Command |
|--------|---------|
| Start work | `npm run linear:wip SMI-XXX` |
| Complete work | `npm run linear:done SMI-XXX` |
| After merge | (auto via `linear:sync`) |

## Filing Issues

External contributors file issues via GitHub — **you do not need a Linear account**.
When you click "New Issue" you will see three structured forms:

| Form | Use For |
|------|---------|
| **Bug Report** | Broken or incorrect behavior. Includes reproduction steps, version, environment, logs. |
| **Feature Request** | New functionality or enhancements. Acceptance criteria optional — maintainers add during triage. |
| **Documentation Issue** | Problems in the docs, guides, or README. |

**Security vulnerabilities** must NOT be filed as public issues. Follow
[SECURITY.md](SECURITY.md) and email `security@skillsmith.app` instead. The "New Issue"
page has a contact link that routes you there directly.

**Questions and discussion** should go to
[GitHub Discussions](https://github.com/smith-horn/skillsmith/discussions), not the
issue tracker.

**What happens after you file:** Every form applies a `needs-triage` label automatically.
Maintainers triage new issues into Linear (`SMI-XXX`), add domain labels (`core`, `mcp`,
`cli`, etc.), remove `needs-triage`, and comment the SMI link back on your GitHub issue
so you can track progress. External contributors do not need Linear access — the SMI
link is read-only reference.

## Pull Request Process

1. **Create feature branch**

   ```bash
   git checkout -b feature/smi-xxx-description
   ```

2. **Make changes** (in Docker)

   ```bash
   docker exec skillsmith-dev-1 npm run build
   docker exec skillsmith-dev-1 npm test
   ```

3. **Commit with issue reference**

   ```bash
   git commit -m "feat(module): description (SMI-XXX)"
   ```

4. **Push and create PR**

   ```bash
   git push origin feature/smi-xxx-description
   gh pr create
   ```

5. **(Maintainers only) Update Linear**

   ```bash
   npm run linear:sync           # Requires LINEAR_API_KEY
   npm run linear:done SMI-XXX   # After merge
   ```

> **For contributors**: Steps 1-4 are all you need. Use `Resolves: SMI-XXX` in your commit to auto-close issues when merged.

## Parallel Development with Worktrees

For working on multiple features simultaneously, use git worktrees:

```bash
# Create worktree for a feature
cd /path/to/skillsmith
./.claude/skills/worktree-manager/scripts/worktree-create.sh my-feature SMI-XXX

# Check status of all worktrees
./.claude/skills/worktree-manager/scripts/worktree-status.sh

# Sync all worktrees with main
./.claude/skills/worktree-manager/scripts/worktree-sync.sh

# Clean up after merge
./.claude/skills/worktree-manager/scripts/worktree-cleanup.sh my-feature
```

See `.claude/skills/worktree-manager/SKILL.md` for detailed documentation.

## Git Hooks

Skillsmith uses [Husky](https://typicode.github.io/husky/) for git hooks.

### Pre-commit Hook

Runs automatically on every commit:

- Secret scanning
- TypeScript type checking
- Linting and formatting staged files

### Pre-push Hook

Runs before pushing to remote:

- Security test suite
- npm audit (high severity)
- Hardcoded secret detection
- Coverage threshold check

### Pre-rebase Hook

**New:** Warns about unmerged feature branches before rebasing to prevent accidental work loss.

```text
# Example output
⚠️  WARNING: Found unmerged feature branches

  feature/my-work
    └─ 5 commit(s) ahead of main
    └─ Last commit: 2 hours ago
    └─ "feat: implement new feature..."

Consider merging or backing up important work before rebasing.

Options:
  • Merge important branches first: git merge <branch>
  • Create backup tags: git tag backup/<branch> <branch>
  • Skip this check: git rebase --no-verify
```

This hook was added after the [docs 404 incident](docs/internal/retros/2025-01-22-docs-404-recovery.md) where completed work was lost during a rebase because feature branches were never merged.

## Code Quality

All code must pass these checks before merge:

```bash
# Run all checks (in Docker)
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm run lint
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run audit:standards
```

Pre-commit hooks will automatically run linting and formatting.

## Releases

Skillsmith publishes four public packages to npm (`@skillsmith/core`, `@skillsmith/mcp-server`, `@skillsmith/cli`, `skillsmith-vscode`) and one private package to GitHub Packages (`@smith-horn/enterprise`). See [ADR-114](docs/internal/adr/114-release-cadence-and-gh-release-alignment.md) for the full decision record.

### Cadence

- **Weekly**: an automated workflow runs every Sunday at 03:00 UTC. If `[Unreleased]` in root `CHANGELOG.md` is non-empty, it opens a version-bump PR using `scripts/prepare-release.ts --all=patch`. Humans review and merge; nothing auto-merges.
- **Threshold**: if root `CHANGELOG.md [Unreleased]` accumulates 15 or more entries mid-week, the same workflow fires early. Threshold is configurable via `UNRELEASED_THRESHOLD` and is expected to fire ~2-3×/month at current shipping velocity.

### `[Unreleased]` expectations

- Every user-visible change (feature, fix, deprecation, security patch, non-trivial perf) gets a one-line entry in root `CHANGELOG.md` under `[Unreleased]` in the matching section (`### Added`, `### Fixed`, `### Changed`, `### Security`, `### Dependencies`).
- Per-package CHANGELOGs (`packages/core/CHANGELOG.md`, etc.) get an `[Unreleased]` entry **only** if the change ships in that package. The root CHANGELOG is the monorepo-wide log; per-package CHANGELOGs are package-specific.
- Reference the Linear issue (`SMI-NNNN`) and PR number in every entry.

### GitHub Release creation

Two paths, both automatic:

1. **CI publish** (preferred): `gh workflow run publish.yml -f dry_run=false`. On success, a `create-gh-release` job extracts the version's CHANGELOG section and calls `gh release create` per package. Tag convention: `@skillsmith/<name>-v<X.Y.Z>` (matches the 2026-03-07 precedent).
2. **Local fallback** (`npm publish --ignore-scripts -w`, documented in CLAUDE.md): if used, a scheduled workflow (`detect-release-drift.yml`) runs hourly and creates any missing GH Releases it finds by comparing `npm view <pkg>` against the latest GH Release tag. Drift-healed releases are indistinguishable from CI-created ones downstream.

**If you local-publish, create the GH Release yourself** immediately after:

```bash
gh release create "@skillsmith/core-v$(jq -r .version packages/core/package.json)" \
  --title "@skillsmith/core v$(jq -r .version packages/core/package.json)" \
  --notes-file <(node scripts/extract-changelog-section.mjs --package packages/core --version $(jq -r .version packages/core/package.json))
```

Reason: between the local publish and the drift detector's next tick (up to 60 min), users installing from npm see the new version without any release notes discoverable via normal channels. The drift detector is a safety net, not the primary path.

### Website changelog

[skillsmith.app/changelog](https://skillsmith.app/changelog) is generated at build time from the GitHub Releases API. No action required from contributors — releases appear on the website when Vercel rebuilds (usually within minutes of a release being published).

## Internal Documentation

Internal documentation is in a private submodule at `docs/internal/`. Access requires Smith Horn GitHub org membership. The `--recurse-submodules` flag is optional when cloning.

```bash
git submodule update --init          # Init submodule (authorized users only)
```

## Questions?

- Check [docs/internal/architecture/](docs/internal/architecture/) for design decisions (requires submodule init)
- Review [docs/internal/adr/](docs/internal/adr/) for architecture decision records (requires submodule init)
- See [docs/internal/retros/](docs/internal/retros/) for phase retrospectives (requires submodule init)
