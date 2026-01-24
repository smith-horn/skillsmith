# Best Practices

Workflow organization, security, and performance optimization.

---

## Workflow Organization

### 1. Use Reusable Workflows

```yaml
# .github/workflows/reusable-swarm.yml
name: Reusable Swarm Workflow
on:
  workflow_call:
    inputs:
      topology:
        required: true
        type: string

jobs:
  swarm-task:
    runs-on: ubuntu-latest
    steps:
      - name: Initialize Swarm
        run: |
          npx ruv-swarm init --topology ${{ inputs.topology }}
```

### 2. Implement Proper Caching

```yaml
- name: Cache Swarm Dependencies
  uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-swarm-${{ hashFiles('**/package-lock.json') }}
```

### 3. Set Appropriate Timeouts

```yaml
jobs:
  swarm-task:
    timeout-minutes: 30
    steps:
      - name: Swarm Operation
        timeout-minutes: 10
```

### 4. Use Workflow Dependencies

```yaml
jobs:
  setup:
    runs-on: ubuntu-latest

  test:
    needs: setup
    runs-on: ubuntu-latest

  deploy:
    needs: [setup, test]
    runs-on: ubuntu-latest
```

---

## Security Best Practices

### 1. Store Configurations Securely

```yaml
- name: Setup Swarm
  env:
    SWARM_CONFIG: ${{ secrets.SWARM_CONFIG }}
    API_KEY: ${{ secrets.API_KEY }}
  run: |
    npx ruv-swarm init --config "$SWARM_CONFIG"
```

### 2. Use OIDC Authentication

```yaml
permissions:
  id-token: write
  contents: read

- name: Configure AWS Credentials
  uses: aws-actions/configure-aws-credentials@v2
  with:
    role-to-assume: arn:aws:iam::123456789012:role/GitHubAction
    aws-region: us-east-1
```

### 3. Implement Least-Privilege

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
```

### 4. Audit Swarm Operations

```yaml
- name: Audit Swarm Actions
  run: |
    npx ruv-swarm actions audit \
      --export-logs \
      --compliance-report
```

---

## Performance Optimization

### 1. Cache Dependencies

```yaml
- uses: actions/cache@v3
  with:
    path: |
      ~/.npm
      node_modules
    key: ${{ runner.os }}-swarm-${{ hashFiles('**/package-lock.json') }}
```

### 2. Use Appropriate Runner Sizes

```yaml
jobs:
  heavy-task:
    runs-on: ubuntu-latest-4-cores
    steps:
      - name: Intensive Swarm Operation
```

### 3. Implement Early Termination

```yaml
- name: Quick Fail Check
  run: |
    if ! npx ruv-swarm actions pre-check; then
      echo "Pre-check failed, terminating early"
      exit 1
    fi
```

### 4. Optimize Parallel Execution

```yaml
strategy:
  matrix:
    include:
      - runner: ubuntu-latest
        task: test
      - runner: ubuntu-latest
        task: lint
      - runner: ubuntu-latest
        task: security
  max-parallel: 3
```

---

## Checklist

### Organization
- [ ] Reusable workflows for common patterns
- [ ] Proper caching configured
- [ ] Timeouts set appropriately
- [ ] Dependencies declared between jobs

### Security
- [ ] Secrets stored in GitHub Secrets
- [ ] OIDC for cloud authentication
- [ ] Least-privilege permissions
- [ ] Audit logging enabled

### Performance
- [ ] Dependencies cached
- [ ] Appropriate runner sizes
- [ ] Early termination on failures
- [ ] Parallel execution optimized
