# Contributing to Skillsmith

## Development Workflow

### Prerequisites

- Docker Desktop running
- Node.js 20+ (for local tooling)
- Linear API key in environment (`LINEAR_API_KEY`)

### Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/wrsmith108/skillsmith.git
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

### Keeping Linear in Sync

Use the built-in Linear sync commands to update issue status:

```bash
# Mark issue as done
npm run linear:done SMI-619

# Mark issue as in progress
npm run linear:wip SMI-640

# Check which issues are mentioned in recent commits
npm run linear:check

# Auto-update issues from last commit message
npm run linear:sync
```

### Commit Message Convention

Include issue IDs in commit messages for automatic tracking:

```bash
# Good - issue ID in message
git commit -m "feat(cache): implement tiered caching (SMI-644)"

# Also good - multiple issues
git commit -m "fix(security): address vulnerabilities (SMI-683, SMI-684)"
```

After committing, run `npm run linear:sync` to automatically update Linear.

### Issue Status Flow

```
Backlog → Todo → In Progress → Done
```

Use these commands to move issues:

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

4. **Update Linear**
   ```bash
   npm run linear:sync
   ```

5. **Push and create PR**
   ```bash
   git push origin feature/smi-xxx-description
   gh pr create
   ```

6. **After merge, mark done**
   ```bash
   npm run linear:done SMI-XXX
   ```

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
