# GitHub Integration Modes

8 specialized swarm-powered modes for different GitHub workflows.

---

## 1. gh-coordinator

**GitHub workflow orchestration and coordination**

| Setting | Value |
|---------|-------|
| Coordination Mode | Hierarchical |
| Max Parallel Operations | 10 |
| Batch Optimized | Yes |
| Best For | Complex workflows, multi-repo coordination |

```bash
npx claude-flow@alpha github gh-coordinator \
  "Coordinate multi-repo release across 5 repositories"
```

---

## 2. pr-manager

**Pull request management and review coordination**

| Setting | Value |
|---------|-------|
| Review Mode | Automated |
| Multi-reviewer | Yes |
| Conflict Resolution | Intelligent |

```bash
# Create PR with automated review
gh pr create --title "Feature: New capability" \
  --body "Automated PR with swarm review" | \
  npx ruv-swarm actions pr-validate \
    --spawn-agents "linter,tester,security,docs"
```

---

## 3. issue-tracker

**Issue management and project coordination**

| Setting | Value |
|---------|-------|
| Issue Workflow | Automated |
| Label Management | Smart |
| Progress Tracking | Real-time |

```bash
npx claude-flow@alpha github issue-tracker \
  "Manage sprint issues with automated tracking"
```

---

## 4. release-manager

**Release coordination and deployment**

| Setting | Value |
|---------|-------|
| Release Pipeline | Automated |
| Versioning | Semantic |
| Deployment | Multi-stage |

```bash
npx claude-flow@alpha github release-manager \
  "Create v2.0.0 release with changelog and deployment"
```

---

## 5. repo-architect

**Repository structure and organization**

| Setting | Value |
|---------|-------|
| Structure Optimization | Yes |
| Multi-repo Support | Yes |
| Template Management | Advanced |

```bash
npx claude-flow@alpha github repo-architect \
  "Restructure monorepo with optimal organization"
```

---

## 6. code-reviewer

**Automated code review and quality assurance**

| Setting | Value |
|---------|-------|
| Review Quality | Deep |
| Security Analysis | Yes |
| Performance Check | Automated |

```bash
gh pr view 123 --json files | \
  npx ruv-swarm actions pr-validate \
    --deep-review \
    --security-scan
```

---

## 7. ci-orchestrator

**CI/CD pipeline coordination**

| Setting | Value |
|---------|-------|
| Pipeline Management | Advanced |
| Test Coordination | Parallel |
| Deployment | Automated |

```bash
npx claude-flow@alpha github ci-orchestrator \
  "Setup parallel test execution with smart caching"
```

---

## 8. security-guardian

**Security and compliance management**

| Setting | Value |
|---------|-------|
| Security Scan | Automated |
| Compliance Check | Continuous |
| Vulnerability Management | Proactive |

```bash
npx ruv-swarm actions security \
  --deep-scan \
  --compliance-check \
  --create-issues
```

---

## Mode Selection Guide

| Scenario | Recommended Mode |
|----------|------------------|
| Managing PRs across teams | `pr-manager` |
| Coordinating releases | `release-manager` |
| Sprint planning | `issue-tracker` |
| Multi-repo updates | `gh-coordinator` |
| Restructuring projects | `repo-architect` |
| Code quality gates | `code-reviewer` |
| Build pipeline optimization | `ci-orchestrator` |
| Security audits | `security-guardian` |
