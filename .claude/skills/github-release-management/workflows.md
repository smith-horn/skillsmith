# GitHub Actions Integration

CI/CD workflows, best practices, and troubleshooting.

---

## Complete Release Workflow

```yaml
# .github/workflows/release.yml
name: Intelligent Release Workflow
on:
  push:
    tags: ['v*']

jobs:
  release-orchestration:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
      issues: write

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'

      - name: Authenticate GitHub CLI
        run: echo "${{ secrets.GITHUB_TOKEN }}" | gh auth login --with-token

      - name: Initialize Release Swarm
        run: |
          RELEASE_TAG=${{ github.ref_name }}
          PREV_TAG=$(gh release list --limit 2 --json tagName -q '.[1].tagName')

          PRS=$(gh pr list --state merged --base main --json number,title,labels,author,mergedAt \
            --jq ".[] | select(.mergedAt > \"$(gh release view $PREV_TAG --json publishedAt -q .publishedAt)\")")

          npx claude-flow@alpha swarm init --topology hierarchical
          echo "$PRS" > /tmp/release-prs.json

      - name: Build Release Artifacts
        run: |
          npm ci
          npm run lint
          npm run typecheck
          npm run test:all
          npm run build

      - name: Security Scan
        run: |
          npm audit --audit-level=moderate
          npx claude-flow@alpha github release-security \
            --scan-dependencies \
            --check-secrets

      - name: Create GitHub Release
        run: |
          gh release edit ${{ github.ref_name }} \
            --notes "$(cat RELEASE_CHANGELOG.md)" \
            --draft=false

          for file in dist/*; do
            gh release upload ${{ github.ref_name }} "$file"
          done

      - name: Deploy to Package Registries
        run: |
          echo "//registry.npmjs.org/:_authToken=${{ secrets.NPM_TOKEN }}" > .npmrc
          npm publish

      - name: Post-Release Validation
        run: |
          npm run test:smoke
          npx claude-flow@alpha github release-validate \
            --version ${{ github.ref_name }} \
            --smoke-tests \
            --health-checks

      - name: Create Release Announcement
        run: |
          gh issue create \
            --title "🎉 Released ${{ github.ref_name }}" \
            --body "$(cat RELEASE_CHANGELOG.md)" \
            --label "announcement,release"
```

---

## Hotfix Workflow

```yaml
# .github/workflows/hotfix.yml
name: Emergency Hotfix Workflow
on:
  issues:
    types: [labeled]

jobs:
  emergency-hotfix:
    if: contains(github.event.issue.labels.*.name, 'critical-hotfix')
    runs-on: ubuntu-latest

    steps:
      - name: Create Hotfix Branch
        run: |
          LAST_STABLE=$(gh release list --limit 1 --json tagName -q '.[0].tagName')
          HOTFIX_VERSION=$(echo $LAST_STABLE | awk -F. '{print $1"."$2"."$3+1}')
          git checkout -b hotfix/$HOTFIX_VERSION $LAST_STABLE

      - name: Fast-Track Testing
        run: |
          npm ci
          npm run test:critical
          npm run build

      - name: Emergency Release
        run: |
          npx claude-flow@alpha github emergency-release \
            --issue ${{ github.event.issue.number }} \
            --severity critical \
            --fast-track \
            --notify-all
```

---

## Best Practices

### Release Planning Guidelines

1. **Regular Release Cadence**
   - Weekly: Patch releases with bug fixes
   - Bi-weekly: Minor releases with features
   - Quarterly: Major releases with breaking changes
   - On-demand: Hotfixes for critical issues

2. **Feature Freeze Strategy**
   - Code freeze 3 days before release
   - Only critical bug fixes allowed
   - Beta testing period for major releases
   - Stakeholder communication plan

3. **Version Management Rules**
   - Strict semantic versioning compliance
   - Breaking changes only in major versions
   - Deprecation warnings one minor version ahead

### Automation Recommendations

1. **CI/CD Pipeline**
   - Automated testing at every stage
   - Security scanning before release
   - Performance benchmarking
   - Documentation generation

2. **Progressive Deployment**
   - Canary releases for early detection
   - Staged rollouts with monitoring
   - Automated health checks
   - Quick rollback mechanisms

3. **Monitoring & Observability**
   - Real-time error tracking
   - Performance metrics collection
   - User adoption analytics

---

## Troubleshooting

### Failed Release Build

```bash
# Debug build failures
npx claude-flow@alpha diagnostic-run \
  --component build \
  --verbose

# Retry with isolated environment
docker run --rm -v $(pwd):/app node:20 \
  bash -c "cd /app && npm ci && npm run build"
```

### Test Failures in CI

```bash
# Run tests with detailed output
npm run test -- --verbose --coverage

# Compare local vs CI environment
npx claude-flow@alpha github compat-test \
  --environments "local,ci" \
  --compare
```

### Deployment Rollback Needed

```bash
# Immediate rollback
npx claude-flow@alpha github rollback \
  --to-version v1.9.9 \
  --reason "Critical bug in v2.0.0" \
  --preserve-data \
  --notify-users

# Investigate cause
npx claude-flow@alpha github release-analytics \
  --version v2.0.0 \
  --identify-issues
```

### Version Conflicts

```bash
# Check and resolve conflicts
npx claude-flow@alpha github release-validate \
  --checks version-conflicts \
  --auto-resolve
```

---

## Optimization Tips

1. **Parallel Execution**: Use swarm coordination for concurrent tasks
2. **Caching**: Enable build and dependency caching
3. **Incremental Builds**: Only rebuild changed components
4. **Test Optimization**: Run critical tests first, full suite in parallel
