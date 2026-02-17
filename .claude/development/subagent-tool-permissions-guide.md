# Subagent Tool Permissions Guide

> **Navigation**: [CLAUDE.md](../../CLAUDE.md) > Subagent Tool Permissions Guide

A shared reference for skill authors and orchestrators on how Claude Code subagent tool permissions work.

---

## How Tool Permissions Work

Per [Anthropic's official docs](https://code.claude.com/docs/en/sub-agents), subagent tool access depends on the **subagent type** and **execution mode**.

### Built-in Subagent Types

| Type | Tools | Purpose |
|---|---|---|
| `general-purpose` | **All tools** | Complex research, code modifications, multi-step operations |
| `Explore` | Read-only (no Write/Edit) | File discovery, codebase exploration |
| `Plan` | Read-only (no Write/Edit) | Codebase research for planning |
| `Bash` | Inherits from parent | Terminal commands in separate context |

### Foreground vs Background Execution

| Mode | Tool Availability | User Interaction |
|---|---|---|
| **Foreground** | Permission prompts pass through to user | Full interaction (AskUserQuestion works) |
| **Background** | Auto-denies unapproved tools | No interaction (AskUserQuestion fails) |

**Background subagents** are the most common source of "subagents can't write" experiences. Before launching a background subagent, Claude Code asks the user to pre-approve tools. Anything not pre-approved is silently denied.

### Permission Modes

| Mode | Behavior |
|---|---|
| `default` | Standard permission checking with prompts |
| `acceptEdits` | Auto-accept file edits (Bash still prompts) |
| `dontAsk` | Auto-deny all prompts (only pre-allowed tools work) |
| `bypassPermissions` | Skip all checks (cannot be overridden by subagent) |
| `plan` | Read-only exploration |

---

## Default Tool Sets by Agent Type

When spawning subagents via `Task()`, always specify `allowed_tools` explicitly for background agents.

| Agent Type | Tools | Use Case |
|---|---|---|
| `coder` | `["Read", "Edit", "Write", "Bash", "Grep", "Glob"]` | Implementation, bug fixes |
| `tester` | `["Read", "Bash", "Grep", "Glob"]` | Running tests, validation |
| `reviewer` | `["Read", "Grep", "Glob"]` | Code review, analysis |
| `researcher` | `["Read", "WebFetch", "WebSearch", "Grep", "Glob"]` | Documentation, exploration |
| `architect` | `["Read", "Write", "Grep", "Glob"]` | Design docs, ADRs |
| `planner` | `["Read", "Grep", "Glob", "TodoRead", "TodoWrite"]` | Task decomposition |

Source: `.claude/skills/hive-mind-execution/SKILL.md` (SMI-1823).

---

## Thin Dispatcher Pattern

The thin dispatcher pattern (SKILL.md dispatches to agent-prompt.md via a `general-purpose` Task subagent) is used by several Skillsmith skills.

### When to Use

- Skill logic exceeds ~50 lines (post-compaction restoration cost)
- Skill needs isolated context window
- Skill performs multi-step workflows with intermediate state

### Required Documentation

Every skill using the thin dispatcher pattern **must** include an "Execution Context Requirements" section in SKILL.md:

```markdown
## Execution Context Requirements

This skill spawns a general-purpose subagent that performs [describe operations].

**Foreground execution required**: [Yes/No]
**Required tools**: [list tools]
**Fallback**: [what happens when tools are denied]
**Reference**: https://code.claude.com/docs/en/sub-agents
```

### Resilient Pattern (Recommended)

Design subagents to **return data** rather than write files directly:

1. Subagent performs analysis/generation
2. Subagent returns results as structured text output
3. Coordinator (main conversation) applies edits via its own tools

This pattern works in all permission modes because the coordinator always has tool access.

### Fragile Pattern (Requires Foreground)

Subagent writes files directly via Write/Edit:

1. Subagent performs analysis/generation
2. Subagent writes results to disk
3. Works in foreground + permissive modes
4. **Fails silently** in background or restrictive modes

If you must use this pattern, document the foreground requirement clearly.

---

## Skill Author Checklist

Before publishing a skill that uses Task subagents:

- [ ] Does the subagent need Write/Edit/Bash tools?
- [ ] If yes, is foreground execution documented as required?
- [ ] Is there a fallback for when tools are denied?
- [ ] Are `allowed_tools` specified in any `Task()` examples?
- [ ] Does the skill pass `skillsmith validate` without warnings?

---

## References

- [Anthropic: Create custom subagents](https://code.claude.com/docs/en/sub-agents) (official docs)
- [Research: Subagent Tool Permissions](../research/subagent-tool-permissions.md) (Skillsmith analysis)
- [GitHub #4740: Sub-agents use tools without permission](https://github.com/anthropics/claude-code/issues/4740)
- [GitHub #4801: Need better way to restrict subagent tool use](https://github.com/anthropics/claude-code/issues/4801)

---

*Created: February 16, 2026*
