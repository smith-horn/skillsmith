# Linear Skill: Parallel Agent Upgrade

**Repository**: `~/.claude/skills/linear/` (or dedicated repo)
**Type**: Enhancement
**Priority**: High
**Labels**: `enhancement`, `agent`, `performance`

---

## Summary

Upgrade the Linear skill to operate as a parallel subagent, enabling Linear operations to run in the background while the main conversation continues. This leverages Skillsmith's subagent generation tooling.

---

## Background

### Current State (v1.7.0)

The Linear skill currently operates synchronously within the main conversation context:

```bash
# Current usage - blocks main conversation
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done SMI-1089
```

**v1.7.0 Features**:
- Label Taxonomy System (25 labels across 3 categories)
- Agent Selection/Routing (`agent-selection.ts`) - determines WHICH agent handles issues
- CLI commands: `labels taxonomy`, `labels validate`, `labels suggest`, `labels agents`

The agent-selection module routes issues to appropriate agents based on domain labels, but the Linear operations themselves still run in the main context.

### Proposed State

Linear operations run in a dedicated parallel agent:

```javascript
// New usage - runs in background, main conversation continues
Task({
  description: "Update Linear issues",
  prompt: "Mark SMI-1089, SMI-1090 as done and create project update",
  subagent_type: "linear-agent"
})
```

---

## Skillsmith Subagent Generation

Skillsmith provides tooling to upgrade skills to operate with companion subagents.

### Commands Available

| Command | Description |
|---------|-------------|
| `skillsmith author subagent <skill-path>` | Generate companion subagent definition |
| `skillsmith author transform <skill-path>` | Upgrade existing skill with subagent |

### Options

```bash
skillsmith author subagent ~/.claude/skills/linear/skills/linear \
  --output ~/.claude/agents \
  --tools "Read,Write,Bash,WebFetch" \
  --model haiku \
  --force
```

| Option | Purpose |
|--------|---------|
| `--output, -o <dir>` | Output directory (default: ~/.claude/agents) |
| `--tools <list>` | Override detected tools (comma-separated) |
| `--model <model>` | Specify model (sonnet, opus, haiku) |
| `--skip-claude-md` | Skip CLAUDE.md delegation snippet |
| `--force` | Overwrite existing subagent definition |

### Tool Detection

The subagent generator automatically analyzes skill content to determine minimal required tools:

- **Read** - File reading operations
- **Write** - File creation
- **Edit** - File modifications
- **Bash** - Command execution (for `npx tsx` scripts)
- **Grep/Glob** - File searching
- **WebFetch** - API calls (Linear GraphQL API)
- **WebSearch** - Web searches

For the Linear skill, expected detected tools:
- `Bash` - Running `linear-ops.ts` scripts
- `WebFetch` - Linear GraphQL API calls
- `Read` - Reading configuration files
- `Write` - Writing cache/state files

---

## Implementation Plan

### Phase 1: Generate Subagent Definition

Run Skillsmith's subagent generator:

```bash
cd ~/.claude/skills/linear/skills/linear

# Generate subagent definition
skillsmith author subagent . \
  --output ~/.claude/agents \
  --model haiku
```

This creates a subagent definition file at `~/.claude/agents/linear-agent.json` (or similar).

### Phase 2: Subagent Definition Structure

Expected output structure:

```json
{
  "name": "linear-agent",
  "description": "Manages Linear issues, projects, and workflows in parallel",
  "tools": ["Read", "Write", "Bash", "WebFetch"],
  "model": "haiku",
  "systemPrompt": "You are a Linear workflow specialist...",
  "skillPath": "~/.claude/skills/linear/skills/linear/SKILL.md"
}
```

### Phase 3: CLAUDE.md Delegation Snippet

Add delegation instructions to project CLAUDE.md files:

```markdown
### Linear Operations (Parallel Agent)

For Linear operations that don't need immediate results, delegate to the linear-agent:

\`\`\`javascript
Task({
  description: "Linear issue updates",
  prompt: "Mark issues SMI-1089, SMI-1090 as done",
  subagent_type: "linear-agent"
})
\`\`\`

Use parallel agent for:
- Batch issue status updates
- Creating project updates
- Label management
- Issue creation with templates

Use direct execution for:
- Quick single-issue queries (`linear-ops.ts whoami`)
- Real-time status checks needed for decision-making
\`\`\`
```

### Phase 4: Update Skill SKILL.md

Add parallel agent usage section to the Linear skill documentation:

```markdown
## Parallel Agent Mode

The Linear skill can operate as a parallel subagent for background operations.

### When to Use Parallel Mode

| Scenario | Mode | Reason |
|----------|------|--------|
| Batch status updates | Parallel | No immediate result needed |
| Project updates | Parallel | Background task |
| Single issue query | Direct | Need result for decisions |
| Issue creation | Either | Depends on workflow |

### Spawning the Agent

\`\`\`javascript
Task({
  description: "Update Linear issues",
  prompt: `Execute these Linear operations:
    1. Mark SMI-1089, SMI-1090, SMI-1091 as Done
    2. Create project update summarizing completed work
    3. Add "deployed" label to all three issues`,
  subagent_type: "linear-agent",
  run_in_background: true  // Optional: for true background execution
})
\`\`\`
```

### Phase 5: Integration with Agent Selection

Connect the existing `agent-selection.ts` routing with parallel agent spawning:

```typescript
// In hive-mind or orchestration code
import { selectAgentsForIssue } from './agent-selection'

function handleIssue(issue: LinearIssue) {
  const selection = selectAgentsForIssue(issue.labels)

  // Spawn primary agent in parallel
  Task({
    description: `Handle ${issue.identifier}`,
    prompt: `Work on issue: ${issue.title}\n\nLabels: ${issue.labels.join(', ')}`,
    subagent_type: selection.primary[0] // e.g., 'security-manager', 'coder'
  })

  // Update Linear status in parallel
  Task({
    description: "Update Linear status",
    prompt: `Mark ${issue.identifier} as in_progress`,
    subagent_type: "linear-agent"
  })
}
```

---

## Benefits

### Performance

| Metric | Current | With Parallel Agent |
|--------|---------|---------------------|
| Context usage | High (blocks main) | Low (separate context) |
| Concurrent operations | 1 | Multiple |
| User wait time | Blocking | Non-blocking |

### Workflow Integration

- **Hive Mind Execution**: Linear updates happen in parallel with code work
- **Sprint Reports**: Generate reports without blocking development agents
- **Batch Operations**: Update dozens of issues without context overhead

### Model Efficiency

Using `haiku` model for routine Linear operations:
- Faster execution for simple CRUD operations
- Lower cost for high-volume issue management
- Reserve `sonnet`/`opus` for complex reasoning tasks

---

## Testing Plan

### Unit Tests

```typescript
// Test subagent spawning
it('spawns linear-agent for batch updates', async () => {
  const result = await Task({
    description: "Test Linear agent",
    prompt: "Mark SMI-TEST-001 as done",
    subagent_type: "linear-agent"
  })
  expect(result.status).toBe('completed')
})
```

### Integration Tests

1. **Parallel execution**: Spawn linear-agent while main agent continues
2. **State consistency**: Verify Linear state after parallel updates
3. **Error handling**: Test agent failure recovery
4. **Concurrent access**: Multiple linear-agents updating same project

### Manual Verification

```bash
# 1. Generate subagent
skillsmith author subagent ~/.claude/skills/linear/skills/linear

# 2. Test spawning in Claude Code
# Ask Claude: "Use the linear-agent to mark SMI-1234 as done"

# 3. Verify operation completed
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts get SMI-1234
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `SKILL.md` | Add "Parallel Agent Mode" section |
| `README.md` | Document subagent usage |
| `scripts/generate-subagent.ts` | (NEW) Script to generate subagent definition |
| `.claude/agents/linear-agent.json` | (NEW) Subagent definition |
| `agent-selection.ts` | Add integration with parallel spawning |

---

## Dependencies

- **Skillsmith CLI** (`@skillsmith/cli`) - For `author subagent` command
- **Claude Code Task tool** - For spawning parallel agents
- **Linear API** - Existing dependency

---

## Acceptance Criteria

- [ ] Subagent definition generated via `skillsmith author subagent`
- [ ] Linear operations can run in parallel agent
- [ ] SKILL.md documents parallel mode usage
- [ ] Integration with existing agent-selection routing
- [ ] Tests verify parallel execution
- [ ] Performance improvement measured (context usage reduction)

---

## References

- [Skillsmith Subagent Pair Generation Architecture](https://github.com/skillsmith/skillsmith/blob/main/docs/architecture/subagent-pair-generation-architecture.md)
- [Linear Skill v1.7.0 Changelog](~/.claude/skills/linear/CHANGELOG.md)
- [Agent Selection Module](~/.claude/skills/linear/skills/linear/scripts/lib/agent-selection.ts)
- [Hive Mind Execution Skill](.claude/skills/hive-mind-execution/SKILL.md)

---

## Notes

The v1.7.0 agent-selection feature determines WHICH agent should handle an issue based on labels. This enhancement enables those selected agents (and Linear itself) to run in PARALLEL, reducing context overhead and enabling concurrent workflows.

**Key distinction**:
- **Agent Selection** (v1.7.0): Routes issues to appropriate agent TYPES
- **Parallel Agent** (this ticket): Enables agents to run CONCURRENTLY in background

---

*Generated from Skillsmith session analysis - January 18, 2026*
