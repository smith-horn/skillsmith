# Swarm Coordination

AI swarm release orchestration with specialized agents.

---

## Initialize Release Swarm

```javascript
// Set up coordinated release team
[Single Message - Swarm Initialization]:
  mcp__claude-flow__swarm_init {
    topology: "hierarchical",
    maxAgents: 6,
    strategy: "balanced"
  }

  // Spawn specialized agents
  mcp__claude-flow__agent_spawn { type: "coordinator", name: "Release Director" }
  mcp__claude-flow__agent_spawn { type: "coder", name: "Version Manager" }
  mcp__claude-flow__agent_spawn { type: "tester", name: "QA Engineer" }
  mcp__claude-flow__agent_spawn { type: "reviewer", name: "Release Reviewer" }
  mcp__claude-flow__agent_spawn { type: "analyst", name: "Deployment Analyst" }
  mcp__claude-flow__agent_spawn { type: "researcher", name: "Compatibility Checker" }
```

---

## Coordinated Release Workflow

```javascript
[Single Message - Full Release Coordination]:
  // Create release branch
  Bash("gh api repos/:owner/:repo/git/refs --method POST -f ref='refs/heads/release/v2.0.0' -f sha=$(gh api repos/:owner/:repo/git/refs/heads/main --jq '.object.sha')")

  // Orchestrate release preparation
  mcp__claude-flow__task_orchestrate {
    task: "Prepare release v2.0.0 with comprehensive testing and validation",
    strategy: "sequential",
    priority: "critical",
    maxAgents: 6
  }

  // Update all release files
  Write("package.json", "[updated version]")
  Write("CHANGELOG.md", "[release changelog]")
  Write("RELEASE_NOTES.md", "[detailed notes]")

  // Run comprehensive validation
  Bash("npm install && npm test && npm run lint && npm run build")

  // Create release PR
  Bash(`gh pr create \
    --title "Release v2.0.0: Feature Set and Improvements" \
    --head "release/v2.0.0" \
    --base "main" \
    --body "$(cat RELEASE_NOTES.md)"`)

  // Track progress
  TodoWrite { todos: [
    { content: "Prepare release branch", status: "completed", priority: "critical" },
    { content: "Run validation suite", status: "completed", priority: "high" },
    { content: "Create release PR", status: "completed", priority: "high" },
    { content: "Code review approval", status: "pending", priority: "high" },
    { content: "Merge and deploy", status: "pending", priority: "critical" }
  ]}

  // Store release state
  mcp__claude-flow__memory_usage {
    action: "store",
    key: "release/v2.0.0/status",
    value: JSON.stringify({
      version: "2.0.0",
      stage: "validation_complete",
      timestamp: Date.now(),
      ready_for_review: true
    })
  }
```

---

## Specialized Agent Capabilities

### Changelog Agent

```bash
# Get merged PRs between versions
PRS=$(gh pr list --state merged --base main --json number,title,labels,author,mergedAt \
  --jq ".[] | select(.mergedAt > \"$(gh release view v1.0.0 --json publishedAt -q .publishedAt)\")")

# Get commit history
COMMITS=$(gh api repos/:owner/:repo/compare/v1.0.0...HEAD \
  --jq '.commits[].commit.message')

# Generate categorized changelog
npx claude-flow github changelog \
  --prs "$PRS" \
  --commits "$COMMITS" \
  --from v1.0.0 \
  --to HEAD \
  --categorize \
  --add-migration-guide
```

**Capabilities:**
- Semantic commit analysis
- Breaking change detection
- Contributor attribution
- Migration guide generation

### Version Agent

```bash
# Intelligent version suggestion
npx claude-flow github version-suggest \
  --current v1.2.3 \
  --analyze-commits \
  --check-compatibility \
  --suggest-pre-release
```

**Logic:**
- Analyzes commit messages and PR labels
- Detects breaking changes via keywords
- Suggests appropriate version bump
- Validates version constraints

### Build Agent

```bash
# Multi-platform build coordination
npx claude-flow github release-build \
  --platforms "linux,macos,windows" \
  --architectures "x64,arm64" \
  --parallel \
  --optimize-size
```

**Features:**
- Cross-platform compilation
- Parallel build execution
- Artifact optimization
- Build caching

### Test Agent

```bash
# Comprehensive pre-release testing
npx claude-flow github release-test \
  --suites "unit,integration,e2e,performance" \
  --environments "node:16,node:18,node:20" \
  --fail-fast false \
  --generate-report
```

### Deploy Agent

```bash
# Multi-target deployment orchestration
npx claude-flow github release-deploy \
  --targets "npm,docker,github,s3" \
  --staged-rollout \
  --monitor-metrics \
  --auto-rollback
```

---

## Topology Selection

| Topology | Use Case | Max Agents |
|----------|----------|------------|
| Hierarchical | Complex releases | 6-12 |
| Mesh | Cross-package coordination | 4-8 |
| Star | Centralized control | 3-6 |

---

## Memory Coordination

```javascript
// Store release state
mcp__claude-flow__memory_usage {
  action: "store",
  key: "release/v2.0.0/status",
  value: JSON.stringify({
    version: "2.0.0",
    stage: "in_progress",
    agents: ["changelog", "build", "test", "deploy"],
    progress: 50
  })
}

// Retrieve state in other agents
mcp__claude-flow__memory_usage {
  action: "retrieve",
  key: "release/v2.0.0/status"
}
```
