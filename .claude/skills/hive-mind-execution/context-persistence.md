# Context Persistence for Long-Running Tasks

Guidelines for maintaining context across sessions during complex, multi-day tasks.

---

## The Problem

Long-running tasks (spanning multiple context windows or sessions) often suffer from:

1. **Context loss** - Claude forgets prior decisions and progress
2. **Duplicate work** - Re-exploring already-understood code
3. **Inconsistent approach** - Different strategies across sessions
4. **Wasted time** - Re-establishing context at session start

**Real Example** (SMI-1736): Decomposing 11 skills across 4 sub-waves required multiple sessions. Without proper checkpointing, each session started with significant context re-establishment.

---

## Solution: The 3-Layer Persistence Strategy

### Layer 1: Task List (TodoWrite)

**The most important layer.** Use TodoWrite aggressively to track granular progress.

```javascript
// At task start - create ALL tasks upfront
TodoWrite([
  { id: "wave-3a-1", content: "Decompose skill-builder", status: "pending" },
  { id: "wave-3a-2", content: "Decompose worktree-manager", status: "pending" },
  { id: "wave-3a-3", content: "Decompose pair-programming", status: "pending" },
  { id: "wave-3b-1", content: "Decompose github-code-review", status: "pending" },
  // ... all tasks
  { id: "review", content: "Run code review", status: "pending" },
  { id: "document", content: "Create documentation", status: "pending" },
])

// As you work - update status IMMEDIATELY
TodoRead()  // Check current state
// ... complete task ...
TodoWrite([{ id: "wave-3a-1", status: "completed" }])
```

**Rules**:
- Create tasks at START, not as you go
- Update status IMMEDIATELY when done
- Include enough detail for another session to understand
- Check TodoRead() at session start to see where you left off

### Layer 2: Git Checkpoints

Commit frequently with descriptive messages. Each commit is a checkpoint.

```bash
# After each logical unit of work
git add .claude/skills/skill-builder/
git commit -m "refactor(skills): decompose skill-builder (SMI-1736)

- Split into 4 sub-files: specification.md, templates.md, best-practices.md, skill-locations.md
- SKILL.md reduced from 1123 to 189 lines
- Added behavioral classification section

Progress: 1/11 skills complete (Wave 3A: 1/3)"
```

**Key**: Include progress indicator in commit message (`Progress: X/Y complete`).

### Layer 3: Session Summaries

At session end, write a brief summary to `.claude/checkpoints/` or in the conversation.

```markdown
## Session Summary: SMI-1736 (2026-01-24 Session 2)

### Completed
- Sub-Wave 3A: skill-builder, worktree-manager, pair-programming
- Sub-Wave 3B: github-code-review, github-project-management

### In Progress
- Sub-Wave 3B: flow-nexus-platform (50% done)

### Next Steps
1. Complete flow-nexus-platform decomposition
2. Start Sub-Wave 3C (sparc-methodology, hooks-automation)
3. Run validation after 3C

### Decisions Made
- Using relative paths for sub-file links (not absolute)
- Behavioral classification added to all skills
- Commit after each skill (not after wave)

### Blockers
- Pre-commit TypeScript errors in billing files (bypass with --no-verify)
```

---

## Checkpoint Commands

### Creating Checkpoints

```bash
# Manual checkpoint (git tag)
git tag checkpoint-$(date +%Y%m%d-%H%M%S) -m "SMI-1736: After Wave 3A complete"

# Using checkpoint manager
.claude/helpers/checkpoint-manager.sh list      # List all checkpoints
.claude/helpers/checkpoint-manager.sh summary   # Show session summary
```

### Restoring Context

```bash
# View checkpoint details
.claude/helpers/checkpoint-manager.sh show checkpoint-20260124-150000

# See what changed since checkpoint
.claude/helpers/checkpoint-manager.sh diff checkpoint-20260124-150000

# Rollback if needed (creates backup first)
.claude/helpers/checkpoint-manager.sh rollback checkpoint-20260124-150000 --branch
```

---

## Session Continuation Pattern

When continuing a long-running task in a new session:

### Step 1: Read Task State

```javascript
// First action in new session
TodoRead()
```

This shows what's pending, in-progress, and completed.

### Step 2: Check Git State

```bash
git log --oneline -10  # Recent commits
git status             # Any uncommitted work
```

### Step 3: Read Session Summary (if exists)

```bash
cat .claude/checkpoints/summary-*.md | tail -50
```

### Step 4: Resume Work

```javascript
// Find first pending task
TodoWrite([{ id: "wave-3b-3", status: "in_progress" }])
// ... continue work
```

---

## Best Practices

### 1. Granular Tasks Over Coarse Tasks

```javascript
// ❌ BAD: Coarse tasks
TodoWrite([
  { content: "Complete Wave 3" },  // Too big, no progress visibility
])

// ✅ GOOD: Granular tasks
TodoWrite([
  { content: "Wave 3A: skill-builder" },
  { content: "Wave 3A: worktree-manager" },
  { content: "Wave 3A: pair-programming" },
  { content: "Wave 3B: github-code-review" },
  // ... each skill is a task
])
```

### 2. Commit After Each Logical Unit

```bash
# ❌ BAD: One commit for entire wave
git commit -m "Complete Wave 3"

# ✅ GOOD: One commit per skill
git commit -m "refactor(skills): decompose skill-builder (SMI-1736)"
git commit -m "refactor(skills): decompose worktree-manager (SMI-1736)"
```

### 3. Include Context in Task Descriptions

```javascript
// ❌ BAD: Minimal description
{ content: "Fix the bug" }

// ✅ GOOD: Actionable description
{ content: "Fix Stripe type errors in StripeClient.ts:514 - use createPreview() for v20+ API" }
```

### 4. Mark Decisions in Summaries

When you make a decision, document it:

```markdown
### Decisions Made
- **Path format**: Using relative paths (`./sub-file.md`) not absolute
- **Commit strategy**: One commit per skill for atomic rollback
- **PR strategy**: Single PR for all 11 skills
```

This prevents re-debating the same decisions in future sessions.

### 5. Use Linear for External Tracking

For multi-day work, update Linear with progress:

```bash
# Add comment to Linear issue
node ~/.claude/skills/linear/scripts/linear-api.mjs add-comment \
  --issue SMI-1736 \
  --body "Session 2 complete: 6/11 skills decomposed. Next: sparc-methodology"
```

---

## Quick Reference

| Situation | Action |
|-----------|--------|
| Starting long task | Create ALL tasks upfront with TodoWrite |
| Completing a task | Update status to "completed" IMMEDIATELY |
| End of session | Write summary, commit, push |
| Start of new session | TodoRead, check git log, read summary |
| Made a decision | Document in summary under "Decisions Made" |
| Hit a blocker | Document in summary under "Blockers" |
| Task taking multiple sessions | Add progress indicator to task description |

---

## Automated Session Hooks (Optional)

Configure Claude Code hooks to automate session management:

```json
// .claude/settings.json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-flow hook session-end --export-metrics --generate-summary"
          }
        ]
      }
    ]
  }
}
```

See [Session Hooks](../hooks-automation/session.md) for full configuration.

---

## Related Documentation

- [Checkpoint Manager](../../helpers/checkpoint-manager.sh) - Git checkpoint commands
- [Session Hooks](../hooks-automation/session.md) - Automated session management
- [Session Memory](../../commands/automation/session-memory.md) - MCP memory operations

---

**Created**: January 2026
**Issue**: SMI-1777
**Lesson Learned From**: SMI-1736 Retrospective
