# Worktree Strategies

Guide for selecting the right worktree strategy based on dependency patterns.

---

## Decision Framework

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WORKTREE STRATEGY SELECTOR                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Analyze your waves:                                                        │
│                                                                             │
│  Wave 1 ──► Wave 2 ──► Wave 3     SEQUENTIAL DEPENDENCIES                  │
│  (output feeds next wave)         → Use: SINGLE WORKTREE                   │
│                                   → Reason: Waves must run in order        │
│                                   → PR Strategy: Single PR for all waves   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Wave 1                           INDEPENDENT WAVES                         │
│  Wave 2   (no dependencies)       → Use: MULTIPLE WORKTREES (optional)     │
│  Wave 3                           → Reason: Can run in parallel            │
│                                   → PR Strategy: One PR per wave           │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Wave 1 ──► Wave 2                HYBRID (mixed dependencies)              │
│  Wave 3 ──► Wave 4                → Use: WORKTREE PER DEPENDENCY CHAIN     │
│  (two parallel chains)            → Reason: Chains are independent         │
│                                   → PR Strategy: One PR per chain          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Strategy Comparison

| Strategy | When to Use | Pros | Cons |
|----------|-------------|------|------|
| **Single Worktree** | Sequential waves, shared state, resource-constrained | Simple coordination, single PR, no merge conflicts | No parallelism |
| **Multiple Worktrees** | Independent waves, ample resources | True parallelism, isolated contexts | Merge coordination, multiple PRs |
| **Worktree per Chain** | Mixed dependencies, complex projects | Balanced parallelism, logical grouping | Medium complexity |

---

## Detecting Dependency Patterns

Before creating worktrees, analyze your issues for dependencies:

```bash
# Check if issues have parent-child relationships
npx tsx ~/.claude/skills/linear/scripts/linear-ops.ts list-sub-issues SMI-XXX

# Check for blocking relationships in issue descriptions
# Look for: "depends on", "blocked by", "requires", "after"
```

**Common dependency indicators:**
- Database migrations must run before code that uses new schema
- API changes must complete before frontend updates
- Shared utilities must be implemented before features using them
- Tests often depend on implementation being complete

---

## Single Worktree Pattern (Sequential Waves)

Use when waves have dependencies or feed into each other.

**Example: Database Migration Project**
```
Wave 1: Add new category (schema change)
   ↓
Wave 2: Expand categorization rules (uses new category)
   ↓
Wave 3: Run migration and validate (depends on rules)
```

**Setup:**
```bash
# Create ONE worktree for the entire project
git worktree add ../worktrees/category-expansion -b feature/category-expansion

cd ../worktrees/category-expansion

# Execute waves sequentially in the same worktree
./claude-flow swarm --config .claude/hive-mind/category-wave-1.yaml
# Wait for completion...
./claude-flow swarm --config .claude/hive-mind/category-wave-2.yaml
# Wait for completion...
./claude-flow swarm --config .claude/hive-mind/category-wave-3.yaml

# Single PR for all waves
gh pr create --title "feat: Category system expansion (SMI-1675)"
```

**Launch Script Template (Single Worktree, All Waves):**
```bash
#!/bin/bash
# scripts/start-project-worktree.sh
set -e

PROJECT_NAME="category-expansion"
BRANCH_NAME="feature/$PROJECT_NAME"
WORKTREE_PATH="../worktrees/$PROJECT_NAME"
WAVES=(1 2 3)  # Define your waves

# Setup worktree (standard setup - see Quick Start)
# ...

# Create wave execution context
cat > "$WORKTREE_PATH/.claude-context.md" << 'CONTEXT'
# Project: Category System Expansion

## Execution Strategy
Single worktree, sequential waves (dependencies between waves)

## Waves
- Wave 1: SMI-1676 - Add Integrations category
- Wave 2: SMI-1677, SMI-1678 - Expand rules
- Wave 3: SMI-1679, SMI-1680 - Migration and validation

## Dependency Chain
Wave 1 → Wave 2 → Wave 3 (each depends on previous)

## Commands
```bash
# Execute each wave in sequence
./claude-flow swarm --config .claude/hive-mind/category-wave-1.yaml
./claude-flow swarm --config .claude/hive-mind/category-wave-2.yaml
./claude-flow swarm --config .claude/hive-mind/category-wave-3.yaml
```

## Completion
- [ ] All waves executed
- [ ] Tests passing
- [ ] Single PR created and merged
CONTEXT

echo "Worktree ready: $WORKTREE_PATH"
echo "Execute waves sequentially - see .claude-context.md"
```

---

## Multiple Worktrees Pattern (Independent Waves)

Use when waves are completely independent and can run in parallel.

**Example: Feature Bundle (no dependencies)**
```
Wave 1: Dark mode UI (frontend only)
Wave 2: API rate limiting (backend only)
Wave 3: Documentation refresh (docs only)
```

**Setup:**
```bash
# Create separate worktrees for each wave
git worktree add ../worktrees/dark-mode -b feature/dark-mode
git worktree add ../worktrees/rate-limiting -b feature/rate-limiting
git worktree add ../worktrees/docs-refresh -b feature/docs-refresh

# Run in parallel (separate terminal sessions)
# Terminal 1:
cd ../worktrees/dark-mode && ./claude-flow swarm --config ...

# Terminal 2:
cd ../worktrees/rate-limiting && ./claude-flow swarm --config ...

# Terminal 3:
cd ../worktrees/docs-refresh && ./claude-flow swarm --config ...

# Merge PRs in any order (no conflicts expected)
```

**Coordination for Multiple Worktrees:**

Before creating multiple worktrees, use the **staggered exports strategy** (see [Conflict Prevention](./conflict-prevention.md)) to prevent merge conflicts in shared files.

---

## Resource Considerations

| Environment | Recommended Strategy | Max Parallel Agents |
|-------------|---------------------|---------------------|
| MacBook (laptop profile) | Single worktree | 2-3 |
| Workstation | 1-2 worktrees | 4-6 |
| Server/CI | Multiple worktrees | 8+ |

**Memory Rule of Thumb:**
- Each Claude agent: ~300-500MB RAM
- Each worktree with Docker: ~200MB additional
- Safe limit: (Available RAM - 4GB) / 500MB = max parallel agents

---

## Integration with Wave-Planner

When using the wave-planner skill, it will analyze dependencies and recommend a strategy:

```
/wave-planner "Category System Expansion"

Claude: Analyzing 5 issues for dependencies...

Found SEQUENTIAL dependency pattern:
  SMI-1676 (schema) → SMI-1677/1678 (rules) → SMI-1679 (migration) → SMI-1680 (validate)

Recommended: Single worktree for all waves

Options:
A) Single worktree (recommended for this dependency pattern)
B) Multiple worktrees (not recommended - would cause conflicts)
C) Execute in current directory (no worktree isolation)
```

---

## Hive Config with Worktree Context

When wave-planner generates hive configs, they can include worktree execution context:

```yaml
# .claude/hive-mind/category-wave-1.yaml
name: "Category Expansion Wave 1"

execution:
  strategy: single-worktree
  worktree: ../worktrees/category-expansion
  branch: feature/category-expansion

  # Sequential wave indicator
  wave: 1
  total_waves: 3
  depends_on: null  # First wave

  # PR strategy
  merge_strategy: single-pr  # All waves → one PR
  pr_title: "feat: Category system expansion (SMI-1675)"

agents:
  - type: coder
    issues: [SMI-1676]
```

---

## Worktree Directory Structure

```
/path/to/your/repos/
├── skillsmith/                    # Main repository
│   ├── .git/                      # Git directory (shared)
│   ├── packages/
│   └── ...
└── worktrees/                     # Worktree container (gitignored)
    ├── phase-2c-session/          # Feature worktree
    │   ├── packages/
    │   └── ...
    ├── phase-2c-perf/             # Feature worktree
    └── phase-2c-webhooks/         # Feature worktree
```

**Important**: The `worktrees/` directory should be:
- Outside the main repo directory
- Added to global gitignore (`~/.gitignore_global`)
