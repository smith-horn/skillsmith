# Advanced Workflows

Multi-package releases, staged rollouts, and emergency hotfix procedures.

---

## Multi-Package Release Coordination

### Monorepo Release Strategy

```javascript
[Single Message - Multi-Package Release]:
  // Initialize mesh topology for cross-package coordination
  mcp__claude-flow__swarm_init { topology: "mesh", maxAgents: 8 }

  // Spawn package-specific agents
  Task("Package A Manager", "Coordinate claude-flow package release v1.0.72", "coder")
  Task("Package B Manager", "Coordinate ruv-swarm package release v1.0.12", "coder")
  Task("Integration Tester", "Validate cross-package compatibility", "tester")
  Task("Version Coordinator", "Align dependencies and versions", "coordinator")

  // Update all packages simultaneously
  Write("packages/claude-flow/package.json", "[v1.0.72 content]")
  Write("packages/ruv-swarm/package.json", "[v1.0.12 content]")
  Write("CHANGELOG.md", "[consolidated changelog]")

  // Run cross-package validation
  Bash("cd packages/claude-flow && npm install && npm test")
  Bash("cd packages/ruv-swarm && npm install && npm test")
  Bash("npm run test:integration")

  // Create unified release PR
  Bash(`gh pr create \
    --title "Release: claude-flow v1.0.72, ruv-swarm v1.0.12" \
    --body "Multi-package coordinated release with cross-compatibility validation"`)
```

---

## Progressive Deployment Strategy

### Staged Rollout Configuration

```yaml
# .github/release-deployment.yml
deployment:
  strategy: progressive
  stages:
    - name: canary
      percentage: 5
      duration: 1h
      metrics:
        - error-rate < 0.1%
        - latency-p99 < 200ms
      auto-advance: true

    - name: partial
      percentage: 25
      duration: 4h
      validation: automated-tests
      approval: qa-team

    - name: rollout
      percentage: 50
      duration: 8h
      monitor: true

    - name: full
      percentage: 100
      approval: release-manager
      rollback-enabled: true
```

### Execute Staged Deployment

```bash
npx claude-flow github release-deploy \
  --version v2.0.0 \
  --strategy progressive \
  --config .github/release-deployment.yml \
  --monitor-metrics \
  --auto-rollback-on-error
```

---

## Multi-Repository Coordination

### Coordinated Multi-Repo Release

```bash
npx claude-flow github multi-release \
  --repos "frontend:v2.0.0,backend:v2.1.0,cli:v1.5.0" \
  --ensure-compatibility \
  --atomic-release \
  --synchronized \
  --rollback-all-on-failure
```

### Cross-Repo Dependency Management

```javascript
[Single Message - Cross-Repo Release]:
  // Initialize star topology for centralized coordination
  mcp__claude-flow__swarm_init { topology: "star", maxAgents: 6 }

  // Spawn repo-specific coordinators
  Task("Frontend Release", "Release frontend v2.0.0 with API compatibility", "coordinator")
  Task("Backend Release", "Release backend v2.1.0 with breaking changes", "coordinator")
  Task("CLI Release", "Release CLI v1.5.0 with new commands", "coordinator")
  Task("Compatibility Checker", "Validate cross-repo compatibility", "researcher")

  // Coordinate version updates across repos
  Bash("gh api repos/org/frontend/dispatches --method POST -f event_type='release' -F client_payload[version]=v2.0.0")
  Bash("gh api repos/org/backend/dispatches --method POST -f event_type='release' -F client_payload[version]=v2.1.0")
  Bash("gh api repos/org/cli/dispatches --method POST -f event_type='release' -F client_payload[version]=v1.5.0")

  // Monitor all releases
  mcp__claude-flow__swarm_monitor { interval: 5, duration: 300 }
```

---

## Hotfix Emergency Procedures

### Emergency Hotfix Workflow

```bash
# Fast-track critical bug fix
npx claude-flow github emergency-release \
  --issue 789 \
  --severity critical \
  --target-version v1.2.4 \
  --cherry-pick-commits \
  --bypass-checks security-only \
  --fast-track \
  --notify-all
```

### Automated Hotfix Process

```javascript
[Single Message - Emergency Hotfix]:
  // Create hotfix branch from last stable release
  Bash("git checkout -b hotfix/v1.2.4 v1.2.3")

  // Cherry-pick critical fixes
  Bash("git cherry-pick abc123def")

  // Fast validation
  Bash("npm run test:critical && npm run build")

  // Create emergency release
  Bash(`gh release create v1.2.4 \
    --title "HOTFIX v1.2.4: Critical Security Patch" \
    --notes "Emergency release addressing CVE-2024-XXXX" \
    --prerelease=false`)

  // Immediate deployment
  Bash("npm publish --tag hotfix")

  // Notify stakeholders
  Bash(`gh issue create \
    --title "🚨 HOTFIX v1.2.4 Deployed" \
    --body "Critical security patch deployed. Please update immediately." \
    --label "critical,security,hotfix"`)
```

---

## Rollback Procedures

### Immediate Rollback

```bash
npx claude-flow github rollback \
  --to-version v1.9.9 \
  --reason "Critical bug in v2.0.0" \
  --preserve-data \
  --notify-users
```

### Automated Rollback Configuration

```bash
npx claude-flow github rollback-config \
  --triggers '{
    "error-rate": ">5%",
    "latency-p99": ">1000ms",
    "availability": "<99.9%",
    "failed-health-checks": ">3"
  }' \
  --grace-period 5m \
  --notify-on-rollback \
  --preserve-metrics
```

---

## Version Conflict Resolution

```bash
# Check and resolve version conflicts
npx claude-flow github release-validate \
  --checks version-conflicts \
  --auto-resolve

# Align multi-package versions
npx claude-flow github version-sync \
  --packages "package-a,package-b" \
  --strategy semantic
```
