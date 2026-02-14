# Issue Management

Comprehensive issue creation, triage, and swarm integration.

---

## Issue Creation

### Single Issue with Swarm Coordination

```javascript
// Initialize issue management swarm
mcp__claude-flow__swarm_init { topology: "star", maxAgents: 3 }
mcp__claude-flow__agent_spawn { type: "coordinator", name: "Issue Coordinator" }
mcp__claude-flow__agent_spawn { type: "researcher", name: "Requirements Analyst" }
mcp__claude-flow__agent_spawn { type: "coder", name: "Implementation Planner" }

// Create comprehensive issue
mcp__github__create_issue {
  owner: "org",
  repo: "repository",
  title: "Integration Review: Complete system integration",
  body: `## Overview
  Comprehensive review and integration between components.

  ### Objectives
  - [ ] Verify dependencies and imports
  - [ ] Ensure API integration
  - [ ] Check hook system integration
  - [ ] Validate data systems alignment

  ### Swarm Coordination
  This issue will be managed by coordinated swarm agents.`,
  labels: ["integration", "review", "enhancement"],
  assignees: ["username"]
}

// Set up automated tracking
mcp__claude-flow__task_orchestrate {
  task: "Monitor and coordinate issue progress with automated updates",
  strategy: "adaptive",
  priority: "medium"
}
```

### Batch Issue Creation

```bash
# Create multiple related issues using gh CLI
gh issue create \
  --title "Feature: Advanced GitHub Integration" \
  --body "Implement comprehensive GitHub workflow automation..." \
  --label "feature,github,high-priority"

gh issue create \
  --title "Bug: Merge conflicts in integration branch" \
  --body "Resolve merge conflicts..." \
  --label "bug,integration,urgent"

gh issue create \
  --title "Documentation: Update integration guides" \
  --body "Update all documentation..." \
  --label "documentation,integration"
```

---

## Issue-to-Swarm Conversion

### Transform Issues into Swarm Tasks

```bash
# Get issue details
ISSUE_DATA=$(gh issue view 456 --json title,body,labels,assignees,comments)

# Create swarm from issue
npx ruv-swarm github issue-to-swarm 456 \
  --issue-data "$ISSUE_DATA" \
  --auto-decompose \
  --assign-agents

# Batch process multiple issues
ISSUES=$(gh issue list --label "swarm-ready" --json number,title,body,labels)
npx ruv-swarm github issues-batch \
  --issues "$ISSUES" \
  --parallel

# Update issues with swarm status
echo "$ISSUES" | jq -r '.[].number' | while read -r num; do
  gh issue edit $num --add-label "swarm-processing"
done
```

### Issue Comment Commands

Execute swarm operations via issue comments:

```markdown
<!-- In issue comment -->
/swarm analyze
/swarm decompose 5
/swarm assign @agent-coder
/swarm estimate
/swarm start
```

---

## Automated Issue Triage

### Auto-Label Based on Content

```json
// .github/swarm-labels.json
{
  "rules": [
    {
      "keywords": ["bug", "error", "broken"],
      "labels": ["bug", "swarm-debugger"],
      "agents": ["debugger", "tester"]
    },
    {
      "keywords": ["feature", "implement", "add"],
      "labels": ["enhancement", "swarm-feature"],
      "agents": ["architect", "coder", "tester"]
    },
    {
      "keywords": ["security", "vulnerability", "auth"],
      "labels": ["security", "priority-high"],
      "agents": ["security", "reviewer"]
    },
    {
      "keywords": ["performance", "slow", "optimize"],
      "labels": ["performance", "swarm-analyzer"],
      "agents": ["analyst", "optimizer"]
    },
    {
      "keywords": ["docs", "documentation", "readme"],
      "labels": ["documentation"],
      "agents": ["researcher", "writer"]
    }
  ]
}
```

### Priority Assignment

```javascript
// .github/priority-rules.json
{
  "priority_rules": [
    {
      "conditions": {
        "labels_any": ["critical", "security", "production-down"],
        "age_hours_max": 24
      },
      "priority": "P0",
      "swarm_config": {
        "topology": "star",
        "max_agents": 5,
        "auto_start": true
      }
    },
    {
      "conditions": {
        "labels_any": ["bug", "regression"],
        "milestone": "current"
      },
      "priority": "P1",
      "swarm_config": {
        "topology": "mesh",
        "max_agents": 3
      }
    },
    {
      "conditions": {
        "labels_any": ["enhancement", "feature"],
        "milestone": "next"
      },
      "priority": "P2",
      "swarm_config": {
        "topology": "ring",
        "max_agents": 2
      }
    }
  ]
}
```

---

## Issue Templates

### Feature Request Template

```markdown
---
name: Feature Request
about: Suggest a new feature
labels: enhancement, needs-triage
---

## Feature Description
[Clear description of the feature]

## Use Case
[Why is this feature needed?]

## Proposed Solution
[How should this be implemented?]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Swarm Configuration
- **Suggested Agents**: architect, coder, tester
- **Estimated Complexity**: [low/medium/high]
- **Priority**: [P0/P1/P2/P3]
```

### Bug Report Template

```markdown
---
name: Bug Report
about: Report a bug
labels: bug, needs-triage
---

## Bug Description
[What happened?]

## Expected Behavior
[What should happen?]

## Steps to Reproduce
1. Step 1
2. Step 2
3. Step 3

## Environment
- OS: [e.g., macOS 14.0]
- Version: [e.g., 1.2.3]
- Browser: [if applicable]

## Additional Context
[Screenshots, logs, etc.]

## Swarm Configuration
- **Suggested Agents**: debugger, tester
- **Priority**: [P0/P1/P2/P3]
```

---

## Issue Linking

### Link Issues to PRs

```bash
# Create PR linked to issue
gh pr create \
  --title "Fix: Resolve #123" \
  --body "Closes #123\n\nImplementation details..." \
  --head feature/fix-123

# Add issue reference to existing PR
gh pr edit 456 --body "$(gh pr view 456 --json body -q .body)\n\nRelates to #123"
```

### Cross-Repository Links

```bash
# Link issues across repositories
gh issue comment 123 --body "Related: owner/other-repo#456"

# Create dependent issue in another repo
gh issue create \
  --repo owner/other-repo \
  --title "Dependent: Implementation for owner/main-repo#123" \
  --body "This issue depends on owner/main-repo#123"
```

---

## Issue Metrics

### Track Issue Statistics

```bash
# Count issues by label
gh issue list --label "bug" --state all --json number | jq 'length'

# Issues opened in last 7 days
gh issue list --state all --json createdAt,number | \
  jq '[.[] | select(.createdAt > (now - 604800 | todate))] | length'

# Average time to close
gh issue list --state closed --json createdAt,closedAt --limit 100 | \
  jq '[.[] | (.closedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)] | add / length / 3600 | floor'
```
