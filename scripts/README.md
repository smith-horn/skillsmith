# Scripts

Utility scripts for Skillsmith development and project management.

## Prerequisites

Scripts require the following environment variables:

```bash
export LINEAR_API_KEY="lin_api_..."  # Linear API key
export GITHUB_TOKEN="ghp_..."        # GitHub token (for CI)
```

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
npm run audit:standards
# or directly:
node scripts/audit-standards.mjs
```

**Checks:**
- TypeScript strict mode configuration
- File size limits (500 lines max)
- Import conventions
- Naming conventions
- Test coverage requirements

## Linear Project IDs

| Project | ID |
|---------|-----|
| Phase 1 | `b6135515-89c9-4ad7-b32c-613933508067` |
| Phase 2 | `fe22ca22-b538-4454-bcb0-6d770efbddd0` |
| Team | `6795e794-99cc-4cf3-974f-6630c55f037d` |

## Adding New Scripts

1. Place scripts in `/scripts` directory
2. Make executable: `chmod +x scripts/your-script.sh`
3. Document in this README
4. Test locally before committing
