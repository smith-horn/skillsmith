# Scripts

Utility scripts for Skillsmith development and project management.

## Prerequisites

Scripts require the following environment variables:

```bash
# Required for all Linear scripts
export LINEAR_API_KEY="lin_api_..."  # Linear API key

# Required for Linear project scripts
export LINEAR_PROJECT_PHASE1="..."   # Phase 1 project UUID
export LINEAR_PROJECT_PHASE2="..."   # Phase 2 project UUID
export LINEAR_PROJECT_TEAM="..."     # Team project UUID

# Optional
export GITHUB_TOKEN="ghp_..."        # GitHub token (for CI)
```

**Important:** Copy `.env.example` to `.env` and fill in your values. Never commit `.env` to version control.

## Linear Integration Scripts

### `linear-phase1-update.sh`

Updates Phase 1 Linear issues to "In Progress" status.

```bash
./scripts/linear-phase1-update.sh
```

**Actions:**
- Moves SMI-614, SMI-615, SMI-616 to "In Progress"
- Creates project update with Phase 1 start details

### `linear-phase2-setup.sh`

Creates Phase 2 project and issues in Linear.

```bash
./scripts/linear-phase2-setup.sh
```

**Actions:**
- Creates "Skillsmith Phase 2: Core Features" project
- Creates Phase 1 cleanup issues (SMI-624, SMI-625, SMI-626)
- Creates Phase 2 feature issues (SMI-627 through SMI-634)

### `linear-add-updates.sh`

Adds project updates to Phase 1 and Phase 2 projects.

```bash
./scripts/linear-add-updates.sh
```

**Actions:**
- Adds Phase 1 cleanup issues summary
- Adds Phase 2 priorities breakdown

## Standards & Quality

### `audit-standards.mjs`

Audits codebase against Skillsmith engineering standards.

```bash
# Run inside Docker (required)
docker exec skillsmith-dev-1 npm run audit:standards

# Or directly:
docker exec skillsmith-dev-1 node scripts/audit-standards.mjs
```

**Checks:**
- TypeScript strict mode configuration
- File size limits (500 lines max)
- Docker configuration (container name, volumes)
- Script Docker compliance (no local npm commands)
- Import conventions
- Naming conventions
- Test coverage requirements

## Linear Project IDs

Project IDs are stored in environment variables for security. See `.env.example` for the required variables:

| Variable | Description |
|----------|-------------|
| `LINEAR_PROJECT_PHASE1` | Phase 1 project UUID |
| `LINEAR_PROJECT_PHASE2` | Phase 2 project UUID |
| `LINEAR_PROJECT_TEAM` | Team project UUID |

To find your project IDs:
1. Open Linear
2. Navigate to the project
3. Go to Settings
4. Copy the project ID

## Git Hooks

Custom git hooks are available in `scripts/git-hooks/` to prevent common development issues.

### `pre-commit-check-src.sh`

Warns about untracked files in `packages/*/src/` directories before each commit. This prevents the Wave 4/5 gitignore bug from happening again.

**Installation:**

```bash
# Copy to .git/hooks/
cp scripts/git-hooks/pre-commit-check-src.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

See `scripts/git-hooks/README.md` for detailed documentation and alternative installation methods.

## Adding New Scripts

1. Place scripts in `/scripts` directory
2. Make executable: `chmod +x scripts/your-script.sh`
3. Document in this README
4. Use environment variables for sensitive data (never hardcode)
5. Test locally before committing
