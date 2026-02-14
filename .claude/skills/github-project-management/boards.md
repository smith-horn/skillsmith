# Project Boards

Automated project board management and synchronization.

---

## Board Setup

### Initialize Project Board

```bash
# Get project ID
PROJECT_ID=$(gh project list --owner @me --format json | \
  jq -r '.projects[0].id')

# Initialize board sync
npx ruv-swarm github board-init \
  --project-id "$PROJECT_ID" \
  --sync-mode "bidirectional"
```

### Create New Project

```bash
# Create project with gh CLI
gh project create --owner @me --title "Sprint Q1 2025"

# List existing projects
gh project list --owner @me

# View project details
gh project view PROJECT_ID
```

---

## Column Management

### Standard Columns

```json
{
  "columns": [
    {
      "name": "Backlog",
      "description": "Items not yet scheduled",
      "swarm_status": "pending"
    },
    {
      "name": "To Do",
      "description": "Scheduled for current sprint",
      "swarm_status": "ready"
    },
    {
      "name": "In Progress",
      "description": "Currently being worked on",
      "swarm_status": "active"
    },
    {
      "name": "Review",
      "description": "In code review or testing",
      "swarm_status": "review"
    },
    {
      "name": "Done",
      "description": "Completed and verified",
      "swarm_status": "complete"
    }
  ]
}
```

### Kanban Automation

```yaml
# .github/project-automation.yml
automation:
  - trigger: "issue.opened"
    action: "add_to_column"
    column: "Backlog"

  - trigger: "issue.labeled:in-progress"
    action: "move_to_column"
    column: "In Progress"

  - trigger: "pull_request.opened"
    action: "move_to_column"
    column: "Review"

  - trigger: "issue.closed"
    action: "move_to_column"
    column: "Done"
```

---

## Board Synchronization

### Bidirectional Sync

```bash
# Full board sync
npx ruv-swarm github board-sync \
  --project-id "$PROJECT_ID" \
  --direction both \
  --conflict-resolution "latest"

# Sync specific columns
npx ruv-swarm github board-sync \
  --project-id "$PROJECT_ID" \
  --columns "To Do,In Progress,Done"
```

### Real-Time Sync via Webhooks

```javascript
// webhook-handler.js
const express = require('express');
const app = express();

app.post('/github-webhook', async (req, res) => {
  const event = req.body;

  if (event.action === 'labeled' && event.issue) {
    const label = event.label.name;
    const issueNumber = event.issue.number;

    // Map labels to columns
    const columnMap = {
      'in-progress': 'In Progress',
      'review': 'Review',
      'done': 'Done'
    };

    if (columnMap[label]) {
      await moveToColumn(issueNumber, columnMap[label]);
    }
  }

  res.status(200).send('OK');
});
```

---

## Board Views

### View Configuration

```json
{
  "views": [
    {
      "name": "Sprint Overview",
      "type": "board",
      "filter": "milestone:current",
      "group_by": "status",
      "sort": "priority"
    },
    {
      "name": "By Assignee",
      "type": "table",
      "filter": "is:open",
      "group_by": "assignee",
      "columns": ["title", "status", "priority", "estimate"]
    },
    {
      "name": "Epic Roadmap",
      "type": "roadmap",
      "filter": "label:epic",
      "date_field": "target_date"
    }
  ]
}
```

### Custom Fields

```bash
# Add custom field to project
gh project field-create PROJECT_ID \
  --name "Priority" \
  --data-type "SINGLE_SELECT" \
  --single-select-options "P0,P1,P2,P3"

gh project field-create PROJECT_ID \
  --name "Story Points" \
  --data-type "NUMBER"

gh project field-create PROJECT_ID \
  --name "Due Date" \
  --data-type "DATE"
```

---

## Board Analytics

### Progress Tracking

```bash
# Get board statistics
npx ruv-swarm github board-stats \
  --project-id "$PROJECT_ID" \
  --metrics "items-by-column,velocity,cycle-time"
```

### Burndown Charts

```bash
# Generate burndown data
npx ruv-swarm github burndown \
  --project-id "$PROJECT_ID" \
  --sprint "current" \
  --format "csv"
```

---

## GitHub Actions Integration

### Auto-Add to Board

```yaml
# .github/workflows/project-sync.yml
name: Project Board Sync
on:
  issues:
    types: [opened, labeled, closed]
  pull_request:
    types: [opened, ready_for_review, closed]

jobs:
  sync-board:
    runs-on: ubuntu-latest
    steps:
      - name: Add to Project
        run: |
          gh project item-add $PROJECT_ID --url ${{ github.event.issue.html_url }}

      - name: Update Status
        if: github.event.action == 'labeled'
        run: |
          # Update project item status based on label
          ITEM_ID=$(gh project item-list $PROJECT_ID --format json | \
            jq -r '.items[] | select(.content.url == "${{ github.event.issue.html_url }}") | .id')
          gh project item-edit --id $ITEM_ID --field-id STATUS_FIELD_ID --value "In Progress"
```

### Stale Item Cleanup

```yaml
# .github/workflows/stale-cleanup.yml
name: Stale Board Cleanup
on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Archive Stale Items
        run: |
          # Find items in Done for > 30 days
          npx ruv-swarm github board-cleanup \
            --project-id "$PROJECT_ID" \
            --column "Done" \
            --older-than "30d" \
            --action "archive"
```

---

## Multi-Board Coordination

### Cross-Project Sync

```bash
# Sync items between projects
npx ruv-swarm github project-sync \
  --source-project "$PROJECT_A" \
  --target-project "$PROJECT_B" \
  --filter "label:shared"
```

### Portfolio View

```bash
# Generate portfolio dashboard
npx ruv-swarm github portfolio \
  --projects "$PROJECT_A,$PROJECT_B,$PROJECT_C" \
  --metrics "velocity,health,risk"
```
