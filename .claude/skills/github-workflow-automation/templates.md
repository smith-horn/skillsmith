# Workflow Templates

Production-ready GitHub Actions templates for common automation scenarios.

---

## 1. Intelligent CI with Swarms

```yaml
# .github/workflows/swarm-ci.yml
name: Intelligent CI with Swarms
on: [push, pull_request]

jobs:
  swarm-analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Initialize Swarm
        uses: ruvnet/swarm-action@v1
        with:
          topology: mesh
          max-agents: 6

      - name: Analyze Changes
        run: |
          npx ruv-swarm actions analyze \
            --commit ${{ github.sha }} \
            --suggest-tests \
            --optimize-pipeline
```

---

## 2. Multi-Language Detection

```yaml
# .github/workflows/polyglot-swarm.yml
name: Polyglot Project Handler
on: push

jobs:
  detect-and-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Detect Languages
        id: detect
        run: |
          npx ruv-swarm actions detect-stack \
            --output json > stack.json

      - name: Dynamic Build Matrix
        run: |
          npx ruv-swarm actions create-matrix \
            --from stack.json \
            --parallel-builds
```

---

## 3. Adaptive Security Scanning

```yaml
# .github/workflows/security-swarm.yml
name: Intelligent Security Scan
on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:

jobs:
  security-swarm:
    runs-on: ubuntu-latest
    steps:
      - name: Security Analysis Swarm
        run: |
          SECURITY_ISSUES=$(npx ruv-swarm actions security \
            --deep-scan \
            --format json)

          echo "$SECURITY_ISSUES" | jq -r '.issues[]? | @base64' | while read -r issue; do
            _jq() {
              echo ${issue} | base64 --decode | jq -r ${1}
            }
            gh issue create \
              --title "$(_jq '.title')" \
              --body "$(_jq '.body')" \
              --label "security,critical"
          done
```

---

## 4. Self-Healing Pipeline

```yaml
# .github/workflows/self-healing.yml
name: Self-Healing Pipeline
on: workflow_run

jobs:
  heal-pipeline:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - name: Diagnose and Fix
        run: |
          npx ruv-swarm actions self-heal \
            --run-id ${{ github.event.workflow_run.id }} \
            --auto-fix-common \
            --create-pr-complex
```

---

## 5. Progressive Deployment

```yaml
# .github/workflows/smart-deployment.yml
name: Smart Deployment
on:
  push:
    branches: [main]

jobs:
  progressive-deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Analyze Risk
        id: risk
        run: |
          npx ruv-swarm actions deploy-risk \
            --changes ${{ github.sha }} \
            --history 30d

      - name: Choose Strategy
        run: |
          npx ruv-swarm actions deploy-strategy \
            --risk ${{ steps.risk.outputs.level }} \
            --auto-execute
```

---

## 6. Performance Regression Detection

```yaml
# .github/workflows/performance-guard.yml
name: Performance Guard
on: pull_request

jobs:
  perf-swarm:
    runs-on: ubuntu-latest
    steps:
      - name: Performance Analysis
        run: |
          npx ruv-swarm actions perf-test \
            --baseline main \
            --threshold 10% \
            --auto-profile-regression
```

---

## 7. PR Validation Swarm

```yaml
# .github/workflows/pr-validation.yml
name: PR Validation Swarm
on: pull_request

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Multi-Agent Validation
        run: |
          PR_DATA=$(gh pr view ${{ github.event.pull_request.number }} --json files,labels)

          RESULTS=$(npx ruv-swarm actions pr-validate \
            --spawn-agents "linter,tester,security,docs" \
            --parallel \
            --pr-data "$PR_DATA")

          gh pr comment ${{ github.event.pull_request.number }} \
            --body "$RESULTS"
```

---

## 8. Intelligent Release

```yaml
# .github/workflows/intelligent-release.yml
name: Intelligent Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Release Swarm
        run: |
          npx ruv-swarm actions release \
            --analyze-changes \
            --generate-notes \
            --create-artifacts \
            --publish-smart
```

---

## Template Selection Guide

| Scenario | Template |
|----------|----------|
| General CI pipeline | Intelligent CI with Swarms |
| Polyglot projects | Multi-Language Detection |
| Daily security audits | Adaptive Security Scanning |
| Flaky test recovery | Self-Healing Pipeline |
| Production deployments | Progressive Deployment |
| Performance monitoring | Performance Regression Detection |
| PR quality gates | PR Validation Swarm |
| Version releases | Intelligent Release |
