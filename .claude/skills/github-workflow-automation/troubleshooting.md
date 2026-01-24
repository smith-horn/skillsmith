# Troubleshooting

Debugging tools, real-world examples, and command reference.

---

## Debug Tools

### Debug Mode

```yaml
- name: Debug Swarm
  run: |
    npx ruv-swarm actions debug \
      --verbose \
      --trace-agents \
      --export-logs
  env:
    ACTIONS_STEP_DEBUG: true
```

### Performance Profiling

```bash
npx ruv-swarm actions profile \
  --workflow "ci.yml" \
  --identify-slow-steps \
  --suggest-optimizations
```

### Failure Analysis

```bash
gh run view <run-id> --json jobs,conclusion | \
  npx ruv-swarm actions analyze-failure \
    --suggest-fixes \
    --auto-retry-flaky
```

### Log Analysis

```bash
gh run download <run-id>
npx ruv-swarm actions analyze-logs \
  --directory ./logs \
  --identify-errors
```

---

## Real-World Examples

### Full-Stack Application CI/CD

```yaml
name: Full-Stack CI/CD with Swarms
on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  initialize:
    runs-on: ubuntu-latest
    outputs:
      swarm-id: ${{ steps.init.outputs.swarm-id }}
    steps:
      - id: init
        run: |
          SWARM_ID=$(npx ruv-swarm init --topology mesh --output json | jq -r '.id')
          echo "swarm-id=${SWARM_ID}" >> $GITHUB_OUTPUT

  backend:
    needs: initialize
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Backend Tests
        run: |
          npx ruv-swarm agents spawn --type tester \
            --task "Run backend test suite" \
            --swarm-id ${{ needs.initialize.outputs.swarm-id }}

  frontend:
    needs: initialize
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Frontend Tests
        run: |
          npx ruv-swarm agents spawn --type tester \
            --task "Run frontend test suite" \
            --swarm-id ${{ needs.initialize.outputs.swarm-id }}

  security:
    needs: initialize
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Security Scan
        run: |
          npx ruv-swarm agents spawn --type security \
            --task "Security audit" \
            --swarm-id ${{ needs.initialize.outputs.swarm-id }}

  deploy:
    needs: [backend, frontend, security]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: |
          npx ruv-swarm actions deploy \
            --strategy progressive \
            --swarm-id ${{ needs.initialize.outputs.swarm-id }}
```

### Monorepo Management

```yaml
name: Monorepo Coordination
on: push

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      packages: ${{ steps.detect.outputs.packages }}
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - id: detect
        run: |
          PACKAGES=$(npx ruv-swarm actions detect-changes \
            --monorepo \
            --output json)
          echo "packages=${PACKAGES}" >> $GITHUB_OUTPUT

  build-packages:
    needs: detect-changes
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package: ${{ fromJson(needs.detect-changes.outputs.packages) }}
    steps:
      - name: Build Package
        run: |
          npx ruv-swarm actions build \
            --package ${{ matrix.package }} \
            --parallel-deps
```

### Multi-Repo Synchronization

```bash
npx claude-flow@alpha github sync-coordinator \
  "Synchronize version updates across:
   - github.com/org/repo-a
   - github.com/org/repo-b
   - github.com/org/repo-c

   Update dependencies, align versions, create PRs"
```

---

## Command Reference

### Workflow Generation

```bash
npx ruv-swarm actions generate-workflow [options]
  --analyze-codebase       Analyze repository structure
  --detect-languages       Detect programming languages
  --create-optimal-pipeline Generate optimized workflow
```

### Optimization

```bash
npx ruv-swarm actions optimize [options]
  --workflow <path>        Path to workflow file
  --suggest-parallelization Suggest parallel execution
  --reduce-redundancy      Remove redundant steps
  --estimate-savings       Estimate time/cost savings
```

### Analysis

```bash
npx ruv-swarm actions analyze [options]
  --commit <sha>           Analyze specific commit
  --suggest-tests          Suggest test improvements
  --optimize-pipeline      Optimize pipeline structure
```

### Testing

```bash
npx ruv-swarm actions smart-test [options]
  --changed-files <files>  Files that changed
  --impact-analysis        Analyze test impact
  --parallel-safe          Only parallel-safe tests
```

### Security

```bash
npx ruv-swarm actions security [options]
  --deep-scan             Deep security analysis
  --format <format>       Output format (json/text)
  --create-issues         Auto-create GitHub issues
```

### Deployment

```bash
npx ruv-swarm actions deploy [options]
  --strategy <type>       Deployment strategy
  --risk <level>          Risk assessment level
  --auto-execute          Execute automatically
```

### Monitoring

```bash
npx ruv-swarm actions analytics [options]
  --workflow <name>       Workflow to analyze
  --period <duration>     Analysis period
  --identify-bottlenecks  Find bottlenecks
  --suggest-improvements  Improvement suggestions
```

---

## Common Issues

| Issue | Solution |
|-------|----------|
| Workflow timeout | Increase `timeout-minutes` or optimize steps |
| Permission denied | Check `permissions` block in workflow |
| Cache miss | Verify cache key includes lockfile hash |
| Flaky tests | Use `--auto-retry-flaky` flag |
| High costs | Run `cost-optimize` analysis |
