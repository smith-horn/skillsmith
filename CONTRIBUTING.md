# Contributing to Skillsmith

## Development Workflow

### Prerequisites

- Docker Desktop running
- Node.js 20+ (for local tooling)
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

```
Backlog → Todo → In Progress → Done
```

| Action | Command |
|--------|---------|
| Start work | `npm run linear:wip SMI-XXX` |
| Complete work | `npm run linear:done SMI-XXX` |
| After merge | (auto via `linear:sync`) |

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

```bash
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

This hook was added after the [docs 404 incident](docs/retros/2025-01-22-docs-404-recovery.md) where completed work was lost during a rebase because feature branches were never merged.

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

## Questions?

- Check [docs/architecture/](docs/architecture/) for design decisions
- Review [docs/adr/](docs/adr/) for architecture decision records
- See [docs/retros/](docs/retros/) for phase retrospectives
