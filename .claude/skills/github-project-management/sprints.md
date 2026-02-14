# Sprint Planning

Sprint management, milestones, and velocity tracking.

---

## Sprint Setup

### Create Sprint Milestone

```bash
# Create milestone for sprint
gh api repos/:owner/:repo/milestones \
  --method POST \
  -f title="Sprint 1 - Q1 2025" \
  -f description="Sprint goals: Feature X, Bug fixes Y" \
  -f due_on="2025-01-31T00:00:00Z"

# List milestones
gh api repos/:owner/:repo/milestones --jq '.[].title'
```

### Sprint Configuration

```json
{
  "sprint_config": {
    "duration_weeks": 2,
    "start_day": "Monday",
    "ceremonies": {
      "planning": "Day 1, 10:00 AM",
      "daily_standup": "Daily, 9:30 AM",
      "review": "Last Day, 2:00 PM",
      "retrospective": "Last Day, 3:30 PM"
    },
    "capacity": {
      "team_size": 5,
      "hours_per_person": 30,
      "total_story_points": 50
    }
  }
}
```

---

## Sprint Planning

### Capacity Planning

```bash
# Calculate team capacity
npx ruv-swarm github sprint-capacity \
  --team-size 5 \
  --sprint-length 2w \
  --focus-factor 0.8

# Output:
# Total Hours: 400
# Focus-Adjusted Hours: 320
# Recommended Story Points: 40-50
```

### Backlog Prioritization

```bash
# Prioritize backlog items
npx ruv-swarm github backlog-prioritize \
  --project-id "$PROJECT_ID" \
  --method "weighted-shortest-job-first" \
  --factors "business-value,risk,effort"
```

### Sprint Scope Definition

```bash
# Pull items into sprint
gh issue list --label "backlog" --limit 20 --json number,title,labels | \
  jq -r '.[].number' | head -10 | while read -r num; do
    gh issue edit $num --milestone "Sprint 1 - Q1 2025"
done

# Verify sprint scope
gh issue list --milestone "Sprint 1 - Q1 2025" --json number,title,state
```

---

## Sprint Execution

### Daily Progress Tracking

```bash
# Daily standup report
npx ruv-swarm github standup-report \
  --milestone "Sprint 1 - Q1 2025" \
  --format markdown

# Output:
# ## Daily Standup - 2025-01-15
#
# ### In Progress (3)
# - #123: Feature X implementation
# - #124: Bug fix for login
# - #125: API refactoring
#
# ### Blocked (1)
# - #126: Waiting for design review
#
# ### Completed Yesterday (2)
# - #127: Database migration
# - #128: Unit tests
```

### Swarm-Coordinated Execution

```javascript
// Initialize sprint execution swarm
mcp__claude-flow__swarm_init { topology: "hierarchical", maxAgents: 5 }
mcp__claude-flow__agent_spawn { type: "coordinator", name: "Sprint Coordinator" }
mcp__claude-flow__agent_spawn { type: "coder", name: "Developer 1" }
mcp__claude-flow__agent_spawn { type: "coder", name: "Developer 2" }
mcp__claude-flow__agent_spawn { type: "tester", name: "QA Engineer" }
mcp__claude-flow__agent_spawn { type: "reviewer", name: "Tech Lead" }

// Orchestrate sprint work
mcp__claude-flow__task_orchestrate {
  task: "Execute Sprint 1 items in priority order",
  strategy: "parallel",
  priority: "high"
}
```

---

## Velocity Tracking

### Calculate Velocity

```bash
# Historical velocity
npx ruv-swarm github velocity \
  --sprints 5 \
  --format json

# Output:
# {
#   "sprints": [
#     { "name": "Sprint 1", "completed_points": 42, "planned_points": 50 },
#     { "name": "Sprint 2", "completed_points": 48, "planned_points": 45 },
#     { "name": "Sprint 3", "completed_points": 45, "planned_points": 48 }
#   ],
#   "average_velocity": 45,
#   "trend": "stable"
# }
```

### Burndown Chart Data

```bash
# Generate burndown data
npx ruv-swarm github burndown \
  --milestone "Sprint 1 - Q1 2025" \
  --format csv > burndown.csv

# Output:
# date,remaining_points,ideal_points
# 2025-01-13,50,50
# 2025-01-14,48,45
# 2025-01-15,42,40
# ...
```

---

## Sprint Review

### Sprint Summary Report

```bash
# Generate sprint summary
npx ruv-swarm github sprint-summary \
  --milestone "Sprint 1 - Q1 2025" \
  --include "completed,carried-over,metrics"
```

### Velocity Analysis

```bash
# Analyze sprint performance
npx ruv-swarm github sprint-analysis \
  --milestone "Sprint 1 - Q1 2025" \
  --compare-to "last-3-sprints"
```

---

## Sprint Retrospective

### Generate Retrospective Data

```bash
# Pull retrospective metrics
npx ruv-swarm github retro-data \
  --milestone "Sprint 1 - Q1 2025" \
  --metrics "velocity,cycle-time,blockers,scope-changes"
```

### Action Item Tracking

```bash
# Create retro action items
gh issue create \
  --title "[Retro] Improve code review turnaround" \
  --body "Action item from Sprint 1 retrospective..." \
  --label "retro-action,process-improvement"
```

---

## Milestone Management

### Create Milestone

```bash
# Create milestone
gh api repos/:owner/:repo/milestones \
  --method POST \
  -f title="v2.0 Release" \
  -f description="Major release with new features" \
  -f due_on="2025-03-31T00:00:00Z"
```

### Milestone Progress

```bash
# Check milestone progress
gh api repos/:owner/:repo/milestones/1 | \
  jq '{title, open_issues, closed_issues, progress: (.closed_issues / (.open_issues + .closed_issues) * 100 | floor)}'
```

### Close Milestone

```bash
# Close completed milestone
gh api repos/:owner/:repo/milestones/1 \
  --method PATCH \
  -f state="closed"
```

---

## Sprint Automation

### GitHub Actions for Sprint

```yaml
# .github/workflows/sprint-automation.yml
name: Sprint Automation
on:
  schedule:
    - cron: '0 9 * * 1'  # Monday 9 AM - Sprint start
    - cron: '0 17 * * 5' # Friday 5 PM - Sprint end

jobs:
  sprint-start:
    if: github.event.schedule == '0 9 * * 1'
    runs-on: ubuntu-latest
    steps:
      - name: Generate Sprint Report
        run: |
          npx ruv-swarm github sprint-kickoff \
            --milestone "current" \
            --notify-team

  sprint-end:
    if: github.event.schedule == '0 17 * * 5'
    runs-on: ubuntu-latest
    steps:
      - name: Generate Sprint Summary
        run: |
          npx ruv-swarm github sprint-summary \
            --milestone "current" \
            --archive-done-items
```
