# Phase Execution Scripts

Scripts for running Phase 5 and Phase 7 in parallel worktrees.

## Quick Start

```bash
# Terminal 1: Phase 5 (Critical Path)
./scripts/phases/phase-5-release.sh
cd ../worktrees/phase-5-release
claude

# Terminal 2: Phase 7 (can start in parallel)
./scripts/phases/phase-7-enterprise.sh
cd ../worktrees/phase-7-enterprise
claude
```

---

## Critical Path Analysis

```
Phase 5: Release & Publishing (P0 - BLOCKING)
├── SMI-811: Publish @skillsmith/mcp-server
├── SMI-812: Publish @skillsmith/cli
├── SMI-814: Publish @skillsmith/core (FIRST)
└── SMI-878: Create GitHub App
          │
          ▼ (npm packages published)
Phase 7: Enterprise Implementation
├── Week 1-2: License Validation
├── Week 3-4: Audit Logging ────────┐
├── Week 5-6: SSO/SAML ◄────────────┤ (can overlap)
├── Week 7-8: RBAC ◄────────────────┘
└── Week 9-10: Private Registry
```

## Parallel Execution Strategy

| Phase | Can Start Immediately | Requires Phase 5 |
|-------|----------------------|------------------|
| Phase 5 | Yes | - |
| Phase 7 Design | Yes | No |
| Phase 7 Implementation | After Week 2 | Partial (for integration tests) |
| Phase 7 Integration Testing | No | Yes |

**Recommendation**: Start both phases. Phase 7 can proceed with design and local development while Phase 5 completes npm publishing.

---

## Prerequisites (Manual Steps Required)

### Before Running Phase 5

1. **npm Authentication**
   ```bash
   npm login
   # Complete 2FA if enabled
   npm whoami  # Verify: should show your username
   ```

2. **GitHub CLI Authentication**
   ```bash
   gh auth login
   gh auth status  # Verify authentication
   ```

3. **npm Organization Access**
   - Ensure you have publish access to `@skillsmith` org on npm
   - Contact org admin if needed

### Before Running Phase 7

1. **Docker Container**
   ```bash
   docker compose --profile dev up -d
   docker ps | grep skillsmith  # Verify running
   ```

2. **Varlock Environment**
   ```bash
   varlock load  # Validate environment
   ```

### Both Phases

1. **LINEAR_API_KEY**
   - Ensure `LINEAR_API_KEY` is set via Varlock
   - Required for issue updates

---

## Handoff Points

### Phase 5 → Phase 7

When Phase 5 completes npm publishing:

1. **Notify Phase 7 Session**
   ```
   @skillsmith/core published as v0.1.0
   @skillsmith/mcp-server published as v0.1.0
   @skillsmith/cli published as v0.1.0
   ```

2. **Phase 7 Actions**
   - Update `packages/enterprise/package.json` dependencies
   - Switch from `workspace:*` to npm versions
   - Run integration tests

### Phase 7 Week Handoffs

| Week | Dependency | Output |
|------|------------|--------|
| 1-2 | None | LicenseValidator ready |
| 3-4 | License | AuditLogger with events |
| 5-6 | Audit | SSO with audit logging |
| 7-8 | SSO | RBAC with role mapping |
| 9-10 | RBAC | Private Registry |

---

## Script Options

### phase-5-release.sh

```bash
./scripts/phases/phase-5-release.sh [--dry-run]
```

- `--dry-run`: Show what would be done without executing

### phase-7-enterprise.sh

```bash
./scripts/phases/phase-7-enterprise.sh [--dry-run] [--week N]
```

- `--dry-run`: Show what would be done without executing
- `--week N`: Focus on specific week (1-10) for targeted prompt

**Week-specific examples:**
```bash
./scripts/phases/phase-7-enterprise.sh --week 3  # Audit Logging focus
./scripts/phases/phase-7-enterprise.sh --week 5  # SSO/SAML focus
```

---

## Worktree Management

### View Active Worktrees

```bash
git worktree list
```

### Sync Worktrees with Main

```bash
# In each worktree
git fetch origin main
git rebase origin/main
```

### Cleanup After Merge

```bash
git worktree remove ../worktrees/phase-5-release
git worktree remove ../worktrees/phase-7-enterprise
git worktree prune
```

---

## Troubleshooting

### "fatal: 'path' is already checked out"

Branch is already used by another worktree:
```bash
git worktree list  # Find where it's checked out
```

### npm publish fails with 401

```bash
npm login  # Re-authenticate
npm whoami  # Verify
```

### Docker container not starting

```bash
docker compose --profile dev down
docker compose --profile dev up -d
docker logs skillsmith-dev-1
```

---

## Related Documentation

- [Worktree Manager Skill](/.claude/skills/worktree-manager/SKILL.md)
- [ENTERPRISE_PACKAGE.md](/docs/enterprise/ENTERPRISE_PACKAGE.md)
- [ROADMAP.md](/docs/strategy/ROADMAP.md)
- [backlog-alignment-review.md](/docs/architecture/backlog-alignment-review.md)
