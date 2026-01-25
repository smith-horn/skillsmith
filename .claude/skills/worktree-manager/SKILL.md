---
name: "Worktree Manager"
version: 1.2.0
description: "Manage git worktrees for parallel development with conflict prevention and wave-aware execution strategy. Use when creating feature branches, starting parallel work sessions, merging worktree PRs, or coordinating multiple Claude sessions. Includes dependency analysis for choosing single vs. multiple worktree patterns."
category: development
tags:
  - git
  - worktree
  - parallel-development
  - branching
  - workflow
author: Smith Horn
triggers:
  keywords:
    - create worktree
    - parallel development
    - worktree strategy
    - single worktree
    - multiple worktrees
  explicit:
    - /worktree
composes:
  - wave-planner
  - hive-mind
  - linear
---

# Worktree Manager

> **Attribution**: This skill is inspired by [@obra's using-git-worktrees skill](https://github.com/obra/superpowers/blob/main/skills/using-git-worktrees/SKILL.md) from the Superpowers repository and the [git worktree pattern](https://github.com/anthropics/claude-code/issues/1052) documented in claude-code issues.

## Behavioral Classification

**Type**: Guided Decision

This skill guides you through worktree strategy selection based on your project's dependency patterns.

**Decision Points**:
1. Are your waves/tasks sequentially dependent or independent?
2. Single worktree (sequential) or multiple worktrees (parallel)?
3. Does your repo use git-crypt for encrypted files?

After decisions are made, worktree creation proceeds automatically.

---

## What This Skill Does

Creates and manages isolated git worktrees for parallel feature development while **preventing merge conflicts** in shared files like `packages/core/src/index.ts`.

**Key Features**:
1. Smart worktree creation with pre-configured export stubs
2. Rebase-first workflow to prevent conflict cascades
3. Shared file registry for conflict detection
4. Coordination protocol for multi-session development
5. **Wave-aware strategy selection** for agentic execution

---

## Prerequisites

- Git 2.20+ (for worktree support)
- This repository cloned locally
- Understanding of the monorepo structure
- Git-crypt installed and key available (if repo uses encrypted files)
- Varlock configured for secret management (optional but recommended)

---

## Quick Start

### Creating a New Worktree

**For repositories with git-crypt encryption (recommended):**

```bash
# Use the helper script for encrypted repos
cd /path/to/your/repo
./scripts/worktree-crypt.sh create ../worktrees/feature-name feature/feature-name

# Navigate to worktree
cd ../worktrees/feature-name

# Verify encrypted files are readable
head -3 docs/architecture/standards.md
```

**Manual approach (if helper script not available):**

```bash
# 1. Ensure you're on main and up-to-date
cd /path/to/your/repo
git checkout main && git pull origin main

# 2. If repo uses git-crypt, unlock BEFORE creating worktree
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'

# 3. Create worktree directory (if not exists)
mkdir -p ../worktrees

# 4. Create worktree for your feature
git worktree add ../worktrees/feature-name -b feature/feature-name

# 5. Navigate to worktree
cd ../worktrees/feature-name

# 6. Verify encrypted files are readable (if applicable)
head -3 docs/architecture/standards.md
```

**If encrypted files still show as binary after creation:**

```bash
# Fix the worktree's git-crypt setup
cd /path/to/your/repo
./scripts/worktree-crypt.sh fix ../worktrees/feature-name
```

### Before Starting Work

**CRITICAL**: Check the shared files registry before modifying:

```bash
# Files that commonly cause merge conflicts:
cat << 'EOF'
SHARED FILES - Coordinate before modifying:
- packages/core/src/index.ts (exports)
- packages/core/package.json (dependencies)
- packages/mcp-server/src/index.ts (server exports)
- package.json (root dependencies)
- tsconfig.json (compiler options)
EOF
```

---

## Sub-Documentation

For detailed information, see the following files:

| Document | Contents |
|----------|----------|
| [Strategies](./strategies.md) | Single vs. multiple worktree patterns, decision framework |
| [Conflict Prevention](./conflict-prevention.md) | Staggered exports, conflict resolution, merge workflow |
| [Git-Crypt Integration](./git-crypt.md) | Encrypted files handling, worktree unlock process |
| [Troubleshooting](./troubleshooting.md) | Common issues and solutions |

---

## Quick Reference

### Strategy Selection

| Pattern | When to Use | PR Strategy |
|---------|-------------|-------------|
| **Single Worktree** | Sequential waves, shared state | Single PR for all waves |
| **Multiple Worktrees** | Independent waves, parallel work | One PR per wave |
| **Worktree per Chain** | Mixed dependencies | One PR per dependency chain |

### Resource Considerations

| Environment | Recommended Strategy | Max Parallel Agents |
|-------------|---------------------|---------------------|
| MacBook (laptop profile) | Single worktree | 2-3 |
| Workstation | 1-2 worktrees | 4-6 |
| Server/CI | Multiple worktrees | 8+ |

### Common Commands

```bash
# List all worktrees
git worktree list

# Sync worktree with main
git fetch origin main && git rebase origin/main

# Remove worktree after merge
git worktree remove ../worktrees/feature-name

# Prune stale references
git worktree prune
```

### Session Coordination

```bash
# Start of session - always rebase first
git fetch origin main
git rebase origin/main

# End of session - commit and push
git add -A && git status
git push origin $(git branch --show-current)
```

---

## Scripts

The skill includes helper scripts in `scripts/`:

| Script | Purpose |
|--------|---------|
| `create-worktree.sh` | Create a new worktree with git-crypt support (4-step process) |
| `worktree-crypt.sh` | Git-crypt helper: create, fix, and status commands |
| `worktree-status.sh` | Show status of all worktrees |
| `worktree-sync.sh` | Sync all worktrees with main |
| `worktree-cleanup.sh` | Clean up merged worktrees |
| `generate-launch-script.sh` | Generate Claude Code launch script |

### Git-Crypt Helper Usage

```bash
# Create a new worktree with git-crypt support
./scripts/worktree-crypt.sh create ../worktrees/my-feature feature/my-feature

# Fix an existing worktree with encrypted file issues
./scripts/worktree-crypt.sh fix ../worktrees/my-feature

# Check encryption status
./scripts/worktree-crypt.sh status ../worktrees/my-feature
```

---

## Related Resources

- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
- [obra/superpowers](https://github.com/obra/superpowers) - Original inspiration
- [Claude Code Worktree Pattern](https://github.com/anthropics/claude-code/issues/1052)

---

## Changelog

### v1.2.0 (2026-01-25)
- **New**: Enhanced git-crypt worktree documentation (SMI-1824)
- Documented 4-step worktree creation process for encrypted repos
- Added `worktree-crypt.sh` helper script with `create`, `fix`, and `status` commands
- Expanded troubleshooting for encrypted file issues
- Key insight: worktree gitdir needs git-crypt keys copied separately

### v1.1.0 (2026-01-22)
- **New**: Wave-aware worktree strategy selection
- Added decision framework for single vs. multiple worktrees
- Integration points with wave-planner skill

### v1.0.0 (2025-12)
- Initial release
- Smart worktree creation with export stubs
- Rebase-first workflow
- Git-crypt integration

---

**Created**: December 2025
**Updated**: January 25, 2026
**Scope**: Internal - Smith-Horn/skillsmith repository
**Related**: [wave-planner](~/.claude/skills/wave-planner/SKILL.md), [hive-mind](../hive-mind/SKILL.md)
